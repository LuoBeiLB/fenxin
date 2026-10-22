import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { BurnSetting } from '../../entities/burn-setting.entity';
import { AppUser } from '../../entities/app-user.entity';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { BURN_TTL_MAX_SECONDS, BURN_TTL_MIN_SECONDS } from './dto';
import {
  BurnSettingListItem,
  BurnSettingList,
  BurnSettingResolution,
  BurnSettingWriteResult,
  BurnTtlSource,
} from './dto/response';

/**
 * 焚毁时长设置（V6.1「按人设置」）。
 *
 * ## 归属规则：**看谁发的消息**（发送方生效）
 * 焚毁时长是"发送方给接收方"的单向设置，作用在**发送方发出的消息**上：
 *   - A 给 B 设 5 秒  → 只约束 A→B 的消息（B 点开后 5 秒焚毁）
 *   - B 给 A 设 1 小时 → 只约束 B→A 的消息（A 点开后 1 小时焚毁）
 * 两个方向互不干扰，因此**不存在"取较短"或"谁优先"的问题**。
 * 真正的计时仍落在 message_receipts.burn_at（每个接收方各自从点开时刻起算）。
 *
 * ## 解析优先级（进会话查询与发送消息共用同一套）
 *   ① 私聊：我对**对方**设置的值（scope_type='user', scope_id=对方 user_id）
 *   ② 群/频道：我对**本会话**设置的值（scope_type='conversation'）
 *   ③ 我的全局默认 app_users.default_burn_ttl_seconds
 *   ④ 都没有 → null（不焚毁）
 *
 * ## 与已发消息的关系
 * 本服务只决定"发送时的默认值"；时长会快照进 `messages.burn_ttl_seconds`，
 * 所以改设置**不会**追溯修改已发出的消息（可审计、可解释）。
 *
 * ## 客户端兼容
 * Web 端每次加载都是最新代码、APK 走强制更新，因此**不需要**按客户端版本分支：
 * 一律走上面的解析链；消息级显式传 burn_ttl_seconds 仍然优先（保留"这一条临时改"的能力）。
 *
 * ## 代码约定
 * 查询一律「qb 变量 → 追加条件 → 终止方法」；出参用 response DTO。
 */
@Injectable()
export class BurnSettingService {
  constructor(private readonly dataSource: DataSource) {}

  // ===================== 查询：解析生效值 =====================

  /**
   * 进会话时查询：我在这个会话里发消息时应用的焚毁时长。
   * 前端在输入框上方展示这个值，并可点它去修改。
   */
  async resolveForConversation(
    ownerId: string,
    conversationId: string,
  ): Promise<BurnSettingResolution> {
    const conv = await this.dataSource
      .getRepository(Conversation)
      .findOne({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    await this.assertMember(conversationId, ownerId);

    const globalDefault = await this.getGlobalDefault(ownerId);
    const base = {
      conversation_id: conversationId,
      conversation_type: conv.type,
      global_default_seconds: globalDefault,
    };

    if (conv.type === 'private') {
      const counterpart = await this.findCounterpart(conversationId, ownerId);
      // 私聊：只看"我对这个人设了多少"——我发的消息按这个时长焚毁
      const mine = counterpart ? await this.findOwn(ownerId, 'user', counterpart.user_id) : null;
      return {
        ...base,
        counterpart,
        effective_ttl_seconds: mine?.ttl_seconds ?? globalDefault,
        source: mine ? 'contact_setting' : globalDefault ? 'global_default' : 'none',
        my_setting: mine
          ? { ttl_seconds: mine.ttl_seconds, updated_at: mine.updated_at }
          : null,
      };
    }

    // 群 / 频道：只看"我在本群设了多少"，没有就回落全局默认
    const convSetting = await this.findOwn(ownerId, 'conversation', conversationId);
    return {
      ...base,
      counterpart: null,
      effective_ttl_seconds: convSetting?.ttl_seconds ?? globalDefault,
      source: convSetting
        ? 'conversation_setting'
        : globalDefault
          ? 'global_default'
          : 'none',
      my_setting: convSetting
        ? { ttl_seconds: convSetting.ttl_seconds, updated_at: convSetting.updated_at }
        : null,
    };
  }

  /**
   * 发送消息时解析默认时长（`POST /messages` 未显式传 ttl 时调用）。
   * 与查询接口共用同一套规则，但只返回数字，避免把内部结构带进发送链路。
   */
  async resolveTtlForSend(ownerId: string, conversationId: string): Promise<number | null> {
    const resolution = await this.resolveForConversation(ownerId, conversationId);
    return resolution.effective_ttl_seconds;
  }

  // ===================== 写入：设置 / 清除 =====================

  /** 设置「我对某个用户」的焚毁时长 */
  async setForUser(
    ownerId: string,
    targetUserId: string,
    ttlSeconds: number,
  ): Promise<BurnSettingWriteResult> {
    if (ownerId === targetUserId) throw new BadRequestException('不能给自己设置焚毁时长');
    this.assertTtlRange(ttlSeconds);

    const target = await this.dataSource
      .getRepository(AppUser)
      .findOne({ where: { id: targetUserId } });
    if (!target || target.deleted_at) throw new NotFoundException('目标用户不存在');

    await this.upsert(ownerId, 'user', targetUserId, ttlSeconds);
    return {
      success: true,
      ttl_seconds: ttlSeconds,
      scope_id: targetUserId,
      scope_type: 'user',
    };
  }

  /** 设置「我在某个会话」的焚毁时长（群/频道；私聊请用按人设置） */
  async setForConversation(
    ownerId: string,
    conversationId: string,
    ttlSeconds: number,
  ): Promise<BurnSettingWriteResult> {
    this.assertTtlRange(ttlSeconds);

    const conv = await this.dataSource
      .getRepository(Conversation)
      .findOne({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    if (conv.type === 'private') {
      throw new BadRequestException('私聊请按对方用户设置（PUT /burn-settings/users/:id）');
    }
    await this.assertMember(conversationId, ownerId);

    await this.upsert(ownerId, 'conversation', conversationId, ttlSeconds);
    return {
      success: true,
      ttl_seconds: ttlSeconds,
      scope_id: conversationId,
      scope_type: 'conversation',
    };
  }

  /** 清除「我对某个用户」的设置 → 回落到全局默认 */
  async clearForUser(ownerId: string, targetUserId: string): Promise<BurnSettingWriteResult> {
    await this.dataSource
      .getRepository(BurnSetting)
      .delete({ owner_id: ownerId, scope_type: 'user', scope_id: targetUserId });
    return { success: true, ttl_seconds: null, scope_id: targetUserId, scope_type: 'user' };
  }

  /** 清除「我在某个会话」的设置 */
  async clearForConversation(
    ownerId: string,
    conversationId: string,
  ): Promise<BurnSettingWriteResult> {
    await this.dataSource
      .getRepository(BurnSetting)
      .delete({ owner_id: ownerId, scope_type: 'conversation', scope_id: conversationId });
    return {
      success: true,
      ttl_seconds: null,
      scope_id: conversationId,
      scope_type: 'conversation',
    };
  }

  // ===================== 列表（设置页用）=====================

  async listUserSettings(
    ownerId: string,
    page = 1,
    pageSize = 50,
  ): Promise<BurnSettingList> {
    const offset = (page - 1) * pageSize;

    const qb: SelectQueryBuilder<BurnSetting> = this.dataSource
      .getRepository(BurnSetting)
      .createQueryBuilder('s');
    qb.leftJoin(AppUser, 'u', 'u.id = s.scope_id');
    qb.select('s.scope_id', 'target_user_id');
    qb.addSelect('s.ttl_seconds', 'ttl_seconds');
    qb.addSelect('s.updated_at', 'updated_at');
    qb.addSelect('u.display_name', 'display_name');
    qb.addSelect('u.avatar_url', 'avatar_url');
    qb.where('s.owner_id = :ownerId', { ownerId });
    qb.andWhere("s.scope_type = 'user'");
    qb.orderBy('s.updated_at', 'DESC');
    qb.offset(offset);
    qb.limit(pageSize);
    const rows = await qb.getRawMany<{
      target_user_id: string;
      ttl_seconds: number | string;
      updated_at: Date | string;
      display_name: string | null;
      avatar_url: string | null;
    }>();

    const countQb: SelectQueryBuilder<BurnSetting> = this.dataSource
      .getRepository(BurnSetting)
      .createQueryBuilder('s');
    countQb.where('s.owner_id = :ownerId', { ownerId });
    countQb.andWhere("s.scope_type = 'user'");
    const total = await countQb.getCount();

    const data: BurnSettingListItem[] = rows.map((r) => ({
      target_user_id: r.target_user_id,
      display_name: r.display_name ?? null,
      avatar_url: r.avatar_url ?? null,
      ttl_seconds: Number(r.ttl_seconds),
      updated_at: r.updated_at,
    }));

    return { total, page, pageSize, data };
  }

  // ===================== 内部工具 =====================

  private assertTtlRange(ttlSeconds: number): void {
    if (!Number.isFinite(ttlSeconds)) {
      throw new BadRequestException('ttl_seconds 必须是数字');
    }
    if (ttlSeconds < BURN_TTL_MIN_SECONDS || ttlSeconds > BURN_TTL_MAX_SECONDS) {
      throw new BadRequestException(
        `ttl_seconds 必须在 ${BURN_TTL_MIN_SECONDS} ~ ${BURN_TTL_MAX_SECONDS} 秒之间`,
      );
    }
  }

  private async assertMember(conversationId: string, userId: string): Promise<void> {
    const membership = await this.dataSource.getRepository(ConversationMember).findOne({
      where: { conversation_id: conversationId, user_id: userId },
    });
    if (!membership) throw new ForbiddenException('Access denied to this conversation');
  }

  /** 私聊的对方成员（排除自己）；群聊不调用 */
  private async findCounterpart(
    conversationId: string,
    ownerId: string,
  ): Promise<{ user_id: string; display_name: string | null } | null> {
    const qb: SelectQueryBuilder<ConversationMember> = this.dataSource
      .getRepository(ConversationMember)
      .createQueryBuilder('cm');
    qb.leftJoin(AppUser, 'u', 'u.id = cm.user_id');
    qb.select('cm.user_id', 'user_id');
    qb.addSelect('u.display_name', 'display_name');
    qb.where('cm.conversation_id = :conversationId', { conversationId });
    qb.andWhere('cm.user_id <> :ownerId', { ownerId });
    qb.limit(1);
    const row = await qb.getRawOne<{ user_id: string; display_name: string | null }>();
    return row ? { user_id: row.user_id, display_name: row.display_name ?? null } : null;
  }

  private async findOwn(
    ownerId: string,
    scopeType: 'user' | 'conversation',
    scopeId: string,
  ): Promise<BurnSetting | null> {
    const qb: SelectQueryBuilder<BurnSetting> = this.dataSource
      .getRepository(BurnSetting)
      .createQueryBuilder('s');
    qb.where('s.owner_id = :ownerId', { ownerId });
    qb.andWhere('s.scope_type = :scopeType', { scopeType });
    qb.andWhere('s.scope_id = :scopeId', { scopeId });
    return qb.getOne();
  }

  private async getGlobalDefault(ownerId: string): Promise<number | null> {
    const qb: SelectQueryBuilder<AppUser> = this.dataSource
      .getRepository(AppUser)
      .createQueryBuilder('u');
    qb.select('u.default_burn_ttl_seconds', 'default_burn_ttl_seconds');
    qb.where('u.id = :ownerId', { ownerId });
    const row = await qb.getRawOne<{ default_burn_ttl_seconds: number | null }>();
    const v = row?.default_burn_ttl_seconds;
    return typeof v === 'number' && v > 0 ? v : null;
  }

  private async upsert(
    ownerId: string,
    scopeType: 'user' | 'conversation',
    scopeId: string,
    ttlSeconds: number,
  ): Promise<void> {
    const repo = this.dataSource.getRepository(BurnSetting);
    const existing = await this.findOwn(ownerId, scopeType, scopeId);
    if (existing) {
      await repo.update(existing.id, { ttl_seconds: ttlSeconds });
      return;
    }
    await repo.save(
      repo.create({ owner_id: ownerId, scope_type: scopeType, scope_id: scopeId, ttl_seconds: ttlSeconds }),
    );
  }
}

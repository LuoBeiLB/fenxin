import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UserKey } from '../../entities/user-key.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';

/**
 * 用户公钥服务（V4.0 §E2E 单聊加密 / 方案 B 简化版）。
 *
 * 职责：
 *   - 上传/更新自己 X25519 identity 公钥（1 用户 1 行，多次上传覆盖）
 *   - 查询对方公钥：必须满足"业务关系"（同 conversation 成员 或 contacts 关系），
 *     防止任意用户通过 API 枚举活跃用户 → 拿公钥做关联分析
 *   - 批量查询公钥（TOFU）：一次拉一组有会话关系的用户公钥，供前端与本地缓存比对
 *   - 公钥轮换通知（TOFU）：identity 公钥被覆盖时，向共同会话用户广播 key:changed，
 *     客户端收到后重新拉取比对，不一致即告警 —— 服务端偷换公钥会立刻暴露
 *
 * 不做：
 *   - 曲线点合法性校验（前端解密失败会回流，错误时重传即可）
 *   - 公钥签名（防 MITM 留待 X3DH 升级）
 *   - 私钥托管（绝对不做）
 */
@Injectable()
export class KeysService {
  private readonly logger = new Logger('KeysService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
  ) {}

  /**
   * 上传/更新自己的 identity 公钥。
   * 1 用户 1 行：upsert 语义（已存在则覆盖公钥 + updated_at）。
   */
  async uploadIdentityKey(userId: string, identityPubkey: string): Promise<{ updated: boolean }> {
    const repo = this.dataSource.getRepository(UserKey);
    const existing = await repo.findOne({ where: { user_id: userId }, select: ['id', 'identity_pubkey'] });
    if (existing) {
      if (existing.identity_pubkey === identityPubkey) {
        return { updated: false }; // 幂等：相同公钥不写
      }
      await repo.update(existing.id, { identity_pubkey: identityPubkey });
      this.logger.log(`Identity key rotated for userId=${userId}`);

      // TOFU：公钥轮换 → 广播给所有共同会话用户。
      // 客户端收到 key:changed 后重新 GET /keys/:userId 与本地钉住的公钥比对：
      //   一致 → 幂等重传（可能是服务端重复通知）；不一致 → 告警"对方安全密钥已变更"。
      // emitToUsers 内部自带 try-catch，推送失败不影响上传主流程。
      const peers = await this.getPeerUserIds(userId);
      this.events.emitToUsers(WS_EVENTS.KEY_CHANGED, peers, {
        user_id: userId,
        updated_at: new Date().toISOString(),
      });
      return { updated: true };
    }
    await repo.save(repo.create({ user_id: userId, identity_pubkey: identityPubkey }));
    this.logger.log(`Identity key created for userId=${userId}`);
    return { updated: true };
  }

  /**
   * 查询对方公钥。必须满足"业务关系"：
   *   ① 对方是当前用户的 contacts（用 AppUser 反查 — contacts 模块单独维护关系表，
   *      简化版只校验"是否在至少一个共同 conversation 成员里"）
   *   ② 否则抛 ForbiddenException，避免任意用户拿公钥做关联分析
   */
  async getIdentityKey(currentUserId: string, targetUserId: string): Promise<{ user_id: string; identity_pubkey: string; created_at: Date; updated_at: Date }> {
    if (currentUserId === targetUserId) {
      // 拿自己的公钥：跳过关系校验（前端需要比对"我存储的 vs 服务端存的"）
      const self = await this.dataSource
        .getRepository(UserKey)
        .findOne({ where: { user_id: currentUserId } });
      if (!self) throw new NotFoundException('你尚未上传公钥，请先生成并上传');
      return {
        user_id: self.user_id,
        identity_pubkey: self.identity_pubkey,
        created_at: self.created_at,
        updated_at: self.updated_at,
      };
    }

    // 业务关系校验：是否在至少一个共同 conversation
    // 复用 ConversationMember：找到 currentUserId 所在的 conversationId 集合，
    // 再查这些 conversationId 集合里是否有 targetUserId
    const myConvs = await this.dataSource
      .getRepository(ConversationMember)
      .createQueryBuilder('m')
      .select('DISTINCT m.conversation_id', 'conversation_id')
      .where('m.user_id = :uid', { uid: currentUserId })
      .getRawMany<{ conversation_id: string }>();

    if (myConvs.length === 0) {
      throw new ForbiddenException('对方不在你的会话中，无权获取公钥');
    }
    const myConvIds = myConvs.map((c) => c.conversation_id);

    const shared = await this.dataSource
      .getRepository(ConversationMember)
      .createQueryBuilder('m')
      .select('m.conversation_id', 'conversation_id')
      .where('m.user_id = :tid', { tid: targetUserId })
      .andWhere('m.conversation_id IN (:...ids)', { ids: myConvIds })
      .limit(1)
      .getRawOne();

    if (!shared) {
      throw new ForbiddenException('对方不在你的会话中，无权获取公钥');
    }

    // 通过校验，查对方公钥
    const key = await this.dataSource
      .getRepository(UserKey)
      .findOne({ where: { user_id: targetUserId } });
    if (!key) {
      throw new NotFoundException('对方尚未上传公钥，无法加密发送');
    }
    return {
      user_id: key.user_id,
      identity_pubkey: key.identity_pubkey,
      created_at: key.created_at,
      updated_at: key.updated_at,
    };
  }

  /** 检查 user 是否已上传公钥（内部用，给 message.sendMessage 加密路径校验） */
  async hasKey(userId: string): Promise<boolean> {
    const count = await this.dataSource
      .getRepository(UserKey)
      .createQueryBuilder('k')
      .where('k.user_id = :uid', { uid: userId })
      .getCount();
    return count > 0;
  }

  /**
   * 批量查询公钥（TOFU 前端比对用）。
   * 权限与单个查询一致：只返回「自己 + 与自己至少一个共同 conversation 的成员」；
   * 未上传公钥 / 无共同会话的用户直接不出现在结果里（前端自行 diff 出缺的）。
   * 一条 SQL 搞定，不做逐个权限校验。
   */
  async getIdentityKeysBatch(
    currentUserId: string,
    userIds: string[],
  ): Promise<Array<{ user_id: string; identity_pubkey: string; created_at: Date; updated_at: Date }>> {
    // 去重 + 自己置前（自己永远可查，前端需要比对"我存储的 vs 服务端存的"）
    const others = [...new Set(userIds)].filter((id) => id !== currentUserId);
    const ids = [currentUserId, ...others];

    const keys = await this.dataSource
      .getRepository(UserKey)
      .createQueryBuilder('k')
      .select(['k.user_id', 'k.identity_pubkey', 'k.created_at', 'k.updated_at'])
      .where('k.user_id IN (:...ids)', { ids })
      .andWhere(
        `(k.user_id = :me OR EXISTS (
           SELECT 1 FROM conversation_members m1
           JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
           WHERE m1.user_id = :me AND m2.user_id = k.user_id
         ))`,
        { me: currentUserId },
      )
      .getMany();

    return keys.map((k) => ({
      user_id: k.user_id,
      identity_pubkey: k.identity_pubkey,
      created_at: k.created_at,
      updated_at: k.updated_at,
    }));
  }

  /**
   * 取与 userId 有共同会话的其他用户 ID（去重）。
   * 供公钥轮换广播用：只有"可能缓存了旧公钥"的人需要收到 key:changed。
   */
  private async getPeerUserIds(userId: string): Promise<string[]> {
    const rows = await this.dataSource
      .getRepository(ConversationMember)
      .createQueryBuilder('m1')
      .select('DISTINCT m2.user_id', 'user_id')
      .innerJoin(ConversationMember, 'm2', 'm2.conversation_id = m1.conversation_id')
      .where('m1.user_id = :uid', { uid: userId })
      .andWhere('m2.user_id != :uid', { uid: userId })
      .getRawMany<{ user_id: string }>();
    return rows.map((r) => r.user_id);
  }
}

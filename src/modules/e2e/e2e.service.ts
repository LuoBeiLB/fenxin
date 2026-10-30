import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource, In } from 'typeorm';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';
import { MessageTombstone } from '../../entities/message-tombstone.entity';
import { BurnSetting } from '../../entities/burn-setting.entity';
import { Device } from '../../entities/device.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';
import { OssService } from '../upload/oss.service';
import { SecretChatAcceptResult, SecretChatMutationResult, SecretChatRequestResult } from './dto/response';

/** 关闭触发方：用户主动 / 绑定设备被移除 / 管理员强制 / 过期清理 */
export type SecretChatTrigger = 'user' | 'device_removed' | 'admin';

/** 私有会话状态（与 conversations.e2e_state 对应） */
export const E2E_STATE = {
  NONE: 0,
  PENDING: 1,
  ACTIVE: 2,
} as const;

/** pending 有效期（天） */
const PENDING_TTL_DAYS = 7;

/**
 * 设备配对私密会话（Secret Chat，V6.2）。
 *
 * 核心语义（见 docs/E2E_SECRET_CHAT.md）：
 *  - 一条私密会话 = 发起设备 A ↔ 接受设备 B；
 *  - pending 时目标用户的**任意设备**都能看到请求，谁接受谁绑定；
 *  - active 后**只有这两台设备**可见（其余设备连会话行都查不到）；
 *  - **关闭 = 物理删除**：会话行、消息（含密文）、回执、墓碑、附件全部删除，
 *    不留 closed 状态、不写 destroy_reason、不写审计 —— 避免事后反推"曾经有过私密会话"。
 */
@Injectable()
export class E2eService {
  private readonly logger = new Logger('E2E');

  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
    private readonly oss: OssService,
  ) {}

  // ===================== 发起 / 接受 / 拒绝 =====================

  /** 发起私密聊天请求（在当前设备上） */
  async requestSecretChat(
    userId: string,
    deviceId: string,
    targetUserId: string,
  ): Promise<SecretChatRequestResult> {
    if (!deviceId) throw new BadRequestException('缺少设备上下文，请重新登录');
    if (userId === targetUserId) throw new BadRequestException('不能对自己发起私密聊天');

    await this.assertPeerRelation(userId, targetUserId);

    const existing = await this.findActiveOrPending(userId, targetUserId);
    if (existing) {
      throw new ConflictException({
        code: 'E2E_PAIR_EXISTS',
        message:
          existing.e2e_state === E2E_STATE.PENDING
            ? '已有一条待对方接受的私密聊天'
            : '你和对方已有进行中的私密聊天',
        conversation_id: existing.id,
      });
    }

    const [userA, userB] = [userId, targetUserId].sort();
    const convId = await this.dataSource.transaction(async (m) => {
      const convRepo = m.getRepository(Conversation);
      const saved = await convRepo.save(
        convRepo.create({
          type: 'private',
          member_count: 2,
          e2e_mode: 1,
          e2e_state: E2E_STATE.PENDING,
          user_a: userA,
          user_b: userB,
          e2e_device_a: deviceId,
          e2e_device_b: null,
        }),
      );

      const memberRepo = m.getRepository(ConversationMember);
      await memberRepo.save([
        memberRepo.create({ conversation_id: saved.id, user_id: userId, role: 'member' }),
        memberRepo.create({ conversation_id: saved.id, user_id: targetUserId, role: 'member' }),
      ]);
      return saved.id;
    });

    const expiresAt = new Date(Date.now() + PENDING_TTL_DAYS * 24 * 3600 * 1000);

    // 推给目标用户的**全部设备**（任何一台都可以接受）
    this.events.emitToUsers(WS_EVENTS.E2E_REQUESTED, [targetUserId], {
      conversation_id: convId,
      from_user: { id: userId, display_name: null },
      expires_at: expiresAt.toISOString(),
      at: new Date().toISOString(),
    });

    this.logger.log(`secret chat requested conversation=${convId}`);
    return { conversation_id: convId, e2e_state: E2E_STATE.PENDING, expires_at: expiresAt };
  }

  /** 接受请求：把当前设备绑定为接受端 */
  async acceptSecretChat(
    conversationId: string,
    userId: string,
    deviceId: string,
  ): Promise<SecretChatAcceptResult> {
    if (!deviceId) throw new BadRequestException('缺少设备上下文，请重新登录');

    const conv = await this.loadConversation(conversationId);
    this.assertParticipant(conv, userId);
    if (conv.e2e_state !== E2E_STATE.PENDING) {
      throw new ConflictException({ code: 'E2E_STATE_INVALID', message: '该请求已被处理' });
    }
    if (this.isExpired(conv)) {
      await this.hardDelete(conv.id, conv, 'admin', { pendingOnly: true });
      throw new GoneException({ code: 'E2E_EXPIRED', message: '该请求已过期，请让对方重新发起' });
    }

    // 唯一约束兜底：极端并发下可能撞 uk_e2e_pair
    try {
      await this.dataSource
        .getRepository(Conversation)
        .update(conv.id, { e2e_state: E2E_STATE.ACTIVE, e2e_device_b: deviceId });
    } catch (err: any) {
      if (err?.errno === 1062) {
        throw new ConflictException({ code: 'E2E_PAIR_EXISTS', message: '你和对方已有进行中的私密聊天' });
      }
      throw err;
    }

    const peerDeviceId = conv.e2e_device_a!;
    this.events.emitToDevices(WS_EVENTS.E2E_ACCEPTED, [peerDeviceId, deviceId], {
      conversation_id: conv.id,
      peer_device_id: peerDeviceId,
      at: new Date().toISOString(),
    });

    // 接受者其余设备：把这条 pending 从列表移除
    const others = await this.otherDeviceIds(userId, deviceId);
    if (others.length > 0) {
      this.events.emitToDevices(WS_EVENTS.E2E_REQUEST_GONE, others, {
        conversation_id: conv.id,
        reason: 'accepted',
        at: new Date().toISOString(),
      });
    }

    this.logger.log(`secret chat accepted conversation=${conv.id}`);
    return {
      conversation_id: conv.id,
      e2e_state: E2E_STATE.ACTIVE,
      bound_device_id: deviceId,
      peer_device_id: peerDeviceId,
    };
  }

  /**
   * 拒绝请求（被邀请方任一设备可拒绝）。
   * 直接删除会话行：不保留 rejected 状态，避免留下"曾经有过请求"的痕迹。
   */
  async rejectSecretChat(
    conversationId: string,
    userId: string,
    deviceId: string,
  ): Promise<SecretChatMutationResult> {
    const conv = await this.loadConversation(conversationId);
    this.assertParticipant(conv, userId);
    if (conv.e2e_state !== E2E_STATE.PENDING) {
      throw new ConflictException({ code: 'E2E_STATE_INVALID', message: '该请求已被处理' });
    }
    // 发起方不能用"拒绝"，应走 close（撤回）
    if (conv.e2e_device_a === deviceId) {
      throw new BadRequestException('发起方请使用撤回接口');
    }

    const initiatorDevice = conv.e2e_device_a!;
    const deleted = await this.hardDelete(conv.id, conv, 'user', { pendingOnly: true });

    this.events.emitToDevices(WS_EVENTS.E2E_REJECTED, [initiatorDevice], {
      conversation_id: conversationId,
      at: new Date().toISOString(),
    });

    const others = await this.otherDeviceIds(userId, deviceId);
    if (others.length > 0) {
      this.events.emitToDevices(WS_EVENTS.E2E_REQUEST_GONE, others, {
        conversation_id: conversationId,
        reason: 'rejected',
        at: new Date().toISOString(),
      });
    }

    return { conversation_id: conversationId, deleted: true, deleted_messages: deleted };
  }

  // ===================== 关闭（物理删除） =====================

  /**
   * 关闭 / 撤回私密会话。
   *
   * 权限：
   *  - pending：仅发起设备可撤回；
   *  - active：两台绑定设备都可关闭；
   *  - admin：不限（管理员强制关闭 / 过期清理）。
   *
   * 幂等：会话已不存在时返回 deleted=true / 0 条消息，不报错。
   */
  async closeSecretChat(
    conversationId: string,
    userId: string,
    deviceId: string,
    trigger: SecretChatTrigger = 'user',
  ): Promise<SecretChatMutationResult> {
    const conv = await this.loadConversation(conversationId);
    if (!conv) {
      return { conversation_id: conversationId, deleted: true, deleted_messages: 0 };
    }
    if (conv.e2e_mode !== 1) throw new BadRequestException('不是私密会话');

    if (trigger !== 'admin') {
      const isPending = conv.e2e_state === E2E_STATE.PENDING;
      const allowed = isPending
        ? conv.e2e_device_a === deviceId
        : conv.e2e_device_a === deviceId || conv.e2e_device_b === deviceId;
      if (!allowed) {
        throw new ForbiddenException({ code: 'E2E_NOT_BOUND_DEVICE', message: '本设备无权操作该私密会话' });
      }
    }

    const wasPending = conv.e2e_state === E2E_STATE.PENDING;
    const notifyDevices = [conv.e2e_device_a, conv.e2e_device_b].filter(Boolean) as string[];

    const deletedMessages = await this.hardDelete(conv.id, conv, trigger);

    // 提交后广播：pending 撤回用 request_gone，active 关闭用 closed
    if (notifyDevices.length > 0) {
      if (wasPending) {
        this.events.emitToDevices(WS_EVENTS.E2E_REQUEST_GONE, notifyDevices, {
          conversation_id: conv.id,
          reason: trigger === 'admin' ? 'expired' : 'cancelled',
          at: new Date().toISOString(),
        });
      } else {
        this.events.emitToDevices(WS_EVENTS.E2E_CLOSED, notifyDevices, {
          conversation_id: conv.id,
          trigger,
          at: new Date().toISOString(),
        });
      }
    }

    this.logger.log(`secret chat closed conversation=${conv.id} messages=${deletedMessages}`);
    return { conversation_id: conv.id, deleted: true, deleted_messages: deletedMessages };
  }

  /** 设备被移除 / 踢下线时，关闭该设备绑定的所有私密会话（调用方：AuthService.removeDevice） */
  async closeSecretChatsBoundTo(deviceId: string, trigger: SecretChatTrigger = 'device_removed'): Promise<number> {
    if (!deviceId) return 0;

    const rows = await this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c')
      .select(['c.id', 'c.user_a', 'c.user_b'])
      .where('c.e2e_mode = 1 AND c.e2e_state IN (1, 2)')
      .andWhere('(c.e2e_device_a = :d OR c.e2e_device_b = :d)', { d: deviceId })
      .getMany();

    for (const c of rows) {
      await this.closeSecretChat(c.id, c.user_a ?? '', deviceId, trigger);
    }
    return rows.length;
  }

  /** pending 过期清理：每 10 分钟跑一次，直接删行 */
  @Cron('*/10 * * * *')
  async expirePendingRequests(): Promise<void> {
    const cutoff = new Date(Date.now() - PENDING_TTL_DAYS * 24 * 3600 * 1000);
    const rows = await this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c')
      .select(['c.id', 'c.user_a'])
      .where('c.e2e_mode = 1 AND c.e2e_state = :s', { s: E2E_STATE.PENDING })
      .andWhere('c.created_at < :cutoff', { cutoff })
      .limit(200)
      .getMany();

    for (const c of rows) {
      await this.closeSecretChat(c.id, c.user_a ?? '', '', 'admin');
    }
    if (rows.length > 0) this.logger.log(`expired ${rows.length} secret chat request(s)`);
  }

  // ===================== 内部工具 =====================

  /** 读取会话（不存在返回 null，供幂等关闭使用） */
  private async loadConversation(id: string): Promise<Conversation | null> {
    return this.dataSource.getRepository(Conversation).findOne({ where: { id } });
  }

  private assertParticipant(conv: Conversation, userId: string): void {
    if (conv.user_a !== userId && conv.user_b !== userId) {
      throw new ForbiddenException({ code: 'E2E_NOT_MEMBER', message: '你不是该私密会话的成员' });
    }
  }

  private isExpired(conv: Conversation): boolean {
    const created = new Date(conv.created_at).getTime();
    return Date.now() - created > PENDING_TTL_DAYS * 24 * 3600 * 1000;
  }

  /** 查同一对用户是否已有 pending/active 会话 */
  private async findActiveOrPending(a: string, b: string): Promise<Conversation | null> {
    const [userA, userB] = [a, b].sort();
    return this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c')
      .where('c.e2e_mode = 1 AND c.e2e_state IN (1, 2)')
      .andWhere('c.user_a = :a AND c.user_b = :b', { a: userA, b: userB })
      .getOne();
  }

  /** 判断两用户是否有共同会话（发起前置校验） */
  private async assertPeerRelation(currentUserId: string, targetUserId: string): Promise<void> {
    const qb = this.dataSource.getRepository(ConversationMember).createQueryBuilder('m1');
    qb.innerJoin(ConversationMember, 'm2', 'm2.conversation_id = m1.conversation_id');
    qb.where('m1.user_id = :me', { me: currentUserId });
    qb.andWhere('m2.user_id = :target', { target: targetUserId });
    qb.limit(1);
    const shared = await qb.getOne();
    if (!shared) throw new ForbiddenException('对方不在你的会话中，不能发起私密聊天');
  }

  private async otherDeviceIds(userId: string, excludeDeviceId: string): Promise<string[]> {
    const rows = await this.dataSource
      .getRepository(Device)
      .createQueryBuilder('d')
      .select(['d.id'])
      .where('d.user_id = :uid', { uid: userId })
      .andWhere('d.id != :did', { did: excludeDeviceId })
      .getMany();
    return rows.map((d) => d.id);
  }

  /**
   * 物理删除一个私密会话及其全部数据（见文档 §7.2）。
   *
   * 顺序：OSS 附件 → 回执 → 墓碑 → 消息 → 会话级设置 → 成员 → 会话行。
   * 返回删除的消息条数。
   */
  private async hardDelete(
    conversationId: string,
    conv: Conversation,
    trigger: SecretChatTrigger,
    opts: { pendingOnly?: boolean } = {},
  ): Promise<number> {
    // ① 附件必须先删（URL 存在消息行上，删行后就拿不到了）
    const messages = await this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .select(['m.id', 'm.file_url', 'm.file_original_url'])
      .where('m.conversation_id = :cid', { cid: conversationId })
      .getMany();

    for (const msg of messages) {
      if (msg.file_url) await this.oss.deleteByUrl(msg.file_url);
      if (msg.file_original_url) await this.oss.deleteByUrl(msg.file_original_url);
    }

    let deleted = 0;
    await this.dataSource.transaction(async (m) => {
      // ② 回执（先用子查询取出消息 id，避免删消息后查不到）
      const ids = messages.map((x) => x.id);
      if (ids.length > 0) {
        await m.getRepository(MessageReceipt).delete({ message_id: In(ids) });
      }
      // ③ 墓碑
      await m.getRepository(MessageTombstone).delete({ conversation_id: conversationId });
      // ④ 消息
      if (ids.length > 0) {
        const r = await m.getRepository(Message).delete({ id: In(ids) });
        deleted = r.affected ?? 0;
      }
      // ⑤ 会话级焚毁设置
      await m
        .getRepository(BurnSetting)
        .createQueryBuilder()
        .delete()
        .where("scope_type = 'conversation' AND scope_id = :cid", { cid: conversationId })
        .execute();
      // ⑥ 成员
      await m.getRepository(ConversationMember).delete({ conversation_id: conversationId });
      // ⑦ 会话行（唯一约束随行删除释放）
      await m.getRepository(Conversation).delete({ id: conversationId });
    });

    // pendingOnly 只是语义标记，硬删除对两种状态一视同仁
    void trigger;
    void opts;
    return deleted;
  }
}

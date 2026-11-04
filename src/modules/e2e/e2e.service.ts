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
import { AppUser } from '../../entities/app-user.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';
import { OssService } from '../upload/oss.service';
import {
  SecretChatAcceptResult,
  SecretChatMineView,
  SecretChatMutationResult,
  SecretChatRequestResult,
} from './dto/response';
import { E2E_STATE, PENDING_TTL_DAYS, pendingExpiresAt } from './e2e.constants';

/**
 * 关闭触发方（V6.2.1 扩展）：
 *  - user           用户在某台设备上主动关闭
 *  - device_removed 设备被下线 / 被踢（含用户主动下线别的设备）
 *  - admin           管理员强制 / pending 过期清理
 *  - logout          退出登录时批量结束（前端 F-2）
 *  - device_change   换设备后在新设备上结束旧会话（前端 F-3）
 *  - device_gone     僵尸会话清理：绑定设备 7 天未上线或记录已删除
 */
export type SecretChatTrigger =
  | 'user'
  | 'device_removed'
  | 'admin'
  | 'logout'
  | 'device_change'
  | 'device_gone';

/** 状态与有效期统一从 e2e.constants 取，避免各模块各写一份 */
export { E2E_STATE } from './e2e.constants';

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
      // B-7：把「已有会话绑在哪台设备」一并返回，前端才能提示
      // 「你已在【电脑A】有一条与 B 的加密聊天（该设备已 3 天未上线）」
      const iAmUserA = existing.user_a === userId;
      const myBoundDeviceId = iAmUserA ? existing.e2e_device_a : existing.e2e_device_b;
      const boundDevice = myBoundDeviceId
        ? await this.dataSource.getRepository(Device).findOne({ where: { id: myBoundDeviceId } })
        : null;

      throw new ConflictException({
        code: 'E2E_PAIR_EXISTS',
        message:
          existing.e2e_state === E2E_STATE.PENDING
            ? '已有一条待对方接受的私密聊天'
            : '你和对方已有进行中的私密聊天',
        conversation_id: existing.id,
        e2e_state: existing.e2e_state,
        bound_user_id: userId,
        bound_device_id: myBoundDeviceId ?? null,
        bound_device_name: boundDevice?.device_name ?? null,
        bound_device_online: boundDevice?.is_online ?? null,
        bound_device_last_seen_at:
          (boundDevice?.last_active_at ?? boundDevice?.online_at ?? null) as Date | null,
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

    const conv = await this.requireConversation(conversationId);
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
    const conv = await this.requireConversation(conversationId);
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
   * 权限（V6.2.1 放宽，用于解开"换设备后死锁"）：
   *  - user / logout / device_change：**同一用户的任意设备**都能结束自己名下的会话
   *    （关闭不泄露任何内容，而旧设备可能已经丢失，必须给用户自己留一条出口）；
   *  - device_removed / device_gone：服务端内部按设备维度清理；
   *  - admin：不限（管理员强制关闭 / pending 过期清理）。
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
      const isParticipant = conv.user_a === userId || conv.user_b === userId;
      const isBoundDevice = deviceId === conv.e2e_device_a || deviceId === conv.e2e_device_b;
      const selfService = trigger === 'user' || trigger === 'logout' || trigger === 'device_change';
      const serverCleanup = trigger === 'device_removed' || trigger === 'device_gone';

      const allowed = selfService
        ? isParticipant
        : serverCleanup
          ? isParticipant || isBoundDevice
          : isBoundDevice;

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

  // ===================== 跨设备治理（V6.2.1） =====================

  /** 僵尸会话判定天数：绑定设备连续离线超过该天数即自动结束（env E2E_DEVICE_GONE_DAYS，默认 7） */
  private deviceGoneDays(): number {
    const n = parseInt(process.env.E2E_DEVICE_GONE_DAYS || '7', 10);
    return Number.isFinite(n) && n > 0 ? n : 7;
  }

  /**
   * B-1：列出「我名下」的全部进行中私密会话（不依赖当前设备是否绑定）。
   *
   * 用途：
   *  - 退出登录前提示「将结束 N 个加密聊天」（前端 F-1）
   *  - 新设备登录后提示「有未结束的加密聊天」（前端 F-3）
   *  - 锁图标面板「其他设备的加密聊天(N)」（前端 F-4）
   *
   * @param opts.deviceId    当前设备（用于计算 is_bound_device）
   * @param opts.boundDevice all=全部 this=绑在本设备 other=绑在其它设备（含已丢失设备）
   */
  async listMine(
    userId: string,
    opts: { deviceId?: string; boundDevice?: 'all' | 'this' | 'other' } = {},
  ): Promise<SecretChatMineView[]> {
    const boundDevice = opts.boundDevice ?? 'all';

    const rows = await this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c')
      .where('c.e2e_mode = 1 AND c.e2e_state IN (1, 2)')
      .andWhere('(c.user_a = :uid OR c.user_b = :uid)', { uid: userId })
      .orderBy('c.created_at', 'DESC')
      .limit(200)
      .getMany();
    if (rows.length === 0) return [];

    // 对方昵称
    const peerIds = [
      ...new Set(rows.map((c) => (c.user_a === userId ? c.user_b : c.user_a)).filter(Boolean)),
    ] as string[];
    const peers = peerIds.length
      ? await this.dataSource
          .getRepository(AppUser)
          .find({ where: { id: In(peerIds) }, select: ['id', 'display_name'] })
      : [];
    const peerMap = new Map(peers.map((u) => [u.id, u.display_name]));

    // 绑定设备信息（名称 / 在线 / 最后活跃）
    const deviceIds = [
      ...new Set(rows.flatMap((c) => [c.e2e_device_a, c.e2e_device_b]).filter(Boolean)),
    ] as string[];
    const devices = deviceIds.length
      ? await this.dataSource.getRepository(Device).find({ where: { id: In(deviceIds) } })
      : [];
    const devMap = new Map(devices.map((d) => [d.id, d]));

    const asOf = new Date().toISOString();
    const list: SecretChatMineView[] = rows.map((c) => {
      const iAmUserA = c.user_a === userId;
      const peerUserId = iAmUserA ? c.user_b : c.user_a;
      // 我为 a 时绑定设备是 a；为 b 时是 b（pending 阶段 b 尚未绑定 → null）
      const myDeviceId = iAmUserA ? c.e2e_device_a : c.e2e_device_b;
      const peerDeviceId = iAmUserA ? c.e2e_device_b : c.e2e_device_a;
      const myDevice = myDeviceId ? devMap.get(myDeviceId) : undefined;

      return {
        conversation_id: c.id,
        state: c.e2e_state === E2E_STATE.PENDING ? 'pending' : 'active',
        peer_user_id: peerUserId ?? null,
        peer_name: peerUserId ? (peerMap.get(peerUserId) ?? null) : null,
        /** 我在这条会话上绑定的设备（null = 我是被邀请方且尚未接受 / 已失去绑定） */
        bound_device_id: myDeviceId ?? null,
        bound_device_name: myDevice?.device_name ?? null,
        bound_device_online: myDevice?.is_online ?? null,
        bound_device_last_seen_at: (myDevice?.last_active_at ?? myDevice?.online_at ?? null) as
          | Date
          | null,
        /** 绑定的这台是不是当前请求设备（false 且 bound_device_id 非空 = 绑在别的设备上） */
        is_bound_device: !!opts.deviceId && myDeviceId === opts.deviceId,
        peer_device_id: peerDeviceId ?? null,
        created_at: c.created_at,
        expires_at:
          c.e2e_state === E2E_STATE.PENDING
            ? pendingExpiresAt(c.created_at).toISOString()
            : null,
        as_of: asOf,
      };
    });

    return list.filter((item) => {
      if (boundDevice === 'all') return true;
      const boundElsewhere = !!item.bound_device_id && !item.is_bound_device;
      return boundDevice === 'other' ? boundElsewhere : item.is_bound_device;
    });
  }

  /**
   * B-3：一次结束我名下全部进行中私密会话（退出登录 / 换设备时用）。
   *
   * @param reason                关闭原因（logout / device_change / user）
   * @param opts.onlyOtherDevices true = 只结束绑在**其它设备**上的（不动当前设备正在用的）
   */
  async closeAll(
    userId: string,
    deviceId: string,
    reason: SecretChatTrigger = 'user',
    opts: { onlyOtherDevices?: boolean } = {},
  ): Promise<{ closed: number; conversation_ids: string[]; deleted_messages: number }> {
    const mine = await this.listMine(userId, {
      deviceId,
      boundDevice: opts.onlyOtherDevices ? 'other' : 'all',
    });

    const conversationIds: string[] = [];
    let deletedMessages = 0;

    for (const item of mine) {
      try {
        const r = await this.closeSecretChat(item.conversation_id, userId, deviceId, reason);
        conversationIds.push(item.conversation_id);
        deletedMessages += r.deleted_messages;
      } catch (err: any) {
        // 单条失败不阻塞批量（可能已被对方同时关闭）
        this.logger.warn(
          `close-all skipped conversation=${item.conversation_id} err=${err?.message || err}`,
        );
      }
    }

    if (conversationIds.length > 0) {
      this.logger.log(
        `secret chat close-all user=${userId} count=${conversationIds.length} reason=${reason}`,
      );
    }
    return {
      closed: conversationIds.length,
      conversation_ids: conversationIds,
      deleted_messages: deletedMessages,
    };
  }

  /**
   * B-10（=B-8）：僵尸会话清理 —— 绑定设备长时间未上线、或设备记录已被删除时自动结束。
   *
   * 判定（任一命中即结束，reason=device_gone）：
   *  1. 绑定设备在 devices 表里**已不存在**（下线 / 被踢 / 账号删除）；
   *  2. 绑定设备最后活跃时间超过 E2E_DEVICE_GONE_DAYS（默认 7 天）。
   *
   * 每小时跑一次；每次最多处理 200 条，避免长事务。
   */
  @Cron('0 * * * *')
  async closeGoneDeviceChats(): Promise<void> {
    const days = this.deviceGoneDays();
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

    const rows = await this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c')
      .where('c.e2e_mode = 1 AND c.e2e_state IN (1, 2)')
      .andWhere('c.created_at < :cutoff', { cutoff })
      .orderBy('c.created_at', 'ASC')
      .limit(200)
      .getMany();
    if (rows.length === 0) return;

    const deviceIds = [
      ...new Set(rows.flatMap((c) => [c.e2e_device_a, c.e2e_device_b]).filter(Boolean)),
    ] as string[];
    const devices = deviceIds.length
      ? await this.dataSource.getRepository(Device).find({ where: { id: In(deviceIds) } })
      : [];
    const devMap = new Map(devices.map((d) => [d.id, d]));

    let closed = 0;
    for (const c of rows) {
      // pending 看发起设备；active 看任一台绑定设备
      const bound = [c.e2e_device_a, c.e2e_device_b].filter(Boolean) as string[];
      const gone = bound.some((id) => {
        const d = devMap.get(id);
        if (!d) return true; // 设备记录已删除
        const lastSeen = d.last_active_at ?? d.online_at ?? d.created_at;
        return new Date(lastSeen).getTime() < cutoff.getTime();
      });
      if (!gone) continue;

      try {
        await this.closeSecretChat(c.id, c.user_a ?? '', c.e2e_device_a ?? '', 'device_gone');
        closed += 1;
      } catch (err: any) {
        this.logger.warn(`device_gone close failed conversation=${c.id} err=${err?.message || err}`);
      }
    }

    if (closed > 0) this.logger.log(`closed ${closed} secret chat(s) by device_gone (>${days}d)`);
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

  /**
   * 读取会话，不存在直接 404 E2E_SESSION_GONE。
   * accept / reject 用这个：传不存在的 id 不能是一句「服务器内部错误」，
   * 前端要能区分「这条请求已被处理/已过期」而直接把它从列表里移除。
   */
  private async requireConversation(id: string): Promise<Conversation> {
    const conv = await this.loadConversation(id);
    if (!conv) {
      throw new NotFoundException({
        code: 'E2E_SESSION_GONE',
        message: '私密会话不存在（可能已被对方关闭、撤回或过期）',
      });
    }
    return conv;
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

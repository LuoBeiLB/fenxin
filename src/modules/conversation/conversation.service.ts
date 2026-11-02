import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { AppUser, sanitizeUser } from '../../entities/app-user.entity';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';
import { pendingExpiresAt } from '../e2e/e2e.constants';

@Injectable()
export class ConversationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
  ) {}

  /** 获取（或创建）两人的私聊会话；共同会话只认 type='private'，避免命中共同群 */
  async getOrCreatePrivateConversation(userId1: string, userId2: string): Promise<Conversation> {
    const memberRepo = this.dataSource.getRepository(ConversationMember);
    const convRepo = this.dataSource.getRepository(Conversation);

    const target = await this.dataSource.getRepository(AppUser).findOne({ where: { id: userId2 } });
    if (!target || target.status !== 'active') {
      throw new NotFoundException('对方账号不存在或已停用');
    }

    const [member1Convs, member2Convs] = await Promise.all([
      memberRepo.find({ where: { user_id: userId1 } }),
      memberRepo.find({ where: { user_id: userId2 } }),
    ]);

    const conv2Ids = new Set(member2Convs.map((m) => m.conversation_id));
    const commonIds = member1Convs.map((m) => m.conversation_id).filter((id) => conv2Ids.has(id));

    if (commonIds.length > 0) {
      const conv = await convRepo.findOne({ where: { id: In(commonIds), type: 'private' } });
      if (conv) return conv;
    }

    const savedConv = await convRepo.save(convRepo.create({ type: 'private' }));
    await memberRepo.save([
      memberRepo.create({ conversation_id: savedConv.id, user_id: userId1, role: 'member' }),
      memberRepo.create({ conversation_id: savedConv.id, user_id: userId2, role: 'member' }),
    ]);
    await convRepo.update(savedConv.id, { member_count: 2 });

    // 实时推送：新会话创建，双方会话列表立即刷新
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, [userId1, userId2], {
      conversation_id: savedConv.id,
      reason: 'created',
    });

    return savedConv;
  }

  async listMyConversations(userId: string, deviceId?: string) {
    const memberRepo = this.dataSource.getRepository(ConversationMember);
    const convRepo = this.dataSource.getRepository(Conversation);
    const userRepo = this.dataSource.getRepository(AppUser);

    const memberships = await memberRepo.find({ where: { user_id: userId } });
    if (memberships.length === 0) return [];

    const convIds = memberships.map((m) => m.conversation_id);
    const conversations = await convRepo
      .createQueryBuilder('c')
      .whereInIds(convIds)
      // 已解散的群不出现在会话列表（数据保留供审计）
      .andWhere('c.dissolved_at IS NULL')
      // V6.2 私密会话按设备可见（E2E_SECRET_CHAT.md §6.1）：
      //   pending → 双方所有设备可见（作为"请求"）
      //   active  → 仅两台绑定设备可见
      .andWhere(
        `(c.e2e_mode = 0
          OR (c.e2e_mode = 1 AND c.e2e_state = 1 AND :uid IN (c.user_a, c.user_b))
          OR (c.e2e_mode = 1 AND c.e2e_state = 2 AND :deviceId IN (c.e2e_device_a, c.e2e_device_b)))`,
        { uid: userId, deviceId: deviceId ?? '' },
      )
      // MySQL 不支持 NULLS LAST，用 IS NULL 表达式实现同样效果（无消息的会话排最后）
      .orderBy('c.last_message_at IS NULL', 'ASC')
      .addOrderBy('c.last_message_at', 'DESC')
      .getMany();
    if (conversations.length === 0) return [];

    // 未读数（V6.0）：一次聚合查询，避免 N+1；排除已焚毁消息
    // V6.1 口径（READ_UNREAD_API.md §4）：
    //   - 排除已焚毁（is_destroyed=1）与已到期未扫（destroy_at <= now）的消息；
    //   - 未点开的焚毁消息 / 未查看的加密消息仍算未读（回执 is_read 只有点开后才置 1）
    const unreadRows = await this.dataSource
      .getRepository(MessageReceipt)
      .createQueryBuilder('r')
      .select('m.conversation_id', 'conversation_id')
      .addSelect('COUNT(*)', 'cnt')
      .innerJoin(Message, 'm', 'm.id = r.message_id')
      .where('r.user_id = :userId', { userId })
      .andWhere('r.is_read = :isRead', { isRead: false })
      .andWhere('m.is_destroyed = :destroyed', { destroyed: false })
      .andWhere('(m.destroy_at IS NULL OR m.destroy_at > :now)', { now: new Date() })
      .andWhere('m.conversation_id IN (:...ids)', { ids: conversations.map((c) => c.id) })
      .groupBy('m.conversation_id')
      .getRawMany<{ conversation_id: string; cnt: string }>();
    const unreadMap = new Map(unreadRows.map((r) => [r.conversation_id, Number(r.cnt)]));

    return Promise.all(
      conversations.map(async (conv) => {
        const base = {
          ...conv,
          unread_count: unreadMap.get(conv.id) ?? 0,
          // 私密会话（V6.2）：前端据此渲染「请求 / 进行中」，并判断本设备是否绑定
          is_bound_device:
            conv.e2e_mode === 1 &&
            (conv.e2e_device_a === deviceId || conv.e2e_device_b === deviceId),
          peer_device_id:
            conv.e2e_mode === 1
              ? conv.e2e_device_a === deviceId
                ? conv.e2e_device_b
                : conv.e2e_device_a
              : null,
          // B2：pending 请求要能在前端显示"剩余 N 天"与右上角角标，
          // 必须给出绝对过期时间（= created_at + 7 天），不能返回 null
          e2e_expires_at:
            conv.e2e_mode === 1 && conv.e2e_state === 1
              ? pendingExpiresAt(conv.created_at)
              : null,
        };
        if (conv.type === 'private') {
          const members = await memberRepo.find({ where: { conversation_id: conv.id } });
          const otherUserId = members.map((m) => m.user_id).find((id) => id !== userId);
          if (otherUserId) {
            const otherUser = await userRepo.findOne({ where: { id: otherUserId } });
            if (otherUser) {
              return { ...base, other_user: sanitizeUser(otherUser) };
            }
          }
        }
        return base;
      }),
    );
  }

  async getConversation(conversationId: string, userId: string, deviceId?: string) {
    const membership = await this.dataSource.getRepository(ConversationMember).findOne({
      where: { conversation_id: conversationId, user_id: userId },
    });
    if (!membership) throw new ForbiddenException('Access denied to this conversation');

    const conv = await this.dataSource.getRepository(Conversation).findOne({
      where: { id: conversationId },
    });
    if (!conv) throw new NotFoundException('会话不存在');

    // V6.2 私密会话：active 时仅绑定设备可见
    if (conv.e2e_mode === 1 && conv.e2e_state === 2) {
      const bound = !!deviceId && (conv.e2e_device_a === deviceId || conv.e2e_device_b === deviceId);
      if (!bound) throw new ForbiddenException('本设备无权访问该私密会话');
    }

    // 单个会话查询也要带 e2e_expires_at（与列表保持一致）
    return {
      ...conv,
      e2e_expires_at:
        conv.e2e_mode === 1 && conv.e2e_state === 1 ? pendingExpiresAt(conv.created_at) : null,
    };
  }
}

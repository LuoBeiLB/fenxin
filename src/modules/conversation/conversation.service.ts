import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { AppUser, sanitizeUser } from '../../entities/app-user.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';

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

  async listMyConversations(userId: string) {
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
      // MySQL 不支持 NULLS LAST，用 IS NULL 表达式实现同样效果（无消息的会话排最后）
      .orderBy('c.last_message_at IS NULL', 'ASC')
      .addOrderBy('c.last_message_at', 'DESC')
      .getMany();

    return Promise.all(
      conversations.map(async (conv) => {
        if (conv.type === 'private') {
          const members = await memberRepo.find({ where: { conversation_id: conv.id } });
          const otherUserId = members.map((m) => m.user_id).find((id) => id !== userId);
          if (otherUserId) {
            const otherUser = await userRepo.findOne({ where: { id: otherUserId } });
            if (otherUser) {
              return { ...conv, other_user: sanitizeUser(otherUser) };
            }
          }
        }
        return conv;
      }),
    );
  }

  async getConversation(conversationId: string, userId: string) {
    const membership = await this.dataSource.getRepository(ConversationMember).findOne({
      where: { conversation_id: conversationId, user_id: userId },
    });
    if (!membership) throw new ForbiddenException('Access denied to this conversation');

    const conv = await this.dataSource.getRepository(Conversation).findOne({
      where: { id: conversationId },
    });
    if (!conv) throw new NotFoundException('会话不存在');
    return conv;
  }
}

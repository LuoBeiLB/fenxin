import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { AppUser } from '../../entities/app-user.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';

/**
 * 个人频道（个人空间）P0：一人一个频道，纯广播模式。
 *
 * 与群聊的区别：
 *  - 频道 type='channel'（群聊 is_channel 布尔标的旧数据不受影响）
 *  - 订阅自主：广场发现 → subscribe 加入 / unsubscribe 退出，不需要频道主拉人
 *  - 纯广播：仅频道主（owner）能发消息（message.service.sendMessage 内统一拦截），
 *    订阅者只读；消息收发 / 历史 / WS 推送全部复用现有 conversation 通道
 *  - 全局搜索天然支持：searchGlobal 走 INNER JOIN conversation_members，未订阅者搜不到
 */
@Injectable()
export class ChannelService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
  ) {}

  /** 频道对外展示的 owner 信息（只挑安全字段，不带手机号等敏感信息） */
  private toOwnerInfo(owner: AppUser | null) {
    if (!owner) return null;
    return { id: owner.id, display_name: owner.display_name, avatar_url: owner.avatar_url };
  }

  /** 查频道实体：必须是 type='channel' 的会话，否则按不存在处理 */
  private async getChannelOr404(channelId: string): Promise<Conversation> {
    const conv = await this.dataSource.getRepository(Conversation).findOne({
      where: { id: channelId, type: 'channel' },
    });
    if (!conv) throw new NotFoundException('频道不存在');
    return conv;
  }

  /** 创建我的频道（一人一个）：自动把自己加为 owner 成员 */
  async createChannel(params: {
    name: string;
    description?: string;
    avatarUrl?: string;
    ownerId: string;
  }): Promise<Record<string, unknown>> {
    const convRepo = this.dataSource.getRepository(Conversation);
    const memberRepo = this.dataSource.getRepository(ConversationMember);

    const existing = await convRepo.findOne({
      where: { type: 'channel', owner_id: params.ownerId },
    });
    if (existing) throw new ConflictException('你已创建过频道，一人只能拥有一个频道');

    const saved = await convRepo.save(
      convRepo.create({
        type: 'channel',
        name: params.name,
        description: params.description ?? null,
        avatar_url: params.avatarUrl ?? null,
        owner_id: params.ownerId,
        member_count: 1,
      }),
    );

    await memberRepo.save(
      memberRepo.create({
        conversation_id: saved.id,
        user_id: params.ownerId,
        role: 'owner',
      }),
    );

    // 实时推送：频道创建，我的会话列表立即出现频道
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, [params.ownerId], {
      conversation_id: saved.id,
      reason: 'created',
    });

    const owner = await this.dataSource.getRepository(AppUser).findOne({ where: { id: params.ownerId } });
    return { ...saved, is_owner: true, is_subscribed: true, owner: this.toOwnerInfo(owner) };
  }

  /** 我的频道资料（未创建返回 404，前端引导去创建） */
  async getMyChannel(userId: string): Promise<Record<string, unknown>> {
    const conv = await this.dataSource.getRepository(Conversation).findOne({
      where: { type: 'channel', owner_id: userId },
    });
    if (!conv) throw new NotFoundException('你还没有创建频道');
    const owner = await this.dataSource.getRepository(AppUser).findOne({ where: { id: userId } });
    return { ...conv, is_owner: true, is_subscribed: true, owner: this.toOwnerInfo(owner) };
  }

  /** 修改频道资料（仅频道主） */
  async updateChannel(
    channelId: string,
    userId: string,
    patch: { name?: string; description?: string; avatarUrl?: string; visibility?: 'public' | 'private' },
  ): Promise<Record<string, unknown>> {
    const conv = await this.getChannelOr404(channelId);
    if (conv.owner_id !== userId) throw new ForbiddenException('仅频道主可以修改频道资料');

    const convRepo = this.dataSource.getRepository(Conversation);
    const updated = await convRepo.save(
      convRepo.merge(conv, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.avatarUrl !== undefined ? { avatar_url: patch.avatarUrl } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      }),
    );

    // 资料变更通知订阅者刷新（广场卡片/频道头部）
    const memberIds = await this.getMemberUserIds(channelId);
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, memberIds, {
      conversation_id: channelId,
      reason: 'updated',
    });

    const owner = await this.dataSource.getRepository(AppUser).findOne({ where: { id: userId } });
    return { ...updated, is_owner: true, is_subscribed: true, owner: this.toOwnerInfo(owner) };
  }

  /** 频道广场：全部公开频道，热门（订阅数）优先，带我的订阅状态 */
  async listDiscover(userId: string, page: number, pageSize: number) {
    const convRepo = this.dataSource.getRepository(Conversation);

    const [channels, total] = await convRepo
      .createQueryBuilder('c')
      .where("c.type = 'channel' AND c.visibility = 'public'")
      .orderBy('c.member_count', 'DESC')
      .addOrderBy('c.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    if (channels.length === 0) return { items: [], total, page, pageSize };

    const ownerIds = [...new Set(channels.map((c) => c.owner_id).filter((x): x is string => !!x))];
    const owners = ownerIds.length
      ? await this.dataSource.getRepository(AppUser).find({ where: { id: In(ownerIds) } })
      : [];
    const ownerMap = new Map(owners.map((o) => [o.id, o]));

    const mySubs = await this.dataSource.getRepository(ConversationMember).find({
      where: { user_id: userId, conversation_id: In(channels.map((c) => c.id)) },
    });
    const subSet = new Set(mySubs.map((m) => m.conversation_id));

    const items = channels.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      avatar_url: c.avatar_url,
      member_count: c.member_count,
      created_at: c.created_at,
      is_owner: c.owner_id === userId,
      is_subscribed: subSet.has(c.id),
      owner: this.toOwnerInfo(c.owner_id ? ownerMap.get(c.owner_id) ?? null : null),
    }));
    return { items, total, page, pageSize };
  }

  /** 频道详情：任何人可见元信息；消息不在本接口返回（未订阅者调 /messages/:id 会被 403） */
  async getChannelDetail(channelId: string, userId: string): Promise<Record<string, unknown>> {
    const conv = await this.getChannelOr404(channelId);
    const membership = await this.dataSource.getRepository(ConversationMember).findOne({
      where: { conversation_id: channelId, user_id: userId },
    });
    const owner = conv.owner_id
      ? await this.dataSource.getRepository(AppUser).findOne({ where: { id: conv.owner_id } })
      : null;

    return {
      id: conv.id,
      name: conv.name,
      description: conv.description,
      avatar_url: conv.avatar_url,
      member_count: conv.member_count,
      visibility: conv.visibility,
      ai_enabled: conv.ai_enabled,
      created_at: conv.created_at,
      last_message_at: conv.last_message_at,
      is_owner: conv.owner_id === userId,
      is_subscribed: !!membership,
      owner: this.toOwnerInfo(owner),
    };
  }

  /** 订阅频道（仅公开频道；幂等：已订阅直接返回成功） */
  async subscribe(channelId: string, userId: string) {
    const conv = await this.getChannelOr404(channelId);
    if (conv.visibility !== 'public') {
      throw new ForbiddenException('私密频道暂不支持自主订阅');
    }

    const memberRepo = this.dataSource.getRepository(ConversationMember);
    const existing = await memberRepo.findOne({
      where: { conversation_id: channelId, user_id: userId },
    });
    if (existing) return { conversation_id: channelId, subscribed: true };

    await memberRepo.save(
      memberRepo.create({ conversation_id: channelId, user_id: userId, role: 'member' }),
    );
    await this.dataSource.getRepository(Conversation).increment({ id: channelId }, 'member_count', 1);

    // 实时推送：订阅者的会话列表立即出现该频道
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, [userId], {
      conversation_id: channelId,
      reason: 'subscribed',
    });
    return { conversation_id: channelId, subscribed: true };
  }

  /** 退订频道（幂等；频道主不可退订自己的频道） */
  async unsubscribe(channelId: string, userId: string) {
    const conv = await this.getChannelOr404(channelId);
    if (conv.owner_id === userId) {
      throw new BadRequestException('频道主不能退订自己的频道');
    }

    const memberRepo = this.dataSource.getRepository(ConversationMember);
    const existing = await memberRepo.findOne({
      where: { conversation_id: channelId, user_id: userId },
    });
    if (!existing) return { conversation_id: channelId, subscribed: false };

    await memberRepo.remove(existing);
    await this.dataSource.getRepository(Conversation).decrement({ id: channelId }, 'member_count', 1);

    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, [userId], {
      conversation_id: channelId,
      reason: 'unsubscribed',
    });
    return { conversation_id: channelId, subscribed: false };
  }

  /** 频道全体成员的用户 ID 列表（用于 WS 定向推送） */
  private async getMemberUserIds(conversationId: string): Promise<string[]> {
    const members = await this.dataSource.getRepository(ConversationMember).find({
      where: { conversation_id: conversationId },
    });
    return members.map((m) => m.user_id);
  }
}

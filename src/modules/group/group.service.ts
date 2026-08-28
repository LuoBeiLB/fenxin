import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { Message } from '../../entities/message.entity';
import { AppUser, sanitizeUser } from '../../entities/app-user.entity';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';
import { WS_EVENTS } from '../events/events.types';

@Injectable()
export class GroupService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
  ) {}

  private async getMembership(conversationId: string, userId: string) {
    return this.dataSource.getRepository(ConversationMember).findOne({
      where: { conversation_id: conversationId, user_id: userId },
    });
  }

  /** 会话全体成员的用户 ID 列表（用于 WebSocket 定向推送） */
  private async getMemberUserIds(conversationId: string): Promise<string[]> {
    const members = await this.dataSource.getRepository(ConversationMember).find({
      where: { conversation_id: conversationId },
    });
    return members.map((m) => m.user_id);
  }

  private async assertOwnerOrAdmin(conversationId: string, userId: string, action: string) {
    const membership = await this.getMembership(conversationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new ForbiddenException(`Only group owner or admin can ${action}`);
    }
    return membership;
  }

  async createGroup(params: {
    name: string;
    description?: string;
    avatarUrl?: string;
    memberIds: string[];
    ownerId: string;
    isChannel?: boolean;
  }): Promise<Conversation> {
    const convRepo = this.dataSource.getRepository(Conversation);
    const memberRepo = this.dataSource.getRepository(ConversationMember);

    const savedConv = await convRepo.save(
      convRepo.create({
        type: 'group',
        name: params.name,
        description: params.description ?? null,
        avatar_url: params.avatarUrl ?? null,
        owner_id: params.ownerId,
        is_channel: params.isChannel ?? false,
      }),
    );

    const allMemberIds = [params.ownerId, ...params.memberIds.filter((id) => id !== params.ownerId)];
    await memberRepo.save(
      allMemberIds.map((id) =>
        memberRepo.create({
          conversation_id: savedConv.id,
          user_id: id,
          role: id === params.ownerId ? 'owner' : 'member',
        }),
      ),
    );

    await convRepo.update(savedConv.id, { member_count: allMemberIds.length });

    // 实时推送：新群创建，全体成员会话列表立即刷新
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, allMemberIds, {
      conversation_id: savedConv.id,
      reason: 'created',
    });

    return savedConv;
  }

  async addMembers(conversationId: string, memberIds: string[], operatorId: string): Promise<void> {
    await this.assertOwnerOrAdmin(conversationId, operatorId, 'add members');

    const memberRepo = this.dataSource.getRepository(ConversationMember);
    const convRepo = this.dataSource.getRepository(Conversation);

    const existingMembers = await memberRepo.find({ where: { conversation_id: conversationId } });
    const existingIds = new Set(existingMembers.map((m) => m.user_id));
    const newMemberIds = memberIds.filter((id) => !existingIds.has(id));
    if (newMemberIds.length === 0) return;

    await memberRepo.save(
      newMemberIds.map((id) =>
        memberRepo.create({ conversation_id: conversationId, user_id: id, role: 'member' }),
      ),
    );
    await convRepo.update(conversationId, { member_count: existingIds.size + newMemberIds.length });

    // 实时推送：成员变动（含被拉入的新成员），会话列表/人数立即刷新
    this.events.emitToUsers(
      WS_EVENTS.CONVERSATION_UPDATED,
      [...Array.from(existingIds), ...newMemberIds],
      { conversation_id: conversationId, reason: 'members' },
    );
  }

  async removeMember(conversationId: string, targetUserId: string, operatorId: string): Promise<void> {
    await this.assertOwnerOrAdmin(conversationId, operatorId, 'remove members');

    const memberRepo = this.dataSource.getRepository(ConversationMember);
    const targetMembership = await this.getMembership(conversationId, targetUserId);
    if (targetMembership?.role === 'owner') {
      throw new ForbiddenException('Cannot remove the group owner');
    }

    await memberRepo.delete({ conversation_id: conversationId, user_id: targetUserId });
    const remainingCount = await memberRepo.count({ where: { conversation_id: conversationId } });
    await this.dataSource.getRepository(Conversation).update(conversationId, { member_count: remainingCount });

    // 实时推送：成员变动（剩余成员刷新人数；被移出的用户刷新列表后该会话消失）
    const remainingIds = await memberRepo.find({ where: { conversation_id: conversationId } });
    this.events.emitToUsers(
      WS_EVENTS.CONVERSATION_UPDATED,
      [targetUserId, ...remainingIds.map((m) => m.user_id)],
      { conversation_id: conversationId, reason: 'members' },
    );
  }

  async setMemberRole(
    conversationId: string,
    targetUserId: string,
    role: 'admin' | 'member',
    operatorId: string,
  ): Promise<void> {
    const conv = await this.dataSource.getRepository(Conversation).findOne({
      where: { id: conversationId },
    });
    if (conv?.dissolved_at) throw new BadRequestException('群组已解散，不能执行管理操作');
    const operatorMembership = await this.getMembership(conversationId, operatorId);
    if (operatorMembership?.role !== 'owner') {
      throw new ForbiddenException('Only group owner can set admin role');
    }
    const target = await this.getMembership(conversationId, targetUserId);
    if (!target) throw new NotFoundException('目标用户不在群内');

    await this.dataSource
      .getRepository(ConversationMember)
      .update({ conversation_id: conversationId, user_id: targetUserId }, { role });
  }

  async updateGroupInfo(
    conversationId: string,
    updates: { name?: string; description?: string; avatarUrl?: string },
    operatorId: string,
  ): Promise<Conversation> {
    await this.assertOwnerOrAdmin(conversationId, operatorId, 'update group info');

    const convRepo = this.dataSource.getRepository(Conversation);
    const updateData: Partial<Conversation> = {};
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.avatarUrl !== undefined) updateData.avatar_url = updates.avatarUrl;

    await convRepo.update(conversationId, updateData);
    const updated = await convRepo.findOne({ where: { id: conversationId } });
    if (!updated) throw new NotFoundException('群组不存在');

    // 实时推送：群资料变更（群名/描述/头像会影响会话列表展示）
    const memberIds = await this.getMemberUserIds(conversationId);
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, memberIds, {
      conversation_id: conversationId,
      reason: 'info',
    });

    return updated;
  }

  /**
   * 群成员列表。
   * - 群成员可查；管理员（role=admin）可查看任意群（配合管理后台群组管理）。
   * - 已停用 / 已注销（软删除）的成员不返回；成员关系记录保留，账号恢复启用后自动重新出现。
   */
  async getGroupMembers(conversationId: string, requesterId: string, requesterRole?: string) {
    if (requesterRole !== 'admin') {
      const membership = await this.getMembership(conversationId, requesterId);
      if (!membership) throw new ForbiddenException('Access denied to this conversation');
    }

    const members = await this.dataSource.getRepository(ConversationMember).find({
      where: { conversation_id: conversationId },
      order: { role: 'ASC' },
    });
    if (members.length === 0) return [];

    // 批量取账号信息，过滤已停用 / 已注销成员（避免逐条查询）
    const userRepo = this.dataSource.getRepository(AppUser);
    const activeUsers = await userRepo.find({
      where: { id: In(members.map((m) => m.user_id)), status: 'active', deleted_at: IsNull() },
    });
    const userMap = new Map(activeUsers.map((u) => [u.id, sanitizeUser(u)]));

    return members
      .filter((member) => userMap.has(member.user_id))
      .map((member) => {
        const safe = userMap.get(member.user_id);
        return {
          ...member,
          user_display_name: safe?.display_name || 'Unknown',
          user_avatar_url: safe?.avatar_url ?? null,
        };
      });
  }

  /**
   * 管理员：全量群组列表（管理后台群组管理页）。
   * 默认只返回未解散群；include_dissolved=true 时包含已解散（回收站/审计视图）。
   */
  async adminListGroups(params: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    includeDissolved?: boolean;
  }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;

    const qb = this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c')
      .where("c.type = 'group'");

    if (!params.includeDissolved) {
      qb.andWhere('c.dissolved_at IS NULL');
    }
    if (params.keyword) {
      qb.andWhere('c.name LIKE :kw', { kw: `%${params.keyword}%` });
    }

    qb.orderBy('c.created_at', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    const [groups, total] = await qb.getManyAndCount();

    // 批量补群主姓名（一次 IN 查询，避免 N+1）
    const ownerIds = [...new Set(groups.map((g) => g.owner_id).filter((id): id is string => !!id))];
    const owners = ownerIds.length
      ? await this.dataSource.getRepository(AppUser).find({
          where: ownerIds.map((id) => ({ id })),
          select: ['id', 'display_name', 'phone'],
        })
      : [];
    const ownerMap = new Map(owners.map((u) => [u.id, u]));

    const data = groups.map((g) => ({
      ...g,
      owner_display_name: g.owner_id ? (ownerMap.get(g.owner_id)?.display_name ?? null) : null,
      owner_phone: g.owner_id ? (ownerMap.get(g.owner_id)?.phone ?? null) : null,
      is_dissolved: !!g.dissolved_at,
    }));

    return { data, total };
  }

  /**
   * 管理员：强制解散群（软解散）。标记 dissolved_at，成员不可再发消息、
   * 会话从成员列表消失；消息与成员记录保留供审计。操作实时推送给全体成员。
   */
  async dissolveGroup(conversationId: string, operatorId: string, ip?: string) {
    const convRepo = this.dataSource.getRepository(Conversation);
    const conv = await convRepo.findOne({ where: { id: conversationId, type: 'group' } });
    if (!conv) throw new NotFoundException('群组不存在');
    if (conv.dissolved_at) throw new BadRequestException('该群组已被解散');

    await convRepo.update(conversationId, { dissolved_at: new Date() });

    // 实时推送：群被解散，全体成员会话列表立即移除该群
    const memberIds = await this.getMemberUserIds(conversationId);
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, memberIds, {
      conversation_id: conversationId,
      reason: 'dissolved',
    });

    await this.audit.log({
      userId: operatorId,
      action: 'dissolve_group',
      targetType: 'conversation',
      targetId: conversationId,
      detail: `Dissolved group "${conv.name ?? conversationId}" (${memberIds.length} members)`,
      ipAddress: ip,
    });
  }

  /**
   * 群主解散自己的群（解散即焚语义）：
   * ① 群标记 dissolved_at/dissolved_by，成员立即不可再发消息；
   * ② 全群消息 destroy_at 置为解散时刻——列表查询立即不可见，
   *    下一分钟由 BurnScheduler 统一物理清除（含磁盘附件），与单条焚毁同一条链路；
   * ③ WS 推 conversation:updated(dissolved)，全体成员会话列表移除该群。
   * 与管理员强制解散的区别：管理员版保留消息供审计留痕，本版消息焚毁。
   */
  async dissolveGroupByOwner(conversationId: string, operatorId: string) {
    const convRepo = this.dataSource.getRepository(Conversation);
    const conv = await convRepo.findOne({ where: { id: conversationId, type: 'group' } });
    if (!conv) throw new NotFoundException('群组不存在');
    if (conv.dissolved_at) throw new BadRequestException('该群组已被解散');
    if (conv.owner_id !== operatorId) throw new ForbiddenException('仅群主可解散群');

    const dissolvedAt = new Date();
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(Conversation).update(conversationId, {
        dissolved_at: dissolvedAt,
        dissolved_by: operatorId,
      });
      // 到期时间设为解散时刻 → 消息立即对成员不可见，等待 BurnScheduler 物理清除
      await em
        .createQueryBuilder()
        .update(Message)
        .set({ destroy_at: dissolvedAt })
        .where('conversation_id = :conversationId', { conversationId })
        .andWhere('is_destroyed = :destroyed', { destroyed: false })
        .execute();
    });

    // 实时推送：群被解散，全体成员会话列表立即移除该群
    const memberIds = await this.getMemberUserIds(conversationId);
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, memberIds, {
      conversation_id: conversationId,
      reason: 'dissolved',
    });

    await this.audit.log({
      userId: operatorId,
      action: 'dissolve_group_by_owner',
      targetType: 'conversation',
      targetId: conversationId,
      detail: `Owner dissolved group "${conv.name ?? conversationId}" (${memberIds.length} members, messages scheduled for burn)`,
    });
  }
}

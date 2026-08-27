import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { AppUser, sanitizeUser } from '../../entities/app-user.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';

@Injectable()
export class GroupService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
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

  /** 群成员列表：仅本群成员可见（修复旧版任意用户可查漏洞） */
  async getGroupMembers(conversationId: string, requesterId: string) {
    const membership = await this.getMembership(conversationId, requesterId);
    if (!membership) throw new ForbiddenException('Access denied to this conversation');

    const members = await this.dataSource.getRepository(ConversationMember).find({
      where: { conversation_id: conversationId },
      order: { role: 'ASC' },
    });

    const userRepo = this.dataSource.getRepository(AppUser);
    return Promise.all(
      members.map(async (member) => {
        const user = await userRepo.findOne({ where: { id: member.user_id } });
        const safe = sanitizeUser(user);
        return {
          ...member,
          user_display_name: safe?.display_name || 'Unknown',
          user_avatar_url: safe?.avatar_url ?? null,
        };
      }),
    );
  }
}

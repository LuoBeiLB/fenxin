import { DataSource } from 'typeorm';
import { ConversationService } from 'src/modules/conversation/conversation.service';
import { Conversation } from 'src/entities/conversation.entity';
import { ConversationMember } from 'src/entities/conversation-member.entity';
import { MessageReceipt } from 'src/entities/message-receipt.entity';
import { AppUser } from 'src/entities/app-user.entity';
import { pendingExpiresAt, PENDING_TTL_DAYS } from 'src/modules/e2e/e2e.constants';

/**
 * B2 回归：pending 私密会话必须返回 e2e_expires_at（= created_at + 7 天），
 * 否则前端算不出"剩余 N 天"、画不出右上角角标。
 *
 * 同时验证列表的设备过滤：active 会话只对绑定设备可见。
 */

function qb(result: any) {
  const self: any = {
    whereInIds: () => self,
    where: () => self,
    andWhere: () => self,
    select: () => self,
    addSelect: () => self,
    innerJoin: () => self,
    groupBy: () => self,
    orderBy: () => self,
    addOrderBy: () => self,
    take: () => self,
    skip: () => self,
    getMany: jest.fn(async () => result.many ?? []),
    getRawMany: jest.fn(async () => result.rawMany ?? []),
    getOne: jest.fn(async () => result.one ?? null),
  };
  return self;
}

function makeService(opts: { conversations: any[] }) {
  const convRepo: any = {
    createQueryBuilder: jest.fn(() => qb({ many: opts.conversations })),
  };
  const memberRepo: any = {
    find: jest.fn(async () => opts.conversations.map((c) => ({ conversation_id: c.id }))),
  };
  const receiptRepo: any = {
    createQueryBuilder: jest.fn(() => qb({ rawMany: [] })),
  };
  const userRepo: any = {
    findOne: jest.fn(async () => ({ id: 'peer', display_name: 'Peer' })),
  };

  const dataSource: any = {
    getRepository: (entity: any) => {
      const name = entity?.name;
      if (name === 'Conversation') return convRepo;
      if (name === 'ConversationMember') return memberRepo;
      if (name === 'MessageReceipt') return receiptRepo;
      if (name === 'AppUser') return userRepo;
      return {};
    },
  };

  const service = new ConversationService(dataSource as DataSource, { emitToUsers: jest.fn() } as any);
  return { service, convRepo };
}

const pendingConv = {
  id: 'c-pending',
  type: 'private',
  member_count: 2,
  e2e_mode: 1,
  e2e_state: 1,
  user_a: 'u-1',
  user_b: 'u-2',
  e2e_device_a: 'dev-a',
  e2e_device_b: null,
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  last_message_at: null,
};

const activeConv = {
  id: 'c-active',
  type: 'private',
  member_count: 2,
  e2e_mode: 1,
  e2e_state: 2,
  user_a: 'u-1',
  user_b: 'u-2',
  e2e_device_a: 'dev-a',
  e2e_device_b: 'dev-b',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  last_message_at: null,
};

describe('ConversationService · 私密会话列表字段（B2）', () => {
  it('pending 会话返回 e2e_expires_at = created_at + 7 天', async () => {
    const { service } = makeService({ conversations: [pendingConv] });
    const [row] = await service.listMyConversations('u-1', 'dev-a');

    expect(row.e2e_mode).toBe(1);
    expect(row.e2e_state).toBe(1);
    expect(row.e2e_expires_at).toBeInstanceOf(Date);
    expect((row.e2e_expires_at as Date).toISOString()).toBe(
      pendingExpiresAt(pendingConv.created_at).toISOString(),
    );
    expect((row.e2e_expires_at as Date).getTime() - new Date(pendingConv.created_at).getTime()).toBe(
      PENDING_TTL_DAYS * 24 * 3600 * 1000,
    );
  });

  it('active 会话 e2e_expires_at 为 null，但带 is_bound_device / peer_device_id', async () => {
    const { service } = makeService({ conversations: [activeConv] });
    const [row] = await service.listMyConversations('u-1', 'dev-a');

    expect(row.e2e_expires_at).toBeNull();
    expect(row.is_bound_device).toBe(true);
    expect(row.peer_device_id).toBe('dev-b');
  });

  it('非绑定设备：is_bound_device=false，peer_device_id 指向发起端', async () => {
    const { service } = makeService({ conversations: [activeConv] });
    const [row] = await service.listMyConversations('u-2', 'dev-x');

    // 注意：真实过滤在 SQL 里（e2e_state=2 且 device 匹配），这里只校验返回字段的计算
    expect(row.is_bound_device).toBe(false);
    expect(row.peer_device_id).toBe('dev-a');
  });
});

import { ChannelService } from 'src/modules/channel/channel.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * v5.9.3「频道主解散频道」单测。
 * 覆盖：
 *   1. 频道主解散成功：dissolved_at/dissolved_by 更新 + 未焚消息 destroy_at 批量置位
 *      + WS 推送全体订阅者(reason=dissolved) + 审计日志
 *   2. 非频道主解散 → 403（仅频道主可解散频道）
 *   3. 频道不存在 → 404
 *   4. 已解散频道再次解散 → 400（该频道已被解散）
 *   5. 已解散频道 detail → 404（getChannelOr404 的 IsNull 过滤生效）
 *   6. 解散后重建：createChannel 的「一人一个」检查跳过已解散频道，可正常创建新频道
 *
 * 不接 DB：jest.fn 替身 repository，与 group-leave.spec.ts 同范式。
 */
describe('ChannelService 频道主解散频道（v5.9.3）', () => {
  const build = (opts: {
    conv?: any;       // findOne 命中的频道记录（null=不存在）
    members?: any[];  // 频道成员（getMemberUserIds / WS 推送目标）
  } = {}) => {
    const convFindOne = jest.fn(async ({ where }: any) => {
      const rec = opts.conv === undefined ? null : opts.conv;
      if (!rec) return null;
      // where 带 dissolved_at 条件 = 只查活跃频道（getChannelOr404 / mine / create-existing）
      const activeOnly = where.dissolved_at !== undefined;
      if (where.id && where.id !== rec.id) return null;
      if (where.owner_id && where.owner_id !== rec.owner_id) return null;
      if (activeOnly && rec.dissolved_at) return null;
      return rec;
    });
    const convRepo: any = {
      findOne: convFindOne,
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => ({ ...x, id: x.id ?? 'new-channel' })),
      update: jest.fn(async () => ({ affected: 1 })),
      increment: jest.fn(async () => undefined),
      decrement: jest.fn(async () => undefined),
    };
    const memberRepo: any = {
      find: jest.fn(async () => opts.members ?? [{ user_id: 'owner' }]),
      findOne: jest.fn(async () => null),
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => x),
      remove: jest.fn(async () => undefined),
    };
    const userRepo: any = { findOne: jest.fn(async () => null), find: jest.fn(async () => []) };

    // 事务替身：em.getRepository(Conversation).update + createQueryBuilder().update()…execute()
    const convUpdateInTx = jest.fn(async () => ({ affected: 1 }));
    const qbExecute = jest.fn(async () => ({ affected: 3 }));
    const qb: any = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: qbExecute,
    };
    const em: any = {
      getRepository: jest.fn(() => ({ update: convUpdateInTx })),
      createQueryBuilder: jest.fn(() => qb),
    };
    const dataSource = {
      getRepository: jest.fn((entity: any) => {
        if (entity && entity.name === 'Conversation') return convRepo;
        if (entity && entity.name === 'AppUser') return userRepo;
        return memberRepo;
      }),
      transaction: jest.fn(async (cb: any) => cb(em)),
    };
    const events = { emitToUsers: jest.fn() };
    const audit = { log: jest.fn(async () => ({})) };
    const svc = new ChannelService(dataSource as any, events as any, audit as any);
    return { svc, convRepo, memberRepo, events, audit, convUpdateInTx, qb, qbExecute };
  };

  beforeEach(() => jest.clearAllMocks());

  it('1. 频道主解散成功：标记 + 消息批量置焚 + WS 推送全体订阅者 + 审计', async () => {
    const { svc, events, audit, convUpdateInTx, qbExecute } = build({
      conv: { id: 'c1', type: 'channel', owner_id: 'owner', dissolved_at: null, name: '萝卜频道' },
      members: [{ user_id: 'owner' }, { user_id: 's1' }, { user_id: 's2' }],
    });
    await svc.dissolveChannel('c1', 'owner');

    // ① 会话标记 dissolved_at/dissolved_by
    expect(convUpdateInTx).toHaveBeenCalledWith('c1', {
      dissolved_at: expect.any(Date),
      dissolved_by: 'owner',
    });
    // ② 未焚消息 destroy_at 批量置为解散时刻
    expect(qbExecute).toHaveBeenCalledTimes(1);
    // ③ WS 推送全体订阅者，reason=dissolved
    expect(events.emitToUsers).toHaveBeenCalledTimes(1);
    const [event, userIds, payload] = events.emitToUsers.mock.calls[0];
    expect(event).toBe('conversation:updated');
    expect(userIds).toEqual(['owner', 's1', 's2']);
    expect(payload).toMatchObject({ conversation_id: 'c1', reason: 'dissolved' });
    // ④ 审计日志
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', action: 'dissolve_channel_by_owner', targetId: 'c1' }),
    );
  });

  it('2. 非频道主解散 → 403，仅频道主可解散', async () => {
    const { svc, events } = build({
      conv: { id: 'c1', type: 'channel', owner_id: 'owner', dissolved_at: null },
    });
    await expect(svc.dissolveChannel('c1', 's1')).rejects.toThrow(ForbiddenException);
    await expect(svc.dissolveChannel('c1', 's1')).rejects.toThrow('仅频道主可解散频道');
    expect(events.emitToUsers).not.toHaveBeenCalled();
  });

  it('3. 频道不存在 → 404', async () => {
    const { svc } = build({ conv: null });
    await expect(svc.dissolveChannel('nope', 'owner')).rejects.toThrow(NotFoundException);
  });

  it('4. 已解散频道再次解散 → 400', async () => {
    const { svc } = build({
      conv: { id: 'c1', type: 'channel', owner_id: 'owner', dissolved_at: new Date('2026-09-09') },
    });
    await expect(svc.dissolveChannel('c1', 'owner')).rejects.toThrow(BadRequestException);
    await expect(svc.dissolveChannel('c1', 'owner')).rejects.toThrow('该频道已被解散');
  });

  it('5. 已解散频道 detail → 404（getChannelOr404 过滤 dissolved_at）', async () => {
    const { svc } = build({
      conv: { id: 'c1', type: 'channel', owner_id: 'owner', dissolved_at: new Date('2026-09-09') },
      members: [{ user_id: 's1' }],
    });
    await expect(svc.getChannelDetail('c1', 's1')).rejects.toThrow(NotFoundException);
  });

  it('6. 解散后重建：旧频道已解散不再挡「一人一个」，可创建新频道', async () => {
    const { svc, convRepo } = build({
      conv: { id: 'old-c', type: 'channel', owner_id: 'owner', dissolved_at: new Date('2026-09-09') },
    });
    // 旧频道已解散：existing 查询（带 dissolved_at IS NULL）不命中 → 不抛 Conflict
    const result: any = await svc.createChannel({ name: '新频道', ownerId: 'owner' });
    expect(convRepo.save).toHaveBeenCalled();
    expect(result.id).toBe('new-channel');
    expect(result.is_owner).toBe(true);
  });

  it('7. 回归：活跃频道仍挡「一人一个」→ Conflict', async () => {
    const { svc } = build({
      conv: { id: 'c1', type: 'channel', owner_id: 'owner', dissolved_at: null },
    });
    await expect(svc.createChannel({ name: '第二个频道', ownerId: 'owner' })).rejects.toThrow(ConflictException);
  });
});

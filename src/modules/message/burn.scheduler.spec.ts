import { BurnScheduler } from './burn.scheduler';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { Message } from '../../entities/message.entity';

/**
 * BurnScheduler（V6.0 两阶段销毁·阶段①）单测。
 *
 * 核心断言：
 *  - 只"标记"（UPDATE is_destroyed=1 + destroyed_at + destroy_reason），**绝不 DELETE**
 *  - R1（兜底到期）/ R2（阅读完成 n-1）两条规则各查一次
 *  - 标记后按会话广播 WS message:destroyed
 *  - 幂等：只选 is_destroyed=0 的行
 *  - 阶段②（真删）交给 DestroyService，调度器只做每小时兜底调用
 */

type Row = { id: string; conversation_id: string };

function makeScheduler(batches: Row[][]) {
  let call = 0;
  const getMany = jest.fn(async () => batches[call++] ?? []);

  const selectQb: any = {
    select: jest.fn(() => selectQb),
    where: jest.fn(() => selectQb),
    orderBy: jest.fn(() => selectQb),
    take: jest.fn(() => selectQb),
    getMany,
  };
  const updateQb: any = {
    update: jest.fn(() => updateQb),
    set: jest.fn(() => updateQb),
    whereInIds: jest.fn(() => updateQb),
    andWhere: jest.fn(() => updateQb),
    execute: jest.fn(async () => ({ affected: 1 })),
  };

  const msgRepo = {
    createQueryBuilder: jest.fn((alias?: string) => (alias ? selectQb : updateQb)),
  };
  const memberRepo = {
    find: jest.fn(async () => [{ user_id: 'u1' }, { user_id: 'u2' }]),
  };
  const dataSource: any = {
    getRepository: (entity: any) => {
      if (entity === ConversationMember) return memberRepo;
      if (entity === Message) return msgRepo;
      return {};
    },
  };
  const events: any = { emitToUsers: jest.fn() };
  const destroyService: any = {
    purgeConfirmedOrExpired: jest.fn(async () => ({ acked: 0, expired: 0 })),
  };

  const scheduler = new BurnScheduler(dataSource, events, destroyService);
  return { scheduler, events, destroyService, msgRepo, selectQb, updateQb, getMany, memberRepo };
}

describe('BurnScheduler · 阶段①标记（V6.0）', () => {
  it('没有到期的消息 → 不 UPDATE、不广播', async () => {
    const { scheduler, updateQb, events } = makeScheduler([[], []]);
    await scheduler.markDestroyed();
    expect(updateQb.execute).not.toHaveBeenCalled();
    expect(events.emitToUsers).not.toHaveBeenCalled();
  });

  it('R1 兜底到期 → 标记 is_destroyed/destroyed_at/destroy_reason=fallback_expired', async () => {
    const { scheduler, updateQb, events } = makeScheduler([
      [{ id: 'm1', conversation_id: 'c1' }],
      [],
    ]);
    await scheduler.markDestroyed();

    expect(updateQb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        is_destroyed: true,
        destroy_reason: 'fallback_expired',
        destroyed_at: expect.any(Date),
      }),
    );
    // 绝不物理删除：调度器不再持有删除逻辑
    expect((updateQb as any).delete).toBeUndefined();

    expect(events.emitToUsers).toHaveBeenCalledWith(
      'message:destroyed',
      ['u1', 'u2'],
      expect.objectContaining({
        conversation_id: 'c1',
        message_ids: ['m1'],
        reason: 'fallback_expired',
      }),
    );
  });

  it('R2 阅读完成 → reason=all_read，并按会话分组广播', async () => {
    const { scheduler, updateQb, events } = makeScheduler([
      [],
      [
        { id: 'm1', conversation_id: 'c1' },
        { id: 'm2', conversation_id: 'c1' },
        { id: 'm3', conversation_id: 'c2' },
      ],
    ]);
    await scheduler.markDestroyed();

    expect(updateQb.set).toHaveBeenCalledWith(
      expect.objectContaining({ destroy_reason: 'all_read' }),
    );
    const calls = (events.emitToUsers as jest.Mock).mock.calls;
    const c1 = calls.find((c) => c[2] && c[2].conversation_id === 'c1');
    const c2 = calls.find((c) => c[2] && c[2].conversation_id === 'c2');
    expect(c1[2].message_ids).toEqual(['m1', 'm2']);
    expect(c2[2].message_ids).toEqual(['m3']);
  });

  it('幂等：两条规则的 WHERE 都限定 is_destroyed = false', async () => {
    const { scheduler, selectQb } = makeScheduler([[], []]);
    await scheduler.markDestroyed();
    const sqls = (selectQb.where as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) expect(sql).toContain('m.is_destroyed');
    const params = (selectQb.where as jest.Mock).mock.calls.map((c) => c[1]);
    for (const p of params) expect(p).toMatchObject({ destroyed: false, now: expect.any(Date) });
  });

  it('R2 的 SQL 体现 n-1 语义（非发送方 + 已点开 + 已到期）', async () => {
    const { scheduler, selectQb } = makeScheduler([[], []]);
    await scheduler.markDestroyed();
    const r2 = String((selectQb.where as jest.Mock).mock.calls[1][0]);
    expect(r2).toContain('r.user_id <> m.sender_id');
    expect(r2).toContain('r.revealed_at IS NULL');
    expect(r2).toContain('r.burn_at > :now');
    expect(r2).toContain('m.burn_ttl_seconds IS NOT NULL');
  });
});

describe('BurnScheduler · 阶段②兜底（V6.0）', () => {
  it('purgeSweep → 调用 DestroyService.purgeConfirmedOrExpired', async () => {
    const { scheduler, destroyService } = makeScheduler([[], []]);
    await scheduler.purgeSweep();
    expect(destroyService.purgeConfirmedOrExpired).toHaveBeenCalledTimes(1);
  });

  it('DestroyService 抛错不影响调度器（只记日志）', async () => {
    const { scheduler, destroyService } = makeScheduler([[], []]);
    destroyService.purgeConfirmedOrExpired.mockRejectedValueOnce(new Error('db down'));
    await expect(scheduler.purgeSweep()).resolves.toBeUndefined();
  });
});

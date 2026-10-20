import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DestroyService } from './destroy.service';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { MessageTombstone } from '../../entities/message-tombstone.entity';
import { MessageDestroyAck } from '../../entities/message-destroy-ack.entity';

/**
 * DestroyService（V6.0 两阶段销毁·阶段②）单测。
 *
 * 核心断言：
 *  - purge 是**唯一**物理删除入口：只接受 is_destroyed=1 的消息；事务内写墓碑 + 清从属数据 + 删行
 *  - 幂等：消息不存在 / 未标记 → 直接返回 false，不产生任何写操作
 *  - ack 校验：非成员 403；未焚毁 400；不存在的 id 跳过
 *  - 私聊确认即真删；群聊按阈值（默认 1）
 */

type AnyMock = Record<string, jest.Mock>;

function qb(rows: any[] = []) {
  const q: any = {};
  ['select', 'where', 'andWhere', 'orderBy', 'take', 'groupBy', 'addSelect', 'innerJoin'].forEach((k) => {
    q[k] = jest.fn(() => q);
  });
  q.getMany = jest.fn(async () => rows);
  q.getRawMany = jest.fn(async () => []);
  q.getOne = jest.fn(async () => rows[0] ?? null);
  return q;
}

function makeService(opts: {
  message?: any;
  msgsInConv?: any[];
  membership?: any;
  conv?: any;
  ackCount?: number;
  memberNeed?: number;
  pendingRows?: any[];
} = {}) {
  const msgRepo: AnyMock = {
    findOne: jest.fn(async () => (opts.message === undefined ? null : opts.message)),
    createQueryBuilder: jest.fn((alias?: string) =>
      alias ? qb(opts.msgsInConv ?? []) : qb(),
    ),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const receiptRepo: AnyMock = { delete: jest.fn(), find: jest.fn(async () => []) };
  const memberRepo: AnyMock = {
    findOne: jest.fn(async () => (opts.membership === undefined ? { user_id: 'u1' } : opts.membership)),
    createQueryBuilder: jest.fn(() => {
      const q = qb();
      q.getCount = jest.fn(async () => opts.memberNeed ?? 0);
      return q;
    }),
  };
  const convRepo: AnyMock = { findOne: jest.fn(async () => opts.conv ?? { id: 'c1', type: 'private' }) };
  const ackRepo: AnyMock = {
    upsert: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(async () => opts.ackCount ?? 1),
  };
  const tombRepo: AnyMock = { upsert: jest.fn() };

  const emRepos: Record<string, AnyMock> = {
    MessageTombstone: tombRepo,
    MessageDestroyAck: ackRepo,
    MessageReceipt: receiptRepo,
    Message: msgRepo,
  };

  const dataSource: any = {
    getRepository: (entity: any) => {
      const name = entity?.name;
      if (name === 'Message') return msgRepo;
      if (name === 'MessageReceipt') return receiptRepo;
      if (name === 'ConversationMember') return memberRepo;
      if (name === 'Conversation') return convRepo;
      if (name === 'MessageDestroyAck') return ackRepo;
      if (name === 'MessageTombstone') return tombRepo;
      return {};
    },
    transaction: jest.fn(async (cb: any) =>
      cb({ getRepository: (entity: any) => emRepos[entity?.name] ?? {} }),
    ),
  };

  const oss: any = {
    enabled: false,
    deleteByUrl: jest.fn(async () => undefined),
    deleteByKey: jest.fn(async () => undefined),
  };

  const service = new DestroyService(dataSource as DataSource, oss);
  return { service, dataSource, msgRepo, receiptRepo, memberRepo, convRepo, ackRepo, tombRepo, oss };
}

const baseMsg = {
  id: 'm1',
  conversation_id: 'c1',
  sender_id: 'u1',
  type: 'text',
  created_at: new Date('2026-10-01T00:00:00Z'),
  is_destroyed: true,
  destroyed_at: new Date('2026-10-20T00:00:00Z'),
  destroy_reason: 'all_read',
  file_url: null,
  file_original_url: null,
};

describe('DestroyService.purge（唯一物理删除入口）', () => {
  it('消息不存在 → false，且不产生任何写操作', async () => {
    const { service, dataSource, tombRepo } = makeService({ message: null });
    await expect(service.purge('nope', 'manual')).resolves.toBe(false);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(tombRepo.upsert).not.toHaveBeenCalled();
  });

  it('消息未标记焚毁 → false（不能绕过阶段①直接真删）', async () => {
    const { service, dataSource } = makeService({ message: { ...baseMsg, is_destroyed: false } });
    await expect(service.purge('m1', 'manual')).resolves.toBe(false);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('正常路径：写墓碑 + 删确认/回执 + 断引用 + 删行', async () => {
    const { service, dataSource, tombRepo, ackRepo, receiptRepo, msgRepo } = makeService({
      message: { ...baseMsg },
    });
    await expect(service.purge('m1', 'ack_by_user')).resolves.toBe(true);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(tombRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'm1',
        conversation_id: 'c1',
        sender_id: 'u1',
        destroy_reason: 'all_read',
      }),
      ['id'],
    );
    expect(ackRepo.delete).toHaveBeenCalledWith({ message_id: 'm1' });
    expect(receiptRepo.delete).toHaveBeenCalledWith({ message_id: 'm1' });
    expect(msgRepo.update).toHaveBeenCalledWith({ reply_to_id: 'm1' }, { reply_to_id: null });
    expect(msgRepo.delete).toHaveBeenCalledWith({ id: 'm1' });
  });

  it('附件清理：OSS URL 走 deleteByUrl；本地路径不影响主流程', async () => {
    const { service, oss } = makeService({
      message: {
        ...baseMsg,
        file_url: 'https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/a.png?sig=1',
        file_original_url: '/uploads/definitely-not-exist-xyz.png',
      },
    });
    await expect(service.purge('m1', 'manual')).resolves.toBe(true);
    expect(oss.deleteByUrl).toHaveBeenCalledTimes(1);
    expect(oss.deleteByUrl).toHaveBeenCalledWith(
      'https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/a.png?sig=1',
    );
  });
});

describe('DestroyService.listPending（待确认列表）', () => {
  it('非会话成员 → Forbidden', async () => {
    const { service } = makeService({ membership: null });
    await expect(service.listPending('c1', 'u-x')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('返回待确认元数据（不含内容）+ has_attachment', async () => {
    const { service } = makeService({
      pendingRows: [{ id: 'm1', destroy_reason: 'all_read', destroyed_at: new Date(), file_url: '/uploads/a.png', file_original_url: null }],
    });
    // makeService 的 QB 默认返回 pendingRows（通过 msgsInConv 传入）
    const { service: svc2 } = makeService({
      msgsInConv: [
        { id: 'm1', destroy_reason: 'all_read', destroyed_at: new Date(), file_url: '/uploads/a.png', file_original_url: null },
      ],
    });
    const r = await svc2.listPending('c1', 'u1');
    expect(r.total).toBe(1);
    expect(r.pending[0]).toMatchObject({ message_id: 'm1', has_attachment: true });
    expect(r.pending[0]).not.toHaveProperty('content');
    // 未使用的第一个实例，避免 lint 噪音
    expect(service).toBeDefined();
  });
});

describe('DestroyService.ack（前端确认）', () => {
  it('非成员 → Forbidden', async () => {
    const { service } = makeService({ membership: null });
    await expect(
      service.ack({ conversationId: 'c1', userId: 'u-x', messageIds: ['m1'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('对未焚毁消息确认 → 400', async () => {
    const { service } = makeService({
      msgsInConv: [{ ...baseMsg, is_destroyed: false }],
      conv: { id: 'c1', type: 'private' },
    });
    await expect(
      service.ack({ conversationId: 'c1', userId: 'u1', messageIds: ['m1'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('私聊：确认后立即真删（purge 被调用）', async () => {
    const { service, ackRepo } = makeService({
      msgsInConv: [{ ...baseMsg }],
      conv: { id: 'c1', type: 'private' },
      ackCount: 1,
    });
    const purgeSpy = jest.spyOn(service, 'purge').mockResolvedValue(true);

    const r = await service.ack({ conversationId: 'c1', userId: 'u1', messageIds: ['m1'] });

    expect(ackRepo.upsert).toHaveBeenCalled();
    expect(purgeSpy).toHaveBeenCalledWith('m1', 'ack_by_user');
    expect(r).toEqual({ acked: 1, purged: 1, purged_ids: ['m1'] });
  });

  it('群聊：确认人数未达阈值 → 只记录不真删', async () => {
    const { service } = makeService({
      msgsInConv: [{ ...baseMsg }],
      conv: { id: 'c1', type: 'group' },
      ackCount: 0,
    });
    const purgeSpy = jest.spyOn(service, 'purge').mockResolvedValue(true);

    const r = await service.ack({ conversationId: 'c1', userId: 'u1', messageIds: ['m1'] });

    expect(purgeSpy).not.toHaveBeenCalled();
    expect(r.purged).toBe(0);
  });
});

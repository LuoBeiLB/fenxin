import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MessageService } from 'src/modules/message/message.service';
import { EventsGateway } from 'src/modules/events/events.gateway';
import { OssService } from 'src/modules/upload/oss.service';
import { PushService } from 'src/modules/push/push.service';
import { Message } from 'src/entities/message.entity';
import { MessageReceipt } from 'src/entities/message-receipt.entity';
import { Conversation } from 'src/entities/conversation.entity';
import { ConversationMember } from 'src/entities/conversation-member.entity';

/**
 * 按消息 id 标记已读（V6.1）单测 —— 对齐 READ_UNREAD_API.md §2。
 *
 * 覆盖：
 *  - 非成员 → 403；会话不存在 → 404；空数组 / 超 200 → 400
 *  - 只更新「属于该会话 + 我未读」的回执，其余静默忽略
 *  - affected=0（全已读 / 全不属于本会话）→ 不广播 WS
 *  - affected>0 → 广播一次 receipt:read，并推进已读水位线（只增不减）
 */

function makeService(opts: {
  member?: any;
  conv?: any;
  affected?: number;
  latestMsg?: any;
  memberIds?: string[];
} = {}) {
  const emits: any[] = [];
  const rawQueries: any[] = [];

  const receiptQb: any = {};
  ['update', 'set', 'where', 'andWhere'].forEach((m) => {
    receiptQb[m] = jest.fn(() => receiptQb);
  });
  receiptQb.execute = jest.fn(async () => ({ affected: opts.affected ?? 1 }));

  const latestQb: any = {};
  ['select', 'where', 'andWhere', 'orderBy', 'limit'].forEach((m) => {
    latestQb[m] = jest.fn(() => latestQb);
  });
  latestQb.getOne = jest.fn(async () => opts.latestMsg ?? null);

  const dataSource: any = {
    query: jest.fn(async (sql: string, params: any[]) => {
      rawQueries.push({ sql, params });
      return { affectedRows: 1 };
    }),
    getRepository: (entity: any) => {
      const name = entity?.name;
      if (name === 'ConversationMember') {
        return {
          findOne: jest.fn(async () => (opts.member === undefined ? { id: 'm1' } : opts.member)),
          find: jest.fn(async () => (opts.memberIds ?? ['u-me', 'u-a']).map((id) => ({ user_id: id }))),
          update: jest.fn(),
        };
      }
      if (name === 'Conversation') {
        return { findOne: jest.fn(async () => (opts.conv === undefined ? { id: 'c-1' } : opts.conv)) };
      }
      if (name === 'MessageReceipt') {
        return { createQueryBuilder: () => receiptQb, update: jest.fn() };
      }
      if (name === 'Message') {
        return { createQueryBuilder: () => latestQb, findOne: jest.fn() };
      }
      return {};
    },
  };

  const events: any = { emitToUsers: jest.fn((...args: any[]) => emits.push(args)) };
  const oss: any = {};
  const push: any = { notifyNewMessage: jest.fn() };

  // MessageService 与 EventsGateway 都是具体类；这里只用到 events.emitToUsers 与 dataSource
  const service = new MessageService(
    dataSource as DataSource,
    events as EventsGateway,
    oss as OssService,
    push as PushService,
  );

  return { service, dataSource, events, emits, rawQueries, receiptQb };
}

const CID = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';

describe('markMessagesRead（V6.1）', () => {
  it('正常标记：返回 marked，并广播一次 receipt:read', async () => {
    const { service, events, emits, rawQueries } = makeService({
      affected: 2,
      latestMsg: { id: MID, created_at: new Date() },
    });

    const r = await service.markMessagesRead(CID, 'u-me', [MID]);

    expect(r).toEqual({ marked: 2, conversation_id: CID });
    expect(events.emitToUsers).toHaveBeenCalledTimes(1);
    expect(emits[0][0]).toBe('receipt:read');
    expect(emits[0][2]).toMatchObject({ conversation_id: CID, user_id: 'u-me' });
    // 水位线推进（只增不减的 SQL）
    expect(rawQueries).toHaveLength(1);
    expect(rawQueries[0].sql).toContain('m_new.created_at >= m_old.created_at');
  });

  it('全部已读（affected=0）→ 不广播、不推水位线', async () => {
    const { service, events, rawQueries } = makeService({ affected: 0 });
    const r = await service.markMessagesRead(CID, 'u-me', [MID]);
    expect(r.marked).toBe(0);
    expect(events.emitToUsers).not.toHaveBeenCalled();
    expect(rawQueries).toHaveLength(0);
  });

  it('去重：重复 id 只算一次', async () => {
    const { service } = makeService({ affected: 1, latestMsg: { id: MID, created_at: new Date() } });
    const r = await service.markMessagesRead(CID, 'u-me', [MID, MID, MID]);
    expect(r.marked).toBe(1);
  });

  it('空数组 → 400', async () => {
    const { service } = makeService();
    await expect(service.markMessagesRead(CID, 'u-me', [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('超过 200 条 → 400', async () => {
    const { service } = makeService();
    const ids = Array.from({ length: 201 }, (_, i) => `0000000${i}-0000-4000-8000-000000000000`);
    await expect(service.markMessagesRead(CID, 'u-me', ids)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('非会话成员 → 403', async () => {
    const { service } = makeService({ member: null });
    await expect(service.markMessagesRead(CID, 'u-x', [MID])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('会话不存在 → 404', async () => {
    const { service } = makeService({ conv: null });
    await expect(service.markMessagesRead(CID, 'u-me', [MID])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SQL 只动「本会话 + 未读」的回执（不会碰别的会话）', async () => {
    const { service, receiptQb } = makeService({ affected: 1, latestMsg: { id: MID, created_at: new Date() } });
    await service.markMessagesRead(CID, 'u-me', [MID]);

    const whereSql = (receiptQb.where as jest.Mock).mock.calls.map((c) => String(c[0])).join(' ');
    const andSql = (receiptQb.andWhere as jest.Mock).mock.calls.map((c) => String(c[0])).join(' ');
    expect(whereSql).toContain('user_id');
    expect(andSql).toContain('is_read');
    expect(andSql).toContain('message_id IN');
    expect(andSql).toContain('conversation_id');
    // 不可逆：绝不出现把 is_read 置 false 的写法
    const setArg = (receiptQb.set as jest.Mock).mock.calls[0][0];
    expect(setArg.is_read).toBe(true);
  });
});

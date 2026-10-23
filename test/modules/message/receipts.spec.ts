import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MessageService } from 'src/modules/message/message.service';
import { EventsGateway } from 'src/modules/events/events.gateway';
import { OssService } from 'src/modules/upload/oss.service';
import { PushService } from 'src/modules/push/push.service';

/**
 * 消息回执（GET /messages/{id}/receipt）单测 —— V6.9 合并 /readers 后。
 *
 * 覆盖：
 *  - 返回数组、每条含 is_sender / is_read / user_display_name；
 *  - 一次 JOIN 查询（不再 N+1）；
 *  - 已焚毁 / 不存在 → 404；
 *  - 非成员 → 403。
 */

function makeService(opts: {
  message?: any;
  member?: any;
  rows?: any[];
  queryCount?: { n: number };
} = {}) {
  const qb: any = {};
  ['leftJoin', 'select', 'addSelect', 'where', 'orderBy'].forEach((m) => {
    qb[m] = jest.fn(() => qb);
  });
  qb.getRawMany = jest.fn(async () => {
    if (opts.queryCount) opts.queryCount.n += 1;
    return opts.rows ?? [];
  });

  const dataSource: any = {
    getRepository: (entity: any) => {
      const name = entity?.name;
      if (name === 'Message') {
        return { findOne: jest.fn(async () => (opts.message === undefined ? { id: 'm-1', conversation_id: 'c-1', sender_id: 'u-sender', is_destroyed: false } : opts.message)) };
      }
      if (name === 'ConversationMember') {
        return { findOne: jest.fn(async () => (opts.member === undefined ? { id: 'cm-1' } : opts.member)) };
      }
      if (name === 'MessageReceipt') {
        return { createQueryBuilder: () => qb };
      }
      return {};
    },
  };

  const service = new MessageService(
    dataSource as DataSource,
    { emitToUsers: jest.fn() } as unknown as EventsGateway,
    {} as OssService,
    { notifyNewMessage: jest.fn() } as unknown as PushService,
  );
  return { service, qb };
}

describe('getMessageReceipts（V6.9 合并 /readers 后）', () => {
  it('返回数组，每条带 is_sender / is_read / user_display_name', async () => {
    const { service } = makeService({
      rows: [
        { id: 'r1', message_id: 'm-1', user_id: 'u-sender', is_read: 1, read_at: new Date(), revealed_at: null, burn_at: null, display_name: '张三' },
        { id: 'r2', message_id: 'm-1', user_id: 'u-b', is_read: 0, read_at: null, revealed_at: null, burn_at: null, display_name: '李四' },
      ],
    });

    const r = await service.getMessageReceipts('m-1', 'u-sender');

    expect(Array.isArray(r)).toBe(true);          // 保持数组，前端 asArray 不用改
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ user_id: 'u-sender', is_sender: true, is_read: true, user_display_name: '张三' });
    expect(r[1]).toMatchObject({ user_id: 'u-b', is_sender: false, is_read: false, user_display_name: '李四' });
  });

  it('一次 JOIN 查询即可（不再按人循环查 users）', async () => {
    const counter = { n: 0 };
    const { service } = makeService({
      rows: Array.from({ length: 50 }, (_, i) => ({
        id: `r${i}`, message_id: 'm-1', user_id: `u-${i}`, is_read: 0,
        read_at: null, revealed_at: null, burn_at: null, display_name: `用户${i}`,
      })),
      queryCount: counter,
    });

    const r = await service.getMessageReceipts('m-1', 'u-sender');
    expect(r).toHaveLength(50);
    expect(counter.n).toBe(1);   // 50 条回执仍只查 1 次
  });

  it('已焚毁消息 → 404', async () => {
    const { service } = makeService({
      message: { id: 'm-1', conversation_id: 'c-1', sender_id: 'u-sender', is_destroyed: true },
    });
    await expect(service.getMessageReceipts('m-1', 'u-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('消息不存在 → 404', async () => {
    const { service } = makeService({ message: null });
    await expect(service.getMessageReceipts('m-9', 'u-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('非会话成员 → 403', async () => {
    const { service } = makeService({ member: null });
    await expect(service.getMessageReceipts('m-1', 'u-x')).rejects.toBeInstanceOf(ForbiddenExceptionLike);
  });
});

// 用父类匹配 ForbiddenException（避免额外 import 顺序问题）
import { ForbiddenException } from '@nestjs/common';
const ForbiddenExceptionLike = ForbiddenException;

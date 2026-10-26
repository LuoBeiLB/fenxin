import { DataSource } from 'typeorm';
import { MessageService } from 'src/modules/message/message.service';
import { EventsGateway } from 'src/modules/events/events.gateway';
import { OssService } from 'src/modules/upload/oss.service';
import { PushService } from 'src/modules/push/push.service';

/**
 * 全局搜索的 FULLTEXT 降级（V6.10）。
 *
 * 背景：`ft_messages_search` 之前只写在 docs 里要求"手工执行"，
 * 漏执行的环境一调 `GET /messages/search` 就 500：
 * `Can't find FULLTEXT index matching the column list`。
 *
 * 现在：
 *  - 迁移 `1768100000000-AddMessagesFulltextIndex` 自动建索引；
 *  - 万一索引还是缺（老库/迁移失败），服务端捕获 1191 后降级 LIKE，不再 500。
 */

function makeQb(failFirst: boolean, state: { n: number }) {
  const qb: any = {};
  ['select', 'addSelect', 'innerJoin', 'leftJoin', 'where', 'andWhere', 'orderBy', 'skip', 'take'].forEach(
    (m) => {
      qb[m] = jest.fn(() => qb);
    },
  );
  qb.getRawMany = jest.fn(async () => {
    state.n += 1;
    if (failFirst && state.n === 1) {
      const err: any = new Error("Can't find FULLTEXT index matching the column list");
      err.errno = 1191;
      throw err;
    }
    return [
      {
        id: 'm-1',
        conversation_id: 'c-1',
        sender_id: 'u-1',
        type: 'text',
        content: '项目进度同步',
        file_name: null,
        created_at: new Date(),
        sender_name: '张三',
      },
    ];
  });
  qb.getCount = jest.fn(async () => 1);
  return qb;
}

function makeService(failFirst: boolean) {
  const state = { n: 0 };
  const qbs: any[] = [];
  const dataSource: any = {
    getRepository: () => ({
      createQueryBuilder: () => {
        const qb = makeQb(failFirst && qbs.length === 0, state);
        qbs.push(qb);
        return qb;
      },
    }),
  };
  const service = new MessageService(
    dataSource as DataSource,
    { emitToUsers: jest.fn() } as unknown as EventsGateway,
    {} as OssService,
    { notifyNewMessage: jest.fn() } as unknown as PushService,
  );
  return { service, qbs, state };
}

describe('searchGlobal · FULLTEXT 索引缺失时降级 LIKE', () => {
  it('第一次报 1191 → 自动重试 LIKE，返回结果而不是 500', async () => {
    const { service, qbs } = makeService(true);

    const r = await service.searchGlobal({ userId: 'u-1', keyword: '项目进度' });

    expect(r.total).toBe(1);
    expect(r.list).toHaveLength(1);
    expect(r.list[0]).toMatchObject({ id: 'm-1', sender_name: '张三', type: 'text' });
    // 两次查询：第一次 MATCH，第二次 LIKE
    expect(qbs).toHaveLength(2);
    const firstWhere = String((qbs[0].where as jest.Mock).mock.calls[0][0]);
    const secondWhere = String((qbs[1].where as jest.Mock).mock.calls[0][0]);
    expect(firstWhere).toContain('MATCH');
    expect(secondWhere).toContain('LIKE');
  });

  it('索引正常时只查一次（不产生多余查询）', async () => {
    const { service, qbs } = makeService(false);
    const r = await service.searchGlobal({ userId: 'u-1', keyword: '项目进度' });
    expect(r.total).toBe(1);
    expect(qbs).toHaveLength(1);
    expect(String((qbs[0].where as jest.Mock).mock.calls[0][0])).toContain('MATCH');
  });

  it('其他数据库错误照常抛出（不吞异常）', async () => {
    const state = { n: 0 };
    const qb: any = {};
    ['select', 'addSelect', 'innerJoin', 'leftJoin', 'where', 'andWhere', 'orderBy', 'skip', 'take'].forEach(
      (m) => (qb[m] = jest.fn(() => qb)),
    );
    qb.getRawMany = jest.fn(async () => {
      state.n += 1;
      const err: any = new Error('Deadlock found when trying to get lock');
      err.errno = 1213;
      throw err;
    });
    qb.getCount = jest.fn(async () => 0);

    const dataSource: any = { getRepository: () => ({ createQueryBuilder: () => qb }) };
    const service = new MessageService(
      dataSource as DataSource,
      { emitToUsers: jest.fn() } as unknown as EventsGateway,
      {} as OssService,
      { notifyNewMessage: jest.fn() } as unknown as PushService,
    );

    await expect(service.searchGlobal({ userId: 'u-1', keyword: '测试' })).rejects.toThrow(/Deadlock/);
  });

  it('关键词里的 % _ 会被转义（LIKE 降级时不能当通配符）', async () => {
    const { service, qbs } = makeService(true);
    await service.searchGlobal({ userId: 'u-1', keyword: '100%_完成' });
    const params = (qbs[1].where as jest.Mock).mock.calls[0][1];
    expect(params.likeKw).toBe('%100\\%\\_完成%');
  });
});

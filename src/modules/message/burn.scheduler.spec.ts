import * as fs from 'fs';
import { BurnScheduler } from './burn.scheduler';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';

/**
 * BurnScheduler 单元测试（聚焦 v5.9.0 OSS 外置改动点）
 * mock DataSource / OssService / fs，不接 DB 不碰磁盘。
 * 覆盖：到期消息销毁时 OSS 附件同步删云端、本地附件只删磁盘、
 *       空附件跳过、无到期消息不进事务。
 */

const mockGetMany = jest.fn();

function makeQb() {
  const qb: any = {};
  qb.select = jest.fn(() => qb);
  qb.where = jest.fn(() => qb);
  qb.andWhere = jest.fn(() => qb);
  qb.take = jest.fn(() => qb);
  qb.getMany = mockGetMany;
  return qb;
}

function makeScheduler(messages: Array<Partial<Message>>) {
  const qb = makeQb();
  mockGetMany
    .mockReset()
    .mockResolvedValueOnce(messages) // A. 兜底到期（destroy_at）
    .mockResolvedValueOnce([]); // B. 全员看完（burn_at）
  const msgQbRepo = { createQueryBuilder: jest.fn(() => qb) };
  const emMsgRepo = { update: jest.fn(), delete: jest.fn() };
  const emReceiptRepo = { delete: jest.fn() };
  const dataSource: any = {
    getRepository: (entity: any) => (entity === Message ? msgQbRepo : emReceiptRepo),
    transaction: jest.fn(async (fn: any) =>
      fn({
        getRepository: (e: any) => (e === MessageReceipt ? emReceiptRepo : emMsgRepo),
      }),
    ),
  };
  const oss = {
    enabled: true,
    put: jest.fn(),
    signedUrl: jest.fn(),
    extractKey: jest.fn(),
    deleteByUrl: jest.fn(),
  } as any;
  const scheduler = new BurnScheduler(dataSource, oss);
  return { scheduler, oss, dataSource, emMsgRepo, emReceiptRepo };
}

describe('BurnScheduler（v5.9.0 OSS 外置）', () => {
  let unlinkSpy: jest.SpyInstance;

  beforeEach(() => {
    unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    unlinkSpy.mockRestore();
  });

  it('无到期消息 → 不进事务、不删任何文件', async () => {
    const { scheduler, oss, dataSource } = makeScheduler([]);
    await scheduler.destroyExpiredMessages();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(oss.deleteByUrl).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('OSS 签名 URL 附件 → 焚毁时同步删除云端对象（不留焚毁残留）', async () => {
    const ossUrl = 'https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/a.png?sig=1';
    const { scheduler, oss } = makeScheduler([{ id: 'm1', file_url: ossUrl }]);
    await scheduler.destroyExpiredMessages();
    expect(oss.deleteByUrl).toHaveBeenCalledWith(ossUrl);
  });

  it('本地 /uploads/ 路径（历史消息）→ 只删本地磁盘文件，不调 OSS', async () => {
    const { scheduler, oss } = makeScheduler([{ id: 'm1', file_url: '/uploads/a.png' }]);
    await scheduler.destroyExpiredMessages();
    expect(oss.deleteByUrl).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('file_url 为空 → 跳过附件清理', async () => {
    const { scheduler, oss } = makeScheduler([{ id: 'm1', file_url: null }]);
    await scheduler.destroyExpiredMessages();
    expect(oss.deleteByUrl).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('销毁流程完整：事务内删回执 + 断开引用 + 整行删除', async () => {
    const { scheduler, emMsgRepo, emReceiptRepo } = makeScheduler([
      { id: 'm1', file_url: null },
    ]);
    await scheduler.destroyExpiredMessages();
    expect(emReceiptRepo.delete).toHaveBeenCalled(); // 删回执
    expect(emMsgRepo.update).toHaveBeenCalled(); // 断开 reply_to 引用
    expect(emMsgRepo.delete).toHaveBeenCalled(); // 整行物理删除
  });
});

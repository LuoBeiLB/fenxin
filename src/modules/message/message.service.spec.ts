import * as fs from 'fs';
import { MessageService } from './message.service';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';

/**
 * MessageService 单元测试（聚焦 v5.9.0 OSS 改动点：destroyMessage 附件清理）
 * mock DataSource / EventsGateway / OssService / fs。
 * 覆盖：压缩版 + 原图双 URL 的云端清理、本地路径清理、混合场景、空附件、消息不存在。
 */

function makeService(msg: Partial<Message> | null) {
  const msgRepo = { findOne: jest.fn().mockResolvedValue(msg) };
  const emMsgRepo = { update: jest.fn(), delete: jest.fn() };
  const emReceiptRepo = { delete: jest.fn() };
  const dataSource: any = {
    getRepository: () => msgRepo,
    transaction: jest.fn(async (fn: any) =>
      fn({
        getRepository: (e: any) => (e === MessageReceipt ? emReceiptRepo : emMsgRepo),
      }),
    ),
  };
  const events = { emitToUsers: jest.fn() } as any;
  const oss = {
    enabled: true,
    put: jest.fn(),
    signedUrl: jest.fn(),
    extractKey: jest.fn(),
    deleteByUrl: jest.fn(),
  } as any;
  const service = new MessageService(dataSource, events, oss);
  return { service, oss };
}

describe('MessageService.destroyMessage（v5.9.0 OSS 外置）', () => {
  let unlinkSpy: jest.SpyInstance;

  beforeEach(() => {
    unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    unlinkSpy.mockRestore();
  });

  it('消息不存在 → 静默返回，不删任何东西', async () => {
    const { service, oss } = makeService(null);
    await service.destroyMessage('no-such-id');
    expect(oss.deleteByUrl).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('压缩版 + 原图都是 OSS URL → 两个云端对象都删（焚毁不留残留）', async () => {
    const url1 = 'https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/a.png?sig=1';
    const url2 = 'https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/a_orig.png?sig=1';
    const { service, oss } = makeService({ id: 'm1', file_url: url1, file_original_url: url2 });
    await service.destroyMessage('m1');
    expect(oss.deleteByUrl).toHaveBeenCalledTimes(2);
    expect(oss.deleteByUrl).toHaveBeenNthCalledWith(1, url1);
    expect(oss.deleteByUrl).toHaveBeenNthCalledWith(2, url2);
  });

  it('本地路径附件（历史消息）→ 只删本地磁盘，不调 OSS', async () => {
    const { service, oss } = makeService({
      id: 'm1',
      file_url: '/uploads/a.png',
      file_original_url: null,
    });
    await service.destroyMessage('m1');
    expect(oss.deleteByUrl).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('混合场景：压缩版在 OSS、原图在本地 → OSS 删云端对象，本地照常 unlink', async () => {
    const ossUrl = 'https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/a.png?sig=1';
    const { service, oss } = makeService({
      id: 'm1',
      file_url: ossUrl,
      file_original_url: '/uploads/a_orig.png',
    });
    await service.destroyMessage('m1');
    expect(oss.deleteByUrl).toHaveBeenCalledTimes(1);
    expect(oss.deleteByUrl).toHaveBeenCalledWith(ossUrl);
    // 两个 URL 都会尝试本地 unlink（OSS 地址的 basename 本地不存在，被 catch 吞掉不影响流程）
    expect(unlinkSpy).toHaveBeenCalledTimes(2);
  });

  it('无附件 → 不做任何文件清理', async () => {
    const { service, oss } = makeService({ id: 'm1', file_url: null, file_original_url: null });
    await service.destroyMessage('m1');
    expect(oss.deleteByUrl).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });
});

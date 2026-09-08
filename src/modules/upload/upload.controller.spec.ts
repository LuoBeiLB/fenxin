import * as fs from 'fs';
import { BadRequestException } from '@nestjs/common';
import { UploadController } from './upload.controller';

/**
 * UploadController 单元测试（v5.9.0 OSS 外置存储改造）
 * mock OssService / sharp / fs，不碰磁盘与网络。
 * 覆盖：OSS 成功路径（签名 URL + 本地副本清理）、OSS 失败降级本地、
 *       OSS 关闭走本地、gif/非图片跳过缩略图、sharp 失败不影响上传、
 *       中文文件名 latin1→utf8 转码、空文件报错。
 */

const mockSharpToFile = jest.fn();

jest.mock('sharp', () => {
  const chain: any = {};
  chain.resize = jest.fn(() => chain);
  chain.webp = jest.fn(() => chain);
  chain.toFile = mockSharpToFile;
  return jest.fn(() => chain);
});

const OSS_URL = 'https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/xxx.png?sig=1';
const OSS_THUMB_URL =
  'https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/thumb/xxx_thumb.webp?sig=1';

function makeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    originalname: 'test.png',
    filename: '11111111-2222-3333-4444-555555555555.png',
    path: 'C:\\fake\\uploads\\11111111-2222-3333-4444-555555555555.png',
    size: 1234,
    mimetype: 'image/png',
    ...overrides,
  } as Express.Multer.File;
}

function makeOss(enabled: boolean) {
  return {
    enabled,
    put: jest.fn(),
    signedUrl: jest.fn(),
    extractKey: jest.fn(),
    deleteByUrl: jest.fn(),
  } as any;
}

describe('UploadController（v5.9.0 OSS 改造）', () => {
  let unlinkSpy: jest.SpyInstance;
  let mkdirSpy: jest.SpyInstance;

  beforeEach(() => {
    unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined as any);
    mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    mockSharpToFile.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    unlinkSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it('OSS 启用：原图 + 缩略图推 OSS，返回签名 URL，并删除本地两份副本', async () => {
    const oss = makeOss(true);
    oss.put
      .mockResolvedValueOnce({ key: 'uploads/a.png', url: OSS_URL })
      .mockResolvedValueOnce({ key: 'uploads/thumb/a_thumb.webp', url: OSS_THUMB_URL });
    const controller = new UploadController(oss);

    const r = await controller.upload(makeFile());

    // 两次 put：原图 + 缩略图，key 由 filename 推导
    expect(oss.put).toHaveBeenCalledTimes(2);
    expect(oss.put.mock.calls[0][0]).toBe('uploads/11111111-2222-3333-4444-555555555555.png');
    expect(oss.put.mock.calls[1][0]).toBe(
      'uploads/thumb/11111111-2222-3333-4444-555555555555_thumb.webp',
    );
    // 响应结构：签名 URL（前端 fileURL() 对 http(s) 直通）
    expect(r).toEqual({ url: OSS_URL, thumb_url: OSS_THUMB_URL, file_name: 'test.png', file_size: 1234 });
    // 本地副本（原图 + 缩略图）清理完毕，磁盘不留双份
    expect(unlinkSpy).toHaveBeenCalledTimes(2);
  });

  it('OSS put 抛错 → 自动降级本地 /uploads/ 相对路径（与旧版行为一致），本地文件保留', async () => {
    const oss = makeOss(true);
    oss.put.mockRejectedValue(new Error('oss down'));
    const controller = new UploadController(oss);

    const r = await controller.upload(makeFile());

    expect(r.url).toMatch(/^\/uploads\//);
    expect(r.thumb_url).toMatch(/^\/uploads\/thumb\//);
    expect(unlinkSpy).not.toHaveBeenCalled(); // 降级时不删本地文件
  });

  it('OSS 关闭 → 直接走本地模式，不调 OSS', async () => {
    const oss = makeOss(false);
    const controller = new UploadController(oss);

    const r = await controller.upload(makeFile());

    expect(r.url).toMatch(/^\/uploads\//);
    expect(oss.put).not.toHaveBeenCalled();
  });

  it('gif 跳过缩略图（保留动图）：只传原图，thumb_url 为 null，只删一份本地副本', async () => {
    const oss = makeOss(true);
    oss.put.mockResolvedValueOnce({ key: 'a', url: OSS_URL });
    const controller = new UploadController(oss);

    const r = await controller.upload(makeFile({ mimetype: 'image/gif' }));

    expect(oss.put).toHaveBeenCalledTimes(1);
    expect(r.thumb_url).toBeNull();
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  });

  it('非图片（视频/文件）：无缩略图逻辑', async () => {
    const oss = makeOss(true);
    oss.put.mockResolvedValueOnce({ key: 'a', url: OSS_URL });
    const controller = new UploadController(oss);

    const r = await controller.upload(makeFile({ mimetype: 'video/mp4' }));

    expect(r.thumb_url).toBeNull();
    expect(oss.put).toHaveBeenCalledTimes(1);
  });

  it('sharp 生成缩略图失败 → 不影响上传成功，thumb_url 为 null', async () => {
    const oss = makeOss(true);
    oss.put.mockResolvedValueOnce({ key: 'a', url: OSS_URL });
    mockSharpToFile.mockRejectedValue(new Error('bad image'));
    const controller = new UploadController(oss);

    const r = await controller.upload(makeFile());

    expect(r.url).toBe(OSS_URL);
    expect(r.thumb_url).toBeNull();
    expect(unlinkSpy).toHaveBeenCalledTimes(1); // 只删原图副本
  });

  it('中文文件名按 multer latin1 → utf8 转码后返回', async () => {
    const oss = makeOss(false);
    const controller = new UploadController(oss);
    // multer 收到的 originalname 是 latin1 字节流
    const latin1 = Buffer.from('聊天图片.pdf', 'utf8').toString('latin1');

    const r = await controller.upload(
      makeFile({ originalname: latin1, mimetype: 'application/pdf' }),
    );

    expect(r.file_name).toBe('聊天图片.pdf');
  });

  it('未接收到文件 → BadRequestException', async () => {
    const controller = new UploadController(makeOss(true));
    await expect(controller.upload(undefined as any)).rejects.toThrow(BadRequestException);
  });
});

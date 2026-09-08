import { OssService } from './oss.service';

/**
 * OssService 单元测试（v5.9.0 OSS 外置存储）
 * 全部 mock ali-oss，不产生真实网络请求与费用。
 * 覆盖：enabled 判定、内网/外网 endpoint 选择、put、signedUrl、
 *       extractKey（焚毁删对象的安全前提）、deleteByUrl 容错。
 */

const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockSignatureUrl = jest.fn();
const mockCtorCalls: Array<Record<string, any>> = [];

jest.mock('ali-oss', () => {
  return jest.fn().mockImplementation((opts: any) => {
    mockCtorCalls.push(opts);
    return { put: mockPut, delete: mockDelete, signatureUrl: mockSignatureUrl };
  });
});

const ENV_KEYS = [
  'OSS_ENABLED',
  'OSS_BUCKET',
  'OSS_REGION',
  'OSS_INTERNAL',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_URL_EXPIRES',
] as const;

const envBackup: Record<string, string | undefined> = {};

const FULL_ENV: Record<string, string> = {
  OSS_ENABLED: 'true',
  OSS_BUCKET: 'fenxin-files',
  OSS_REGION: 'oss-cn-hangzhou',
  OSS_ACCESS_KEY_ID: 'test-ak',
  OSS_ACCESS_KEY_SECRET: 'test-sk',
};

function setEnv(overrides: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) process.env[k] = v;
  }
}

describe('OssService', () => {
  beforeAll(() => {
    for (const k of ENV_KEYS) envBackup[k] = process.env[k];
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    mockPut.mockReset();
    mockDelete.mockReset();
    mockSignatureUrl.mockReset();
    mockCtorCalls.length = 0;
  });

  describe('enabled 判定', () => {
    it('OSS_ENABLED=false → 禁用，不创建任何 client', () => {
      setEnv({ ...FULL_ENV, OSS_ENABLED: 'false' });
      const svc = new OssService();
      expect(svc.enabled).toBe(false);
      expect(mockCtorCalls).toHaveLength(0);
    });

    it('OSS_ENABLED=true 但缺 AccessKeySecret → 禁用（配置不全自动回退本地）', () => {
      const rest = { ...FULL_ENV };
      delete rest.OSS_ACCESS_KEY_SECRET;
      setEnv(rest);
      expect(new OssService().enabled).toBe(false);
      expect(mockCtorCalls).toHaveLength(0);
    });

    it('缺 bucket → 禁用', () => {
      const rest = { ...FULL_ENV };
      delete rest.OSS_BUCKET;
      setEnv(rest);
      expect(new OssService().enabled).toBe(false);
    });

    it('配置齐全 → 启用，创建 client（上传/删除）+ signer（签名）两个实例', () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      expect(svc.enabled).toBe(true);
      expect(mockCtorCalls).toHaveLength(2);
    });
  });

  describe('endpoint 选择（OSS_INTERNAL 开关）', () => {
    it('未设置（服务器默认）→ 上传 client 走内网 endpoint，免流量费', () => {
      setEnv(FULL_ENV);
      new OssService();
      expect(mockCtorCalls[0].internal).toBe(true);
    });

    it('OSS_INTERNAL=true → 内网', () => {
      setEnv({ ...FULL_ENV, OSS_INTERNAL: 'true' });
      new OssService();
      expect(mockCtorCalls[0].internal).toBe(true);
    });

    it('OSS_INTERNAL=false（本地开发机连不通内网）→ 上传走外网 endpoint', () => {
      setEnv({ ...FULL_ENV, OSS_INTERNAL: 'false' });
      new OssService();
      expect(mockCtorCalls[0].internal).toBe(false);
    });

    it('signer（给前端生成下载地址）永远走外网 https，不受 OSS_INTERNAL 影响', () => {
      setEnv({ ...FULL_ENV, OSS_INTERNAL: 'true' });
      new OssService();
      expect(mockCtorCalls[1].internal).toBeUndefined();
      expect(mockCtorCalls[1].secure).toBe(true);
    });
  });

  describe('put', () => {
    it('上传成功 → 返回 { key, url }（url 为 signer 生成的签名地址），并带 1 年缓存头', async () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      mockPut.mockResolvedValue({ url: 'http://raw-url' });
      mockSignatureUrl.mockReturnValue('https://signed-url');

      const r = await svc.put('uploads/a.png', '/local/a.png');

      expect(mockPut).toHaveBeenCalledWith('uploads/a.png', '/local/a.png', {
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
      expect(r).toEqual({ key: 'uploads/a.png', url: 'https://signed-url' });
    });

    it('put 返回无 url → 抛异常（由上层降级本地）', async () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      mockPut.mockResolvedValue({});
      await expect(svc.put('uploads/a.png', '/local/a.png')).rejects.toThrow(/未返回 url/);
    });

    it('put 网络失败 → 抛异常（由上层降级本地）', async () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      mockPut.mockRejectedValue(new Error('network down'));
      await expect(svc.put('uploads/a.png', '/local/a.png')).rejects.toThrow('network down');
    });

    it('未启用时调用 → 直接抛 OSS disabled', async () => {
      setEnv({ ...FULL_ENV, OSS_ENABLED: 'false' });
      const svc = new OssService();
      await expect(svc.put('k', 'p')).rejects.toThrow('OSS disabled');
    });
  });

  describe('signedUrl', () => {
    it('有效期取自 OSS_URL_EXPIRES（秒）', () => {
      setEnv({ ...FULL_ENV, OSS_URL_EXPIRES: '12345' });
      const svc = new OssService();
      mockSignatureUrl.mockReturnValue('u');
      svc.signedUrl('uploads/a.png');
      expect(mockSignatureUrl).toHaveBeenCalledWith('uploads/a.png', { expires: 12345 });
    });

    it('未配置时默认 10 年（315360000 秒，与旧版「URL 即永久凭证」语义对齐）', () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      svc.signedUrl('k');
      expect(mockSignatureUrl).toHaveBeenCalledWith('k', { expires: 315360000 });
    });
  });

  describe('extractKey（从签名 URL 还原对象 key）', () => {
    it('本 bucket 的签名 URL → 提取 key（含 URL 编码文件名解码）', () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      const url =
        'https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/thumbnail%20a.webp?Signature=x';
      expect(svc.extractKey(url)).toBe('uploads/thumbnail a.webp');
    });

    it('其他 bucket 的域名 → null（防止误删别人对象）', () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      expect(
        svc.extractKey('https://other-bucket.oss-cn-hangzhou.aliyuncs.com/uploads/a.png'),
      ).toBeNull();
    });

    it('本地相对路径（历史消息）→ null', () => {
      setEnv(FULL_ENV);
      expect(new OssService().extractKey('/uploads/a.png')).toBeNull();
    });

    it('空值 → null', () => {
      setEnv(FULL_ENV);
      expect(new OssService().extractKey(undefined as any)).toBeNull();
    });
  });

  describe('deleteByUrl（焚毁云端清理）', () => {
    it('合法 OSS URL → 删除对应云端对象', async () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      mockDelete.mockResolvedValue({});
      await svc.deleteByUrl('https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/a.png?sig=1');
      expect(mockDelete).toHaveBeenCalledWith('uploads/a.png');
    });

    it('本地路径 → 静默忽略（不调 delete）', async () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      await svc.deleteByUrl('/uploads/a.png');
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('未启用 → 静默忽略', async () => {
      setEnv({ ...FULL_ENV, OSS_ENABLED: 'false' });
      const svc = new OssService();
      await svc.deleteByUrl('https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/a.png');
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('删除失败 → 只告警不抛异常（不能因 OSS 故障阻塞焚毁主流程）', async () => {
      setEnv(FULL_ENV);
      const svc = new OssService();
      mockDelete.mockRejectedValue(new Error('403 forbidden'));
      await expect(
        svc.deleteByUrl('https://fenxin-files.oss-cn-hangzhou.aliyuncs.com/uploads/a.png'),
      ).resolves.toBeUndefined();
    });
  });
});

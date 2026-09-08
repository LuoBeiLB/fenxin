import { Injectable, Logger } from '@nestjs/common';

/**
 * 阿里云 OSS 外置存储（v5.9.0）：
 * - 上传/删除走内网 endpoint（同地域 ECS ↔ OSS：免流量费、不占 ECS 公网出带宽）；
 * - 下载走外网 https 签名 URL（私有 bucket，URL 即凭证）；
 * - 签名有效期默认 10 年（OSS_URL_EXPIRES 秒）——与旧版本地静态服务
 *   「URL 即永久凭证」的安全语义保持一致，历史消息不因过期而裂图；
 * - OSS_ENABLED=false 或任一配置缺失 → enabled=false，上传自动回退本地 uploads/；
 * - OSS_INTERNAL=false 时上传走外网 endpoint（本地开发机不在阿里云机房，
 *   连不通 oss-*-internal 地址；服务器上默认 true 走内网）。
 */
@Injectable()
export class OssService {
  private readonly logger = new Logger('OssService');
  private client: any = null; // 上传/删除（服务器内网 / 本地外网）
  private signer: any = null; // 外网：signatureUrl
  readonly enabled: boolean;

  constructor() {
    const on = (process.env.OSS_ENABLED || 'false') === 'true';
    const bucket = process.env.OSS_BUCKET || '';
    const region = process.env.OSS_REGION || 'oss-cn-hangzhou';
    const ak = process.env.OSS_ACCESS_KEY_ID || '';
    const sk = process.env.OSS_ACCESS_KEY_SECRET || '';
    this.enabled = on && !!(bucket && ak && sk);
    if (!this.enabled) {
      this.logger.warn('OSS 未启用（OSS_ENABLED=false 或配置不全），附件将存本地 uploads/');
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OSS = require('ali-oss');
    const common = { bucket, accessKeyId: ak, accessKeySecret: sk, timeout: 30000 };
    // OSS_INTERNAL=true（默认，服务器）→ 同地域内网 endpoint，免流量费不占公网出带宽；
    // OSS_INTERNAL=false（本地开发机）→ 外网 endpoint，保证本地也能测通 OSS 链路
    const internal = (process.env.OSS_INTERNAL || 'true') === 'true';
    this.client = new OSS({ ...common, region, internal, secure: true });
    // 外网 client：仅用于生成给前端下载用的签名 URL
    this.signer = new OSS({ ...common, region, secure: true });
    this.logger.log(
      `OSS 已启用 bucket=${bucket} region=${region}（上传走${internal ? '内网' : '外网'} endpoint）`,
    );
  }

  /** 上传本地文件；成功返回 { key, url }，失败抛异常（由调用方决定是否降级本地） */
  async put(key: string, localPath: string): Promise<{ key: string; url: string }> {
    if (!this.enabled) throw new Error('OSS disabled');
    const r = await this.client.put(key, localPath, {
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
    if (!r || !r.url) throw new Error(`OSS put 未返回 url（key=${key}）`);
    return { key, url: this.signedUrl(key) };
  }

  /** 生成外网 https 签名 URL（默认 10 年） */
  signedUrl(key: string): string {
    const expires = parseInt(process.env.OSS_URL_EXPIRES || '315360000', 10);
    return this.signer.signatureUrl(key, { expires });
  }

  /** 完整签名 URL → 对象 key；非本 bucket 的 http URL 返回 null */
  extractKey(url: string): string | null {
    if (!url || !/^https?:/.test(url)) return null;
    try {
      const u = new URL(url);
      const bucket = process.env.OSS_BUCKET || '';
      if (!bucket || !u.hostname.startsWith(`${bucket}.`)) return null;
      return decodeURIComponent(u.pathname.replace(/^\//, ''));
    } catch {
      return null;
    }
  }

  /** 删除对象（焚毁清理用）；失败静默告警，与本地 unlink 的容错语义一致 */
  async deleteByUrl(url: string): Promise<void> {
    if (!this.enabled) return;
    const key = this.extractKey(url);
    if (!key) return;
    try {
      await this.client.delete(key);
    } catch (e: any) {
      this.logger.warn(`OSS 删除失败 key=${key}: ${e?.message || e}`);
    }
  }
}

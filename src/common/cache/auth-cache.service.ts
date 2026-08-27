import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * 鉴权上下文（精简字段）—— 缓存里只存守卫判权需要的最小集：
 *   - user: id / phone / role / status / force_change_pwd
 *   - device: id / user_id
 * 其他字段（display_name / avatar_url / department 等）不缓，访问 profile 等接口
 * 由 controller 显式查完整实体，避免缓存膨胀 + 字段过期。
 */
export interface CachedAuthContext {
  user: {
    id: string;
    phone: string;
    role: 'user' | 'admin';
    status: 'active' | 'disabled';
    force_change_pwd: boolean;
    /** 软删除标记：缓存命中即代表判权时刻未删除（删除后 30s TTL 内最坏延迟生效，与 status 语义一致） */
    deleted_at: Date | null;
  };
  device: {
    id: string;
    user_id: string;
  };
  cachedAt: number;
}

/**
 * 鉴权缓存服务（V4.0 §M7 性能与质量）
 *
 * 作用：JwtAuthGuard 每请求 2 次 SQL（user + device）→ 命中后 0 次 SQL。
 *
 * 设计取舍：
 *  - in-memory Map（不依赖 Redis）：单实例够用；后续多实例可换 Redis（接口兼容）
 *  - TTL 默认 30s：停用账号 / 踢设备后最长 30s 全员生效（之前是即时）
 *    业务可接受：管理员强制下线/停用是低频、容忍秒级延迟
 *  - key = `${userId}:${deviceId}`：device 维度隔离，踢一台不影响其它
 *  - 主动失效：AuthService 在 toggleAccountStatus / 设备下线时调 invalidate
 *    把秒级延迟再压成 0
 *  - AUTH_CACHE_TTL_MS=0 可关闭缓存（调试用）
 */
@Injectable()
export class AuthCacheService implements OnModuleDestroy {
  private readonly logger = new Logger('AuthCache');
  private readonly cache = new Map<string, CachedAuthContext>();
  private readonly ttlMs: number;

  constructor() {
    this.ttlMs = parseInt(process.env.AUTH_CACHE_TTL_MS || '30000', 10);
    if (!this.isEnabled()) {
      this.logger.warn('AuthCache disabled (AUTH_CACHE_TTL_MS=0)');
    }
  }

  isEnabled(): boolean {
    return this.ttlMs > 0;
  }

  private key(userId: string, deviceId: string): string {
    return `${userId}:${deviceId}`;
  }

  /** 取缓存：过期或不存在返回 null */
  get(userId: string, deviceId: string): CachedAuthContext | null {
    if (!this.isEnabled()) return null;
    const k = this.key(userId, deviceId);
    const entry = this.cache.get(k);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(k);
      return null;
    }
    return entry;
  }

  /** 写缓存：仅存守卫判权最小集，避免字段过期影响下游 */
  set(
    userId: string,
    deviceId: string,
    ctx: Omit<CachedAuthContext, 'cachedAt'>,
  ): void {
    if (!this.isEnabled()) return;
    this.cache.set(this.key(userId, deviceId), { ...ctx, cachedAt: Date.now() });
  }

  /**
   * 主动失效：
   *  - invalidate(userId, deviceId)：单台设备下线
   *  - invalidate(userId)：该用户所有设备（停用账号时）
   *  - invalidate()：全清（紧急 / 测试）
   * 返回清除条目数。
   */
  invalidate(userId?: string, deviceId?: string): number {
    let removed = 0;
    if (userId && deviceId) {
      if (this.cache.delete(this.key(userId, deviceId))) removed = 1;
    } else if (userId) {
      const prefix = `${userId}:`;
      for (const k of Array.from(this.cache.keys())) {
        if (k.startsWith(prefix)) {
          this.cache.delete(k);
          removed += 1;
        }
      }
    } else {
      removed = this.cache.size;
      this.cache.clear();
    }
    if (removed > 0) {
      this.logger.debug(`AuthCache invalidated ${removed} entries`);
    }
    return removed;
  }

  size(): number {
    return this.cache.size;
  }

  onModuleDestroy() {
    this.cache.clear();
  }
}

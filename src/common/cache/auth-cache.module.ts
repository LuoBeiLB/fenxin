import { Global, Module } from '@nestjs/common';
import { AuthCacheService } from './auth-cache.service';

/**
 * 鉴权缓存模块（V4.0 §M7）
 *
 * 设为 @Global() 是为了让 AuthService / AccountService / 未来其它 module
 * 都能直接 inject AuthCacheService，不必在每个 module 里重复 import providers。
 *
 * 单例保证：全应用共享同一份 in-memory cache map，踢一台设备能立刻影响所有
 * 后续请求的鉴权决策（不需要等 30s TTL 过期）。
 */
@Global()
@Module({
  providers: [AuthCacheService],
  exports: [AuthCacheService],
})
export class AuthCacheModule {}

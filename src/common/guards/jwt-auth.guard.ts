import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthCacheService } from '../cache/auth-cache.service';
import { TokenService } from '../../modules/auth/token.service';
import { AppUser } from '../../entities/app-user.entity';
import { Device } from '../../entities/device.entity';

export interface AuthPayload {
  userId: string;
  phone: string;
  role: string;
  deviceId: string;
}

/**
 * 强制改密白名单：当用户 force_change_pwd=true 时，仅下列路由允许放行。
 * 涵盖：① 修改密码本身；② 个人资料读写（前端需要展示姓名/部门提示）；③ 设备列表与下线。
 * 其余业务接口一律拦截，前端拿到 FORCE_CHANGE_PASSWORD 错误码应引导用户去 change-password。
 */
const FORCE_CHANGE_PWD_WHITELIST: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/api\/v1\/auth\/change-password$/ },
  { method: 'GET', pattern: /^\/api\/v1\/auth\/profile$/ },
  { method: 'PUT', pattern: /^\/api\/v1\/auth\/profile$/ },
  { method: 'GET', pattern: /^\/api\/v1\/auth\/devices$/ },
  { method: 'POST', pattern: /^\/api\/v1\/auth\/devices\/[^/]+\/offline$/ },
  { method: 'GET', pattern: /^\/api\/v1\/?$/ },
];

/**
 * 全局 JWT 认证守卫。
 *
 * 性能优化（V4.0 §M7）：
 *   优先查 AuthCache（30s TTL），命中 → 0 次 SQL；
 *   miss → 查 user + device 两次 SQL，存缓存。
 *   停用账号 / 踢设备时由 AuthService 调 cache.invalidate() 把延迟压到 0。
 *
 * 行为：
 *   ① 验签
 *   ② 账号 active + 设备存在
 *   ③ force_change_pwd=true 时仅放行白名单内路由
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly dataSource: DataSource,
    private readonly authCache: AuthCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const authHeader: string | undefined = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization header');
    }

    let payload: AuthPayload;
    try {
      payload = this.tokenService.verifyAccessToken(authHeader.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // ===== 优先查缓存 =====
    const cached = this.authCache.get(payload.userId, payload.deviceId);
    let user: {
      id: string;
      phone: string;
      role: 'user' | 'admin';
      status: 'active' | 'disabled';
      force_change_pwd: boolean;
      deleted_at: Date | null;
    };
    let device: { id: string; user_id: string };

    if (cached) {
      user = cached.user;
      device = cached.device;
    } else {
      const userEntity = await this.dataSource.getRepository(AppUser).findOne({
        where: { id: payload.userId },
        select: ['id', 'phone', 'role', 'status', 'force_change_pwd', 'deleted_at'],
      });
      if (!userEntity || userEntity.status !== 'active' || userEntity.deleted_at) {
        throw new UnauthorizedException('账号已被停用或不存在');
      }
      const deviceEntity = await this.dataSource.getRepository(Device).findOne({
        where: { id: payload.deviceId, user_id: payload.userId },
        select: ['id', 'user_id'],
      });
      if (!deviceEntity) {
        throw new UnauthorizedException('设备已下线，请重新登录');
      }
      user = {
        id: userEntity.id,
        phone: userEntity.phone,
        role: userEntity.role,
        status: userEntity.status,
        force_change_pwd: userEntity.force_change_pwd,
        deleted_at: userEntity.deleted_at,
      };
      device = { id: deviceEntity.id, user_id: deviceEntity.user_id };
      this.authCache.set(payload.userId, payload.deviceId, { user, device });
    }

    // 强制改密拦截（白名单外的业务接口全部拒绝）
    if (user.force_change_pwd) {
      const method = (req.method || 'GET').toUpperCase();
      const path: string = req.path || req.url || '';
      const isWhitelisted = FORCE_CHANGE_PWD_WHITELIST.some(
        (rule) => rule.method === method && rule.pattern.test(path),
      );
      if (!isWhitelisted) {
        throw new ForbiddenException({
          code: 'FORCE_CHANGE_PASSWORD',
          message: '请先修改初始密码后再使用其他功能',
        });
      }
    }

    // 下游 controller / RolesGuard 用：保留 payload（兼容老代码）
    // 同时挂 user / device 给可能的扩展点
    req.user = payload;
    (req as any).authUser = user;
    (req as any).authDevice = device;
    return true;
  }
}

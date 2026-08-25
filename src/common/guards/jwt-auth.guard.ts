import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
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
 * 全局 JWT 认证守卫。
 * 除验签外，每次请求查库校验：① 账号仍为 active；② 签发 token 的设备记录仍存在。
 * 因此「停用账号 / 下线设备（删除设备记录）」可立即吊销已签发的 token。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly dataSource: DataSource,
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

    const user = await this.dataSource.getRepository(AppUser).findOne({
      where: { id: payload.userId },
    });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('账号已被停用或不存在');
    }

    const device = await this.dataSource.getRepository(Device).findOne({
      where: { id: payload.deviceId, user_id: payload.userId },
    });
    if (!device) {
      throw new UnauthorizedException('设备已下线，请重新登录');
    }

    req.user = payload;
    return true;
  }
}

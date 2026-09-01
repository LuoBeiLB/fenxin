import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { AppUser, sanitizeUser, sanitizeUserWithPrefs } from '../../entities/app-user.entity';
import { Device } from '../../entities/device.entity';
import { AuditService } from '../audit/audit.service';
import { TokenService } from './token.service';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { AuthCacheService } from '../../common/cache/auth-cache.service';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';

const MAX_LOGIN_FAILS = 5;
const LOCK_DURATION_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly tokenService: TokenService,
    private readonly authCache: AuthCacheService,
    private readonly events: EventsGateway,
  ) {}

  /**
   * 登录。注意：本系统不开自助注册，账号由管理后台统一开通（见 /accounts）。
   */
  async login(
    phone: string,
    password: string,
    deviceInfo: { deviceName: string; deviceType: string },
    meta: { ip?: string; userAgent?: string },
  ) {
    const userRepo = this.dataSource.getRepository(AppUser);
    const deviceRepo = this.dataSource.getRepository(Device);

    const user = await userRepo.findOne({ where: { phone } });
    if (!user) throw new UnauthorizedException('Invalid phone or password');

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainSec = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
      throw new UnauthorizedException(`Account locked. Try again in ${remainSec} seconds`);
    }

    if (user.status !== 'active' || user.deleted_at) throw new UnauthorizedException('账号已被停用');

    const isValid = await argon2.verify(user.password_hash, password).catch(() => false);
    if (!isValid) {
      const failCount = (user.login_fail_count || 0) + 1;
      const updateData: Partial<AppUser> = { login_fail_count: failCount };
      if (failCount >= MAX_LOGIN_FAILS) {
        updateData.locked_until = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000);
        updateData.login_fail_count = 0;
      }
      await userRepo.update(user.id, updateData);
      throw new UnauthorizedException('Invalid phone or password');
    }

    await userRepo.update(user.id, { login_fail_count: 0, locked_until: null });

    const device = await deviceRepo.save(
      deviceRepo.create({
        user_id: user.id,
        device_name: deviceInfo.deviceName,
        device_type: deviceInfo.deviceType,
        device_id: crypto.randomUUID(),
        is_online: true,
        last_active_at: new Date(),
      }),
    );

    // 新设备登录通知：推给同账号全部在线设备（含本设备，客户端按 device_id 自行忽略）
    // 仅当已是第 2 台以上设备时才打扰用户；首台登录不推
    const onlineDeviceCount = await deviceRepo.count({ where: { user_id: user.id } });
    if (onlineDeviceCount > 1) {
      this.events.emitToUsers(WS_EVENTS.DEVICE_ADDED, [user.id], {
        device_id: device.id,
        device_name: device.device_name,
        device_type: device.device_type,
        logged_in_at: new Date().toISOString(),
        ip: meta.ip,
      });
    }

    const payload: AuthPayload = {
      userId: user.id,
      phone: user.phone,
      role: user.role,
      deviceId: device.id,
    };
    const tokens = this.tokenService.issueTokenPair(payload);

    await this.audit.log({
      userId: user.id,
      action: 'login',
      detail: `Device: ${deviceInfo.deviceName} (${deviceInfo.deviceType})`,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      // 登录即返回 topic（主题色）：前端登录后无需再拉一次 profile 即可应用用户主题
      user: sanitizeUserWithPrefs(user),
      ...tokens,
      device,
      force_change_pwd: user.force_change_pwd,
    };
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const userRepo = this.dataSource.getRepository(AppUser);
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const isValid = await argon2.verify(user.password_hash, oldPassword).catch(() => false);
    if (!isValid) throw new BadRequestException('Current password is incorrect');

    await userRepo.update(userId, {
      password_hash: await argon2.hash(newPassword),
      force_change_pwd: false,
    });

    // 主动失效鉴权缓存：各设备缓存里 force_change_pwd 还是 true，
    // 失效后守卫下次重查 DB，避免 30s TTL 内继续拦截已改密用户
    this.authCache.invalidate(userId);

    await this.audit.log({ userId, action: 'change_password' });
  }

  /** 用 refresh token 换新 token 对；校验设备与账号状态，支持吊销 */
  async refresh(refreshToken: string) {
    let payload: AuthPayload;
    try {
      payload = this.tokenService.verifyRefreshToken(refreshToken);
    } catch {
      throw new UnauthorizedException('refresh token 无效或已过期');
    }

    const userRepo = this.dataSource.getRepository(AppUser);
    const deviceRepo = this.dataSource.getRepository(Device);

    const device = await deviceRepo.findOne({
      where: { id: payload.deviceId, user_id: payload.userId },
    });
    if (!device) throw new UnauthorizedException('设备已下线，请重新登录');

    const user = await userRepo.findOne({ where: { id: payload.userId } });
    if (!user || user.status !== 'active' || user.deleted_at) throw new UnauthorizedException('账号已被停用或不存在');

    const newPayload: AuthPayload = {
      userId: user.id,
      phone: user.phone,
      role: user.role,
      deviceId: device.id,
    };
    return this.tokenService.issueTokenPair(newPayload);
  }

  async getProfile(userId: string) {
    const user = await this.dataSource.getRepository(AppUser).findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return sanitizeUserWithPrefs(user);
  }

  async updateProfile(
    userId: string,
    updates: { display_name?: string; signature?: string; avatar_url?: string; topic?: string },
  ) {
    const userRepo = this.dataSource.getRepository(AppUser);
    const updateData: Partial<AppUser> = {};
    if (updates.display_name !== undefined) updateData.display_name = updates.display_name;
    if (updates.signature !== undefined) updateData.signature = updates.signature;
    if (updates.avatar_url !== undefined) updateData.avatar_url = updates.avatar_url;
    if (updates.topic !== undefined) updateData.topic = updates.topic;

    await userRepo.update(userId, updateData);
    const updated = await userRepo.findOne({ where: { id: userId } });
    return sanitizeUserWithPrefs(updated);
  }

  async getDevices(userId: string) {
    return this.dataSource.getRepository(Device).find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
  }

  /** 下线设备 = 删除设备记录；因 JWT 守卫每请求校验设备存在性，该设备 token 立即失效 */
  async removeDevice(userId: string, deviceId: string) {
    await this.dataSource.getRepository(Device).delete({ id: deviceId, user_id: userId });
    // 失效鉴权缓存（单条精准清除，不影响该用户其它在线设备）：避免 30s TTL 内被下线设备仍凭缓存通过校验
    this.authCache.invalidate(userId, deviceId);
    // WS 通知该用户全部设备（被下线设备若还连着可立即跳转登录页）
    this.events.emitToUsers(WS_EVENTS.DEVICE_REMOVED, [userId], { device_id: deviceId });
    await this.audit.log({ userId, action: 'remove_device', targetId: deviceId });
  }
}

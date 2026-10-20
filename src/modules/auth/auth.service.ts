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
    deviceInfo: { deviceName: string; deviceType: string; deviceId?: string },
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

    // 设备去重：客户端传了 device_id（持久化的设备标识）则按 (user_id, device_id) 查找，
    // 已存在则复用原记录（同一设备重复登录不再产生重复条目），不存在才新建
    let device: Device | null = null;
    if (deviceInfo.deviceId) {
      device = await deviceRepo.findOne({
        where: { user_id: user.id, device_id: deviceInfo.deviceId },
      });
    }

    if (device) {
      // 同一设备重复登录：刷新设备信息与在线状态，不新建
      device.device_name = deviceInfo.deviceName;
      device.device_type = deviceInfo.deviceType;
      device.is_online = true;
      device.online_at = device.online_at ?? new Date();
      device.offline_at = null;
      device.last_active_at = new Date();
      await deviceRepo.save(device);
    } else {
      device = await deviceRepo.save(
        deviceRepo.create({
          user_id: user.id,
          device_name: deviceInfo.deviceName,
          device_type: deviceInfo.deviceType,
          device_id: deviceInfo.deviceId ?? crypto.randomUUID(),
          is_online: true,
          online_at: new Date(),
          last_active_at: new Date(),
        }),
      );

      // 新设备登录通知：推给同账号全部在线设备（含本设备，客户端按 device_id 自行忽略）
      // 仅当已是第 2 台以上设备时才打扰用户；首台登录不推。
      // 注意：只有真正新建设备时才推，重复登录复用记录不应打扰
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
    }

    // V6.0 会话策略（SESSION_POLICY=allow|notify|single）+ 设备数上限
    // 放在设备落库之后、签发 token 之前：single 模式下先踢旧设备再发 token，
    // 避免"新设备登录失败导致两边都掉线"。
    await this.applySessionPolicy(user.id, device, meta.ip);

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
      // 登录即返回 topic / default_burn_ttl_seconds（用户偏好）：前端登录后无需再拉一次 profile
      // 即可应用主题色与上次选择的默认焚毁时长（重启浏览器 / 换设备都不用重新选）
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
    updates: {
      display_name?: string;
      signature?: string;
      avatar_url?: string;
      topic?: string;
      /** 默认焚毁时长偏好（秒）：正整数 = 设置；null = 清除（默认不焚毁）；undefined = 不修改 */
      default_burn_ttl_seconds?: number | null;
    },
  ) {
    const userRepo = this.dataSource.getRepository(AppUser);
    const updateData: Partial<AppUser> = {};
    if (updates.display_name !== undefined) updateData.display_name = updates.display_name;
    if (updates.signature !== undefined) updateData.signature = updates.signature;
    if (updates.avatar_url !== undefined) updateData.avatar_url = updates.avatar_url;
    if (updates.topic !== undefined) updateData.topic = updates.topic;
    // 三态：undefined = 不修改（键都不进 updateData）；null = 显式清除偏好；正整数 = 设置时长
    if (updates.default_burn_ttl_seconds !== undefined) {
      updateData.default_burn_ttl_seconds = updates.default_burn_ttl_seconds;
    }

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

  /**
   * 设备心跳（V6.0）：客户端每 45~60 秒调一次，用于维护真实在线态。
   *
   * 为什么不能只靠 WS：移动端切后台/弱网会静默断连且不触发 disconnect，
   * 也可能走 HTTP 轮询而不连 WS；心跳是"人还在用"的最可靠信号。
   *
   * 返回 server_time + online_ttl，方便客户端校准本地时钟与判断自己的心跳节奏。
   */
  async heartbeat(userId: string, deviceRecordId: string) {
    const repo = this.dataSource.getRepository(Device);
    const device = await repo.findOne({ where: { id: deviceRecordId, user_id: userId } });
    if (!device) throw new NotFoundException('设备已下线，请重新登录');

    const now = new Date();
    await repo.update(deviceRecordId, {
      last_active_at: now,
      is_online: true,
      // 首次上线时记录 online_at；已在线则保持不变（不重置在线时长统计）
      online_at: device.online_at ?? now,
      offline_at: null,
    });
    return {
      server_time: now.toISOString(),
      online_ttl: this.onlineTtlSeconds(),
    };
  }

  /** 在线判定 TTL（秒）：与 PresenceScheduler 保持一致 */
  private onlineTtlSeconds(): number {
    const n = parseInt(process.env.ONLINE_TTL_SECONDS || '150', 10);
    return Number.isFinite(n) && n > 0 ? n : 150;
  }

  /** 会话策略：allow | notify | single（非法值按 notify 处理） */
  private sessionPolicy(): 'allow' | 'notify' | 'single' {
    const v = (process.env.SESSION_POLICY || 'notify').toLowerCase();
    return v === 'allow' || v === 'single' ? v : 'notify';
  }

  /** 单账号设备数上限：<=0 表示不限制 */
  private maxDevicesPerUser(): number {
    const n = parseInt(process.env.MAX_DEVICES_PER_USER || '5', 10);
    return Number.isFinite(n) ? n : 5;
  }

  /**
   * 登录后的会话策略处理（V6.0）。
   *
   * - allow  ：允许多端并存，不提示（最宽松）
   * - notify ：允许多端并存，向**其他在线设备**推 session:conflict（默认，弹窗提醒）
   * - single ：踢掉该账号其他所有设备（单点登录）
   *
   * 另外无论哪种策略都执行 MAX_DEVICES_PER_USER 上限：超出时按最近活跃时间
   * 淘汰最久未用的设备，避免设备表无限膨胀。
   */
  private async applySessionPolicy(userId: string, current: Device, ip?: string): Promise<void> {
    const deviceRepo = this.dataSource.getRepository(Device);
    const policy = this.sessionPolicy();

    const others = (
      await deviceRepo.find({ where: { user_id: userId }, order: { last_active_at: 'DESC' } })
    ).filter((d) => d.id !== current.id);

    const at = new Date().toISOString();
    const newDevice = {
      id: current.id,
      name: current.device_name,
      ip: ip ?? null,
      at,
    };

    if (policy === 'single' && others.length > 0) {
      // 单点登录：删记录 → JWT 守卫下次请求即 401；同时精准通知被踢设备
      for (const d of others) {
        await deviceRepo.delete({ id: d.id });
        this.authCache.invalidate(userId, d.id);
        this.events.emitToDevices(WS_EVENTS.SESSION_CONFLICT, [d.id], {
          reason: 'kicked_by_new_login',
          new_device: newDevice,
          at,
        });
      }
      await this.audit.log({
        userId,
        action: 'session_kicked_by_new_login',
        detail: `policy=single kicked=${others.length}`,
        ipAddress: ip,
      });
      return;
    }

    if (policy === 'notify' && others.length > 0) {
      // 多端并存但提醒：只推给其他设备（不推给新登录的这台，减少一次无用弹窗）
      this.events.emitToDevices(
        WS_EVENTS.SESSION_CONFLICT,
        others.map((d) => d.id),
        { reason: 'new_device_login', new_device: newDevice, at },
      );
    }

    // 设备数上限（所有策略都执行）
    const max = this.maxDevicesPerUser();
    if (max > 0 && others.length + 1 > max) {
      const excess = others.slice(max - 1); // others 已按 last_active_at DESC
      for (const d of excess) {
        await deviceRepo.delete({ id: d.id });
        this.authCache.invalidate(userId, d.id);
        this.events.emitToDevices(WS_EVENTS.DEVICE_REMOVED, [d.id], { device_id: d.id });
      }
      await this.audit.log({
        userId,
        action: 'device_limit_exceeded',
        detail: `max=${max} evicted=${excess.length}`,
        ipAddress: ip,
      });
    }
  }
}

import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import { AuthService } from 'src/modules/auth/auth.service';
import { AppUser, sanitizeUser, sanitizeUserWithPrefs } from 'src/entities/app-user.entity';
import { Device } from 'src/entities/device.entity';
import { AuditService } from 'src/modules/audit/audit.service';
import { TokenService } from 'src/modules/auth/token.service';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import { EventsGateway } from 'src/modules/events/events.gateway';

/**
 * 用户主题色 topic 单测（V5.8 用户自选前端主题色）。
 * 覆盖：登录响应带 topic / GET profile 返回 topic / PUT profile 可改 topic（不传不动）/
 *       sanitizeUser（通讯录等出口）不暴露 topic，sanitizeUserWithPrefs（profile 出口）带 topic。
 */

const baseUser = {
  id: 'u-1',
  phone: '13800000000',
  password_hash: 'hash',
  display_name: '萝卜',
  avatar_url: null,
  signature: null,
  topic: 'dark',
  department: '技术部',
  role: 'user' as const,
  status: 'active' as const,
  force_change_pwd: false,
  login_fail_count: 0,
  locked_until: null,
  deleted_at: null,
  created_at: new Date('2026-08-01T00:00:00Z'),
  updated_at: new Date('2026-08-01T00:00:00Z'),
};

describe('AuthService topic（用户主题色）', () => {
  let service: AuthService;
  let userRepo: { findOne: jest.Mock; update: jest.Mock };
  let deviceRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; count: jest.Mock };
  let tokenService: { issueTokenPair: jest.Mock };

  beforeEach(() => {
    jest.restoreAllMocks();

    userRepo = { findOne: jest.fn(), update: jest.fn() };
    deviceRepo = {
      findOne: jest.fn(),
      create: jest.fn((x: any) => x),
      save: jest.fn((x: any) => ({ ...x, id: 'd-1' })),
      count: jest.fn().mockResolvedValue(1),
    };
    const dataSource = {
      getRepository: jest.fn((entity: any) => (entity === AppUser ? userRepo : deviceRepo)),
    } as unknown as DataSource;

    tokenService = {
      issueTokenPair: jest.fn(() => ({ access_token: 'at', refresh_token: 'rt', expires_in: 7200 })),
    };
    const audit = { log: jest.fn() };
    const authCache = { invalidate: jest.fn() };
    const events = { emitToUsers: jest.fn() };

    jest.spyOn(argon2, 'verify').mockResolvedValue(true as never);

    service = new AuthService(
      dataSource,
      audit as unknown as AuditService,
      tokenService as unknown as TokenService,
      authCache as unknown as AuthCacheService,
      events as unknown as EventsGateway,
    );
  });

  it('登录成功：响应 user 带 topic，换设备登录即可恢复主题', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser });

    const result = await service.login('13800000000', 'pw', { deviceName: 'P40', deviceType: 'mobile' }, {});

    expect(result.user).toMatchObject({ id: 'u-1', topic: 'dark' });
    expect(result.user).not.toHaveProperty('password_hash');
  });

  it('topic 为 null 的存量行（迁移前数据）：登录响应兜底为 default', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser, topic: null as unknown as string });

    const result = await service.login('13800000000', 'pw', { deviceName: 'P40', deviceType: 'mobile' }, {});

    expect(result.user).toMatchObject({ topic: 'default' });
  });

  it('GET profile：返回本人 topic', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser });

    const profile = await service.getProfile('u-1');

    expect(profile).toMatchObject({ id: 'u-1', topic: 'dark' });
  });

  it('PUT profile 传 topic：落库并返回新 topic', async () => {
    userRepo.findOne
      .mockResolvedValueOnce({ ...baseUser }) // update 后回查
      .mockResolvedValueOnce({ ...baseUser, topic: 'blue' });
    userRepo.update.mockResolvedValue({ affected: 1 });

    const updated = await service.updateProfile('u-1', { topic: 'blue' });

    expect(userRepo.update).toHaveBeenCalledWith('u-1', { topic: 'blue' });
    expect(updated).toMatchObject({ topic: 'blue' });
  });

  it('PUT profile 不传 topic：不动 topic 字段（与其他资料字段同语义）', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser });

    await service.updateProfile('u-1', { display_name: '新名字' });

    expect(userRepo.update).toHaveBeenCalledWith('u-1', { display_name: '新名字' });
  });

  it('sanitizeUser（通讯录/成员等出口）不暴露 topic；sanitizeUserWithPrefs（profile 出口）带 topic', () => {
    const safe = sanitizeUser({ ...baseUser } as AppUser);
    const withPrefs = sanitizeUserWithPrefs({ ...baseUser } as AppUser);

    expect(safe).not.toHaveProperty('topic');
    expect(safe).toMatchObject({ id: 'u-1', display_name: '萝卜' });
    expect(withPrefs).toMatchObject({ id: 'u-1', topic: 'dark' });
  });

  it('设备登记与多端推送不受影响（回归：首台登录不推 DEVICE_ADDED）', async () => {
    const eventsSpy = (service as any).events as { emitToUsers: jest.Mock };
    userRepo.findOne.mockResolvedValue({ ...baseUser });

    await service.login('13800000000', 'pw', { deviceName: 'P40', deviceType: 'mobile' }, {});

    expect(deviceRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u-1', device_name: 'P40', device_type: 'mobile' }),
    );
    expect(eventsSpy.emitToUsers).not.toHaveBeenCalled();
  });

  it('登录传 device_id 且记录已存在：复用设备记录，不新建不推送（fbs 设备去重合并回归）', async () => {
    const eventsSpy = (service as any).events as { emitToUsers: jest.Mock };
    userRepo.findOne.mockResolvedValue({ ...baseUser });
    deviceRepo.findOne.mockResolvedValue({
      id: 'd-old',
      user_id: 'u-1',
      device_id: 'dev-x',
      device_name: '旧名',
      device_type: 'mobile',
      is_online: false,
      last_active_at: new Date('2026-08-01T00:00:00Z'),
    });

    const result = await service.login(
      '13800000000',
      'pw',
      { deviceName: 'P40', deviceType: 'mobile', deviceId: 'dev-x' },
      {},
    );

    // 复用分支：不 create 新记录；刷新名称与在线状态；重复登录不应打扰用户
    expect(deviceRepo.create).not.toHaveBeenCalled();
    expect(result.device).toMatchObject({ id: 'd-old', device_name: 'P40', is_online: true });
    expect(eventsSpy.emitToUsers).not.toHaveBeenCalled();
  });

  it('登录传 device_id 但无记录：按客户端 device_id 新建（不另起随机 UUID）', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser });
    deviceRepo.findOne.mockResolvedValue(null);

    await service.login(
      '13800000000',
      'pw',
      { deviceName: 'P40', deviceType: 'mobile', deviceId: 'dev-new' },
      {},
    );

    expect(deviceRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u-1', device_id: 'dev-new' }),
    );
  });
});

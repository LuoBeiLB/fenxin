// TS5 下 `import * as argon2` 的属性是 non-configurable getter，整模块 mock 才能替换（同 auth.service.spec.ts）
jest.mock('argon2');

import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import { AuthService } from 'src/modules/auth/auth.service';
import { AppUser } from 'src/entities/app-user.entity';
import { Device } from 'src/entities/device.entity';

/**
 * 会话策略单测（V6.0）：SESSION_POLICY = allow | notify | single + 设备数上限。
 *
 * 覆盖：
 *  - notify：向其他设备推 session:conflict（不推给自己），不删任何设备
 *  - single：删除其他设备 + 失效鉴权缓存 + 推 kicked_by_new_login
 *  - allow ：不发任何冲突事件
 *  - 只有一台设备：不推冲突事件
 *  - MAX_DEVICES_PER_USER：超出时按 last_active_at 淘汰最久未用的
 *  - 所有人工/自动处置写审计
 */

const mockedArgon2 = argon2 as jest.Mocked<typeof argon2>;

const baseUser = {
  id: 'u-1',
  phone: '13800000000',
  password_hash: 'hash',
  display_name: '萝卜',
  avatar_url: null,
  signature: null,
  topic: 'dark',
  default_burn_ttl_seconds: null,
  department: null,
  role: 'user',
  status: 'active',
  force_change_pwd: false,
  login_fail_count: 0,
  locked_until: null,
  deleted_at: null,
  created_at: new Date('2026-08-01T00:00:00Z'),
  updated_at: new Date('2026-08-01T00:00:00Z'),
};

function otherDevice(id: string, minutesAgo: number, name = `旧设备-${id}`) {
  return {
    id,
    user_id: 'u-1',
    device_name: name,
    device_type: 'android',
    device_id: `fp-${id}`,
    is_online: true,
    socket_count: 0,
    online_at: new Date(),
    offline_at: null,
    last_active_at: new Date(Date.now() - minutesAgo * 60_000),
    created_at: new Date(),
  };
}

function buildService(opts: { others?: any[] } = {}) {
  const userRepo = { findOne: jest.fn(async () => ({ ...baseUser })), update: jest.fn() };
  const deviceRepo = {
    findOne: jest.fn(async () => null), // 视为新设备
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => ({ ...x, id: 'd-new' })),
    count: jest.fn(async () => 1),
    find: jest.fn(async () => opts.others ?? []),
    delete: jest.fn(),
  };
  const dataSource = {
    getRepository: jest.fn((entity: any) => (entity === AppUser ? userRepo : deviceRepo)),
  } as unknown as DataSource;

  const tokenService = { issueTokenPair: jest.fn(() => ({ access_token: 'at', refresh_token: 'rt' })) };
  const audit = { log: jest.fn() };
  const authCache = { invalidate: jest.fn() };
  const events = { emitToUsers: jest.fn(), emitToDevices: jest.fn() };

  const service = new AuthService(
    dataSource,
    audit as any,
    tokenService as any,
    authCache as any,
    events as any,
  );

  return { service, userRepo, deviceRepo, audit, authCache, events };
}

const LOGIN_ARGS = [
  '13800000000',
  'Passw0rd!',
  { deviceName: '新手机', deviceType: 'android', deviceId: 'fp-new' },
  { ip: '1.2.3.4', userAgent: 'jest' },
] as const;

describe('会话策略（V6.0）', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedArgon2.verify.mockResolvedValue(true);
    delete process.env.SESSION_POLICY;
    delete process.env.MAX_DEVICES_PER_USER;
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('notify（默认）：向其他设备推 session:conflict，不删设备', async () => {
    process.env.SESSION_POLICY = 'notify';
    const others = [otherDevice('d-old-1', 5), otherDevice('d-old-2', 60)];
    const { service, events, deviceRepo, authCache } = buildService({ others });

    await service.login(...LOGIN_ARGS);

    expect(events.emitToDevices).toHaveBeenCalledWith(
      'session:conflict',
      ['d-old-1', 'd-old-2'],
      expect.objectContaining({
        reason: 'new_device_login',
        new_device: expect.objectContaining({ id: 'd-new', name: '新手机', ip: '1.2.3.4' }),
      }),
    );
    expect(deviceRepo.delete).not.toHaveBeenCalled();
    expect(authCache.invalidate).not.toHaveBeenCalled();
  });

  it('single：删掉其他设备 + 失效缓存 + 推 kicked_by_new_login + 写审计', async () => {
    process.env.SESSION_POLICY = 'single';
    const others = [otherDevice('d-old-1', 5), otherDevice('d-old-2', 60)];
    const { service, events, deviceRepo, authCache, audit } = buildService({ others });

    await service.login(...LOGIN_ARGS);

    expect(deviceRepo.delete).toHaveBeenCalledTimes(2);
    expect(deviceRepo.delete).toHaveBeenCalledWith({ id: 'd-old-1' });
    expect(deviceRepo.delete).toHaveBeenCalledWith({ id: 'd-old-2' });
    expect(authCache.invalidate).toHaveBeenCalledWith('u-1', 'd-old-1');
    expect(events.emitToDevices).toHaveBeenCalledWith(
      'session:conflict',
      ['d-old-1'],
      expect.objectContaining({ reason: 'kicked_by_new_login' }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session_kicked_by_new_login' }),
    );
  });

  it('allow：不推任何冲突事件、不删设备', async () => {
    process.env.SESSION_POLICY = 'allow';
    const { service, events, deviceRepo } = buildService({ others: [otherDevice('d-old-1', 5)] });

    await service.login(...LOGIN_ARGS);

    expect(events.emitToDevices).not.toHaveBeenCalledWith('session:conflict', expect.anything(), expect.anything());
    expect(deviceRepo.delete).not.toHaveBeenCalled();
  });

  it('只有一台设备：不发冲突事件', async () => {
    process.env.SESSION_POLICY = 'notify';
    const { service, events } = buildService({ others: [] });

    await service.login(...LOGIN_ARGS);

    expect(events.emitToDevices).not.toHaveBeenCalledWith(
      'session:conflict',
      expect.anything(),
      expect.anything(),
    );
  });

  it('MAX_DEVICES_PER_USER=2：超出时淘汰最久未活跃的设备', async () => {
    process.env.SESSION_POLICY = 'notify';
    process.env.MAX_DEVICES_PER_USER = '2';
    // others 已按 last_active_at DESC：d-old-1 更近、d-old-2 更久
    const others = [otherDevice('d-old-1', 5), otherDevice('d-old-2', 120)];
    const { service, deviceRepo, audit } = buildService({ others });

    await service.login(...LOGIN_ARGS);

    // 上限 2 台：新设备 + d-old-1 保留，淘汰 d-old-2
    expect(deviceRepo.delete).toHaveBeenCalledWith({ id: 'd-old-2' });
    expect(deviceRepo.delete).not.toHaveBeenCalledWith({ id: 'd-old-1' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'device_limit_exceeded' }),
    );
  });

  it('MAX_DEVICES_PER_USER=0：不限制设备数', async () => {
    process.env.MAX_DEVICES_PER_USER = '0';
    const others = [otherDevice('d-1', 1), otherDevice('d-2', 2), otherDevice('d-3', 3)];
    const { service, deviceRepo } = buildService({ others });

    await service.login(...LOGIN_ARGS);

    expect(deviceRepo.delete).not.toHaveBeenCalled();
  });

  it('非法 SESSION_POLICY 值：按 notify 兜底（不会静默变成 allow）', async () => {
    process.env.SESSION_POLICY = 'whatever';
    const others = [otherDevice('d-old-1', 5)];
    const { service, events } = buildService({ others });

    await service.login(...LOGIN_ARGS);

    expect(events.emitToDevices).toHaveBeenCalledWith(
      'session:conflict',
      ['d-old-1'],
      expect.objectContaining({ reason: 'new_device_login' }),
    );
  });
});

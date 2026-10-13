// 必须在所有 import 之前：TS5 的 `import * as argon2` 会把模块包装成
// non-configurable getter 属性，jest.spyOn(argon2, 'verify') 报 "Cannot redefine property"
// （同款坑与解法见 test/modules/auth/auth.service.spec.ts 顶部注释）。
jest.mock('argon2');

import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import { AuthService } from 'src/modules/auth/auth.service';
import { AppUser, sanitizeUser, sanitizeUserWithPrefs } from 'src/entities/app-user.entity';
import { AuditService } from 'src/modules/audit/audit.service';
import { TokenService } from 'src/modules/auth/token.service';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import { EventsGateway } from 'src/modules/events/events.gateway';
import { UpdateProfileDto } from 'src/modules/auth/dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

const mockedArgon2 = argon2 as jest.Mocked<typeof argon2>;

/**
 * 用户默认焚毁时长偏好 single-field（V5.9.4）单测。
 *
 * 覆盖：
 *  1. 出口：登录响应 / GET profile 带 default_burn_ttl_seconds；safe 白名单出口不带（不泄露他人偏好）
 *  2. 三态写入：正整数 = 设置；显式 null = 清除；不传 = 不变
 *  3. 存量行兜底：迁移前旧行（字段缺失/undefined/null/0/负数）统一归一化为 null = 默认不焚毁
 *  4. DTO 校验：合法值通过；越界 / 非整数 / 字符串数字被拦；显式 null 必须放行
 */

const baseUser = {
  id: 'u-1',
  phone: '13800000000',
  password_hash: 'hash',
  display_name: '萝卜',
  avatar_url: null,
  signature: null,
  topic: 'dark',
  default_burn_ttl_seconds: 600 as number | null,
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

describe('AuthService 默认焚毁时长偏好（default_burn_ttl_seconds）', () => {
  let service: AuthService;
  let userRepo: { findOne: jest.Mock; update: jest.Mock };
  let deviceRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; count: jest.Mock };

  beforeEach(() => {
    jest.restoreAllMocks();

    userRepo = { findOne: jest.fn(), update: jest.fn().mockResolvedValue({ affected: 1 }) };
    deviceRepo = {
      findOne: jest.fn(),
      create: jest.fn((x: any) => x),
      save: jest.fn((x: any) => ({ ...x, id: 'd-1' })),
      count: jest.fn().mockResolvedValue(1),
    };
    const dataSource = {
      getRepository: jest.fn((entity: any) => (entity === AppUser ? userRepo : deviceRepo)),
    } as unknown as DataSource;

    const tokenService = {
      issueTokenPair: jest.fn(() => ({ access_token: 'at', refresh_token: 'rt', expires_in: 7200 })),
    };

    mockedArgon2.verify.mockResolvedValue(true);

    service = new AuthService(
      dataSource,
      { log: jest.fn() } as unknown as AuditService,
      tokenService as unknown as TokenService,
      { invalidate: jest.fn() } as unknown as AuthCacheService,
      { emitToUsers: jest.fn() } as unknown as EventsGateway,
    );
  });

  // ===== 1. 出口 =====

  it('登录成功：响应 user 带 default_burn_ttl_seconds，重启浏览器/换设备登录即可恢复上次选择', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser });

    const result = await service.login('13800000000', 'pw', { deviceName: 'P40', deviceType: 'mobile' }, {});

    expect(result.user).toMatchObject({ id: 'u-1', default_burn_ttl_seconds: 600 });
  });

  it('GET profile：返回本人 default_burn_ttl_seconds', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser, default_burn_ttl_seconds: 86400 });

    const profile = await service.getProfile('u-1');

    expect(profile).toMatchObject({ id: 'u-1', default_burn_ttl_seconds: 86400 });
  });

  it('存量行兜底：字段缺失 / undefined / null / 0 / 负数 一律归一化为 null（默认不焚毁）', () => {
    const missing = { ...baseUser } as any;
    delete missing.default_burn_ttl_seconds;

    expect(sanitizeUserWithPrefs(missing as AppUser)).toMatchObject({
      default_burn_ttl_seconds: null,
    });
    expect(
      sanitizeUserWithPrefs({ ...baseUser, default_burn_ttl_seconds: undefined } as unknown as AppUser),
    ).toMatchObject({ default_burn_ttl_seconds: null });
    expect(sanitizeUserWithPrefs({ ...baseUser, default_burn_ttl_seconds: null })).toMatchObject({
      default_burn_ttl_seconds: null,
    });
    expect(sanitizeUserWithPrefs({ ...baseUser, default_burn_ttl_seconds: 0 })).toMatchObject({
      default_burn_ttl_seconds: null,
    });
    expect(sanitizeUserWithPrefs({ ...baseUser, default_burn_ttl_seconds: -5 })).toMatchObject({
      default_burn_ttl_seconds: null,
    });
  });

  it('sanitizeUser（通讯录/成员等出口）不暴露 default_burn_ttl_seconds；sanitizeUserWithPrefs（profile 出口）带', () => {
    const safe = sanitizeUser({ ...baseUser } as AppUser);
    const withPrefs = sanitizeUserWithPrefs({ ...baseUser } as AppUser);

    expect(safe).not.toHaveProperty('default_burn_ttl_seconds');
    expect(safe).not.toHaveProperty('topic');
    expect(withPrefs).toMatchObject({ default_burn_ttl_seconds: 600, topic: 'dark' });
  });

  // ===== 2. 三态写入 =====

  it('PUT profile 传正整数：落库并返回新值（例：10 分钟 = 600）', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser, default_burn_ttl_seconds: 600 });

    const updated = await service.updateProfile('u-1', { default_burn_ttl_seconds: 600 });

    expect(userRepo.update).toHaveBeenCalledWith('u-1', { default_burn_ttl_seconds: 600 });
    expect(updated).toMatchObject({ default_burn_ttl_seconds: 600 });
  });

  it('PUT profile 传 1 天（86400）：落库并返回', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser, default_burn_ttl_seconds: 86400 });

    const updated = await service.updateProfile('u-1', { default_burn_ttl_seconds: 86400 });

    expect(userRepo.update).toHaveBeenCalledWith('u-1', { default_burn_ttl_seconds: 86400 });
    expect(updated).toMatchObject({ default_burn_ttl_seconds: 86400 });
  });

  it('PUT profile 显式传 null：清除偏好 = 默认不焚毁（键要进 updateData，不能当"不传"处理）', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser, default_burn_ttl_seconds: null });

    const updated = await service.updateProfile('u-1', { default_burn_ttl_seconds: null });

    expect(userRepo.update).toHaveBeenCalledWith('u-1', { default_burn_ttl_seconds: null });
    expect(updated).toMatchObject({ default_burn_ttl_seconds: null });
  });

  it('PUT profile 不传该字段：完全不动它（updateData 里连键都没有，避免误清空用户偏好）', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser });

    await service.updateProfile('u-1', { display_name: '新名字' });

    expect(userRepo.update).toHaveBeenCalledWith('u-1', { display_name: '新名字' });
    const passedUpdate = userRepo.update.mock.calls[0][1] as Record<string, unknown>;
    expect(passedUpdate).not.toHaveProperty('default_burn_ttl_seconds');
  });

  it('PUT profile 与 topic 同时提交：两个偏好一起落库（互不干扰）', async () => {
    userRepo.findOne.mockResolvedValue({ ...baseUser, topic: 'blue', default_burn_ttl_seconds: 300 });

    await service.updateProfile('u-1', { topic: 'blue', default_burn_ttl_seconds: 300 });

    expect(userRepo.update).toHaveBeenCalledWith('u-1', { topic: 'blue', default_burn_ttl_seconds: 300 });
  });
});

// ===== 4. DTO 校验（走真实 class-validator + class-transformer 管道）=====

describe('UpdateProfileDto 默认焚毁时长校验', () => {
  const validateField = async (value: unknown) => {
    const dto = plainToInstance(UpdateProfileDto, { default_burn_ttl_seconds: value } as any);
    return validate(dto as object);
  };

  it('合法值：1 秒 / 600（10 分钟）/ 86400（1 天）/ 2592000（30 天上界）均通过', async () => {
    for (const v of [1, 600, 86400, 2592000]) {
      expect(await validateField(v)).toHaveLength(0);
    }
  });

  it('字符串数字 "600" 通过（与全局 ValidationPipe 的隐式转换一致）', async () => {
    expect(await validateField('600')).toHaveLength(0);
  });

  it('显式 null 通过：null 是"清除偏好"的合法语义，必须放行', async () => {
    expect(await validateField(null)).toHaveLength(0);
  });

  it('0 / 负数：拦截（0 会让 burn_at 立刻到期，语义混乱，用 null 表达"不焚毁"）', async () => {
    expect((await validateField(0)).length).toBeGreaterThan(0);
    expect((await validateField(-1)).length).toBeGreaterThan(0);
  });

  it('超过 30 天上界：拦截（防把毫秒当秒填，如 86400000）', async () => {
    expect((await validateField(2592001)).length).toBeGreaterThan(0);
    expect((await validateField(86400000)).length).toBeGreaterThan(0);
  });

  it('非整数：拦截（1.5 秒无意义）', async () => {
    expect((await validateField(1.5)).length).toBeGreaterThan(0);
  });

  it('不传该字段：合法（PUT profile 其余字段可单独提交）', async () => {
    const dto = plainToInstance(UpdateProfileDto, { display_name: '张三' } as any);
    expect(await validate(dto as object)).toHaveLength(0);
  });
});

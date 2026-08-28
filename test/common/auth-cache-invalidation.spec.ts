// 必须在所有 import 之前：argon2 是 native binding，属性是 non-configurable getter，
// 普通的 jest.spyOn(argon2, 'verify') 会报 "Cannot redefine property"。
// 用 jest.mock 整模块替换成 jest 自动 mock（属性都是 jest.fn()），就能 re-define。
jest.mock('argon2');

import * as argon2 from 'argon2';
import { AuthService } from 'src/modules/auth/auth.service';
import { AccountService } from 'src/modules/account/account.service';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import { AuditService } from 'src/modules/audit/audit.service';

const mockedArgon2 = argon2 as jest.Mocked<typeof argon2>;

/**
 * 验证"业务状态变化 → 主动失效鉴权缓存"链路。
 *
 * 覆盖 4 个关键路径：
 *   1. AuthService.changePassword      → invalidate(userId)
 *   2. AuthService.removeDevice        → invalidate(userId, deviceId)
 *   3. AccountService.toggleAccountStatus(disabled) → invalidate(userId)
 *   4. AccountService.toggleAccountStatus(active)   → invalidate(userId)
 *   5. AccountService.resetPassword    → invalidate(targetUserId)
 *
 * 不接 DB：用 jest.fn 替身 DataSource / AuditService；业务链路上其他依赖
 * 用最小化的 mock 撑过去，目的就是验证 invalidate 一定被调到。
 */
describe('业务状态变化 → AuthCache.invalidate', () => {
  const makeAuthCacheMock = (): jest.Mocked<AuthCacheService> =>
    ({
      invalidate: jest.fn().mockReturnValue(0),
      get: jest.fn().mockReturnValue(null),
      set: jest.fn(),
      isEnabled: jest.fn().mockReturnValue(true),
      size: jest.fn().mockReturnValue(0),
      onModuleDestroy: jest.fn(),
    } as unknown as jest.Mocked<AuthCacheService>);

  // ===== AuthService =====
  describe('AuthService', () => {
    let svc: AuthService;
    let authCache: jest.Mocked<AuthCacheService>;
    let dataSource: any;

    beforeEach(() => {
      jest.clearAllMocks();
      authCache = makeAuthCacheMock();
      const userRepo = {
        findOne: jest.fn().mockResolvedValue({
          id: 'u1',
          password_hash: 'hashed-old',
        }),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const deviceRepo = {
        findOne: jest.fn(),
        save: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
        count: jest.fn(),
        create: jest.fn(),
      };
      dataSource = {
        getRepository: (entity: any) => {
          const name = entity?.name || entity?.constructor?.name || '';
          if (name === 'Device') return deviceRepo;
          return userRepo;
        },
        transaction: async (cb: any) => cb({ getRepository: dataSource.getRepository }),
      };
      const audit = {
        log: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuditService;
      const tokenService = {} as any;
      // master 版 AuthService 第 5 参是 EventsGateway（WS 推送），最小 mock 只需 emitToUsers
      const events = {
        emitToUsers: jest.fn(),
      } as any;

      svc = new AuthService(dataSource, audit, tokenService, authCache, events);

      // mock 后的 argon2 是 jest auto-mock，属性可重定义
      mockedArgon2.verify.mockResolvedValue(true);
      mockedArgon2.hash.mockResolvedValue('hashed-new' as any);
    });

    it('changePassword 成功后 → invalidate(userId) 清该用户所有 device 缓存', async () => {
      await svc.changePassword('u1', 'old', 'new');
      expect(authCache.invalidate).toHaveBeenCalledTimes(1);
      expect(authCache.invalidate).toHaveBeenCalledWith('u1');
    });

    it('removeDevice → invalidate(userId, deviceId) 单条清除（DB 删 + 缓存失效 = 0 延迟踢出）', async () => {
      await svc.removeDevice('u1', 'd1');
      expect(authCache.invalidate).toHaveBeenCalledTimes(1);
      expect(authCache.invalidate).toHaveBeenCalledWith('u1', 'd1');
    });
  });

  // ===== AccountService =====
  describe('AccountService', () => {
    let svc: AccountService;
    let authCache: jest.Mocked<AuthCacheService>;
    let dataSource: any;

    beforeEach(() => {
      jest.clearAllMocks();
      authCache = makeAuthCacheMock();

      const userRepo = {
        findOne: jest.fn().mockResolvedValue({ id: 'u1', password_hash: 'h' }),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        save: jest.fn(),
        create: jest.fn(),
        createQueryBuilder: jest.fn(),
      };
      const deviceRepo = {
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
        findOne: jest.fn(),
        save: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      };
      dataSource = {
        getRepository: (entity: any) => {
          const name = entity?.name || entity?.constructor?.name || '';
          if (name === 'Device') return deviceRepo;
          return userRepo;
        },
        transaction: async (cb: any) =>
          cb({ getRepository: dataSource.getRepository }),
      };
      const audit = {
        log: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuditService;
      // v5.4 起构造新增 GroupService（注销级联解散群主群）；本套件不触达注销流程，给最小 mock
      const groupService = {
        dissolveGroupsOnAccountDelete: jest.fn().mockResolvedValue({ total: 0, dissolved: 0 }),
      };
      svc = new AccountService(dataSource, audit, authCache, groupService as any);

      mockedArgon2.hash.mockResolvedValue('hashed-new' as any);
    });

    it('toggleAccountStatus(disabled) → 事务内删 device + 事务外 invalidate(userId)', async () => {
      const deviceRepo = dataSource.getRepository({ name: 'Device' } as any);
      await svc.toggleAccountStatus('u1', 'disabled', 'admin1');
      expect(deviceRepo.delete).toHaveBeenCalledWith({ user_id: 'u1' });
      expect(authCache.invalidate).toHaveBeenCalledTimes(1);
      expect(authCache.invalidate).toHaveBeenCalledWith('u1');
    });

    it('toggleAccountStatus(active) → 事务内只改 status + 事务外 invalidate(userId)', async () => {
      const deviceRepo = dataSource.getRepository({ name: 'Device' } as any);
      await svc.toggleAccountStatus('u1', 'active', 'admin1');
      // 启用不删 device
      expect(deviceRepo.delete).not.toHaveBeenCalled();
      expect(authCache.invalidate).toHaveBeenCalledTimes(1);
      expect(authCache.invalidate).toHaveBeenCalledWith('u1');
    });

    it('resetPassword → invalidate(targetUserId)（force_change_pwd 字段变了）', async () => {
      await svc.resetPassword('u1', 'admin1');
      expect(authCache.invalidate).toHaveBeenCalledTimes(1);
      expect(authCache.invalidate).toHaveBeenCalledWith('u1');
    });
  });
});

import { AuthCacheService, CachedAuthContext } from '../../src/common/cache/auth-cache.service';

describe('AuthCacheService', () => {
  const makeCtx = (): Omit<CachedAuthContext, 'cachedAt'> => ({
    user: { id: 'u1', phone: '138', role: 'user', status: 'active', force_change_pwd: false, deleted_at: null },
    device: { id: 'd1', user_id: 'u1' },
  });

  describe('TTL > 0（默认）', () => {
    let svc: AuthCacheService;
    beforeEach(() => {
      process.env.AUTH_CACHE_TTL_MS = '30000';
      svc = new AuthCacheService();
    });

    it('set 后 get 命中', () => {
      const ctx = makeCtx();
      svc.set('u1', 'd1', ctx);
      const got = svc.get('u1', 'd1');
      expect(got).not.toBeNull();
      expect(got!.user.id).toBe('u1');
      expect(got!.device.id).toBe('d1');
    });

    it('过期返回 null 并清除条目', () => {
      process.env.AUTH_CACHE_TTL_MS = '1';
      const fresh = new AuthCacheService();
      fresh.set('u1', 'd1', makeCtx());
      // 10ms 后过期
      return new Promise((resolve) =>
        setTimeout(() => {
          expect(fresh.get('u1', 'd1')).toBeNull();
          expect(fresh.size()).toBe(0);
          resolve(undefined);
        }, 10),
      );
    });

    it('invalidate(userId, deviceId) 单条清除', () => {
      svc.set('u1', 'd1', makeCtx());
      svc.set('u1', 'd2', makeCtx());
      const removed = svc.invalidate('u1', 'd1');
      expect(removed).toBe(1);
      expect(svc.get('u1', 'd1')).toBeNull();
      expect(svc.get('u1', 'd2')).not.toBeNull();
    });

    it('invalidate(userId) 清该用户所有 device', () => {
      svc.set('u1', 'd1', makeCtx());
      svc.set('u1', 'd2', makeCtx());
      svc.set('u2', 'd3', makeCtx());
      const removed = svc.invalidate('u1');
      expect(removed).toBe(2);
      expect(svc.size()).toBe(1);
      expect(svc.get('u2', 'd3')).not.toBeNull();
    });

    it('invalidate() 全清', () => {
      svc.set('u1', 'd1', makeCtx());
      svc.set('u2', 'd2', makeCtx());
      const removed = svc.invalidate();
      expect(removed).toBe(2);
      expect(svc.size()).toBe(0);
    });

    it('device 维度隔离：同 user 不同 device 互不影响', () => {
      svc.set('u1', 'd1', makeCtx());
      const other: any = { user: { ...makeCtx().user, id: 'u1' }, device: { id: 'd2', user_id: 'u1' } };
      svc.set('u1', 'd2', other);
      expect(svc.size()).toBe(2);
      svc.invalidate('u1', 'd1');
      expect(svc.get('u1', 'd2')).not.toBeNull();
    });
  });

  describe('TTL = 0（关闭缓存）', () => {
    beforeEach(() => {
      process.env.AUTH_CACHE_TTL_MS = '0';
    });

    it('isEnabled() = false', () => {
      const svc = new AuthCacheService();
      expect(svc.isEnabled()).toBe(false);
    });

    it('set 不写，get 永远 null', () => {
      const svc = new AuthCacheService();
      svc.set('u1', 'd1', makeCtx());
      expect(svc.get('u1', 'd1')).toBeNull();
      expect(svc.size()).toBe(0);
    });
  });
});

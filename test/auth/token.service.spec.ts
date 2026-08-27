import { TokenService } from '../../src/modules/auth/token.service';
import { JwtService } from '@nestjs/jwt';

describe('TokenService', () => {
  let service: TokenService;
  const payload = {
    userId: 'u-1',
    phone: '13800000000',
    role: 'admin',
    deviceId: 'd-1',
  };

  beforeEach(() => {
    service = new TokenService(new JwtService({}));
  });

  it('签发与校验 access token 往返一致', () => {
    const token = service.signAccessToken(payload);
    const decoded = service.verifyAccessToken(token);
    expect(decoded.userId).toBe(payload.userId);
    expect(decoded.deviceId).toBe(payload.deviceId);
    expect(decoded.role).toBe(payload.role);
  });

  it('refresh token 带 type=refresh 标记', () => {
    const refresh = service.signRefreshToken(payload);
    const decoded: any = service.verifyRefreshToken(refresh);
    expect(decoded.type).toBe('refresh');
    expect(decoded.userId).toBe(payload.userId);
  });

  it('用 access secret 校验 refresh token 应当失败', () => {
    const refresh = service.signRefreshToken(payload);
    expect(() => service.verifyAccessToken(refresh)).toThrow();
  });

  it('用 refresh secret 校验 access token 应当失败', () => {
    const access = service.signAccessToken(payload);
    expect(() => service.verifyRefreshToken(access)).toThrow();
  });

  it('issueTokenPair 返回 access / refresh / expires_in', () => {
    const pair = service.issueTokenPair(payload);
    expect(pair.access_token).toMatch(/^eyJ/);
    expect(pair.refresh_token).toMatch(/^eyJ/);
    expect(typeof pair.expires_in).toBe('number');
    expect(pair.expires_in).toBeGreaterThan(0);
  });

  it('伪造 token 校验失败', () => {
    expect(() => service.verifyAccessToken('not-a-token')).toThrow();
  });
});

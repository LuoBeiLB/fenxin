import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';

const ACCESS_SECRET = () =>
  process.env.JWT_SECRET || 'burnmsg-jwt-secret-key-change-in-production';
const REFRESH_SECRET = () =>
  process.env.JWT_REFRESH_SECRET || 'burnmsg-refresh-secret-key-change-in-production';
const ACCESS_TTL = () => parseInt(process.env.ACCESS_TOKEN_TTL || '7200', 10); // 2h
const REFRESH_TTL = () => parseInt(process.env.REFRESH_TOKEN_TTL || '2592000', 10); // 30d

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  /** access token：短有效期（默认 2h），使用 JWT_SECRET */
  signAccessToken(payload: AuthPayload): string {
    return this.jwt.sign(payload, { secret: ACCESS_SECRET(), expiresIn: ACCESS_TTL() });
  }

  /** refresh token：独立密钥 JWT_REFRESH_SECRET，带 type 标记防混用 */
  signRefreshToken(payload: AuthPayload): string {
    return this.jwt.sign(
      { ...payload, type: 'refresh' },
      { secret: REFRESH_SECRET(), expiresIn: REFRESH_TTL() },
    );
  }

  verifyAccessToken(token: string): AuthPayload {
    return this.jwt.verify<AuthPayload>(token, { secret: ACCESS_SECRET() });
  }

  verifyRefreshToken(token: string): AuthPayload {
    const payload = this.jwt.verify<AuthPayload & { type?: string }>(token, {
      secret: REFRESH_SECRET(),
    });
    if ((payload as any).type !== 'refresh') {
      throw new Error('not a refresh token');
    }
    return payload;
  }

  issueTokenPair(payload: AuthPayload) {
    return {
      access_token: this.signAccessToken(payload),
      refresh_token: this.signRefreshToken(payload),
      expires_in: ACCESS_TTL(),
    };
  }
}

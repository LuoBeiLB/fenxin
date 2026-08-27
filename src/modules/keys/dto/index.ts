import { IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * X25519 公钥 base64 编码后的字符串。
 * 32 字节 → 标准 base64 44 字符（带 padding），URL-safe base64 43 字符（无 padding）。
 * 校验：43 或 44 字符，base64 字符集（A-Za-z0-9+/=-_）。
 */
const PUBKEY_BASE64_RE = /^[A-Za-z0-9+/_-]{43,44}$/;

export class UploadIdentityKeyDto {
  @ApiProperty({
    description: 'X25519 identity 公钥，base64 编码（32 字节 → 43-44 字符）',
    example: 'MCowBQYDK2VuAyEAj1Zs8a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4=',
  })
  @IsString()
  @Length(43, 44)
  @Matches(PUBKEY_BASE64_RE, { message: '公钥格式错误（需 32 字节 X25519 公钥的 base64 编码）' })
  identity_pubkey: string;
}

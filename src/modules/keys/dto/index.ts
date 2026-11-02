import { IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * X25519 公钥 base64 编码后的字符串。
 * 32 字节 → 标准 base64 44 字符（**结尾一个 =**），URL-safe/去填充 43 字符。
 *
 * 两种都接受（不同语言的标准库默认行为不同，例如 JS 的 btoa 带 '='、
 * Go 的 RawURLEncoding 不带），服务端统一**去掉尾部 '=' 后按 43 字符存储**。
 * 正则：43 个 base64 字符 + 可选的一个 '='。
 */
const PUBKEY_BASE64_RE = /^[A-Za-z0-9+/_-]{43}=?$/;

/**
 * 上传本设备的 X25519 identity 公钥。
 *
 * **不需要传 device_id**：服务端直接取 JWT 里的 `deviceId`，
 * 避免客户端伪造设备身份去覆盖其它设备的公钥。
 */
export class UploadDeviceKeyDto {
  @ApiProperty({
    description: 'X25519 identity 公钥，base64 编码（32 字节 → 43-44 字符）',
    example: 'MCowBQYDK2VuAyEAj1Zs8a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4=',
  })
  @IsString()
  @Length(43, 44)
  @Matches(PUBKEY_BASE64_RE, { message: '公钥格式错误（需 32 字节 X25519 公钥的 base64 编码）' })
  identity_pubkey: string;
}

import {
  IsString,
  Length,
  Matches,
  IsArray,
  ArrayNotEmpty,
  ArrayMaxSize,
  IsUUID,
} from 'class-validator';
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

/**
 * 批量查询公钥（TOFU 前端比对用）：App 启动 / 进群时一次拉一组联系人的公钥+更新时间，
 * 与本地钉住的公钥缓存比对，省去逐个 GET /keys/:userId。
 */
export class QueryIdentityKeysDto {
  @ApiProperty({
    description: '要查询的用户 ID 列表（最多 500 个；无共同会话的用户会被服务端过滤掉）',
    type: [String],
    example: ['3f9a2b8e-1111-4222-8333-444455556666'],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'user_ids 不能为空' })
  @ArrayMaxSize(500, { message: '单次最多查询 500 个用户' })
  @IsUUID('4', { each: true, message: 'user_ids 内必须是合法 UUID' })
  user_ids: string[];
}

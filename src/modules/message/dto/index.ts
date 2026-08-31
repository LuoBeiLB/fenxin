import { IsString, IsUUID, IsIn, IsOptional, IsNumber, MaxLength, Length, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** X25519 公钥 base64：32 字节 → 44 字符（含结尾 =） */
const PUBKEY_BASE64_RE = /^[A-Za-z0-9+/]{43}=$/;
/** AES-256-GCM nonce base64：12 字节 → 16 字符 */
const NONCE_BASE64_RE = /^[A-Za-z0-9+/]{16}$/;

export class SendMessageDto {
  @ApiProperty()
  @IsUUID()
  conversation_id: string;

  @ApiProperty({ enum: ['text', 'image', 'voice', 'video', 'file'] })
  @IsIn(['text', 'image', 'voice', 'video', 'file'])
  type: 'text' | 'image' | 'voice' | 'video' | 'file';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  file_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  file_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  file_size?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  reply_to_id?: string;

  @ApiPropertyOptional({ description: '点开才焚：点开查看后多少秒焚毁（如 5）。不传 = 普通消息。焚毁消息对全员（含发送方）先显示马赛克占位，调 POST /messages/:id/reveal 才下发内容并开始各自倒计时' })
  @IsOptional()
  @IsNumber()
  burn_ttl_seconds?: number;

  @ApiPropertyOptional({ description: 'E2E 加密：发送方临时 X25519 公钥（base64，44 字符）。三个加密字段必须同时提供' })
  @IsOptional()
  @IsString()
  @Length(44, 44)
  @Matches(PUBKEY_BASE64_RE, { message: 'sender_ephemeral_pubkey 格式错误' })
  sender_ephemeral_pubkey?: string;

  @ApiPropertyOptional({ description: 'E2E 加密：AES-256-GCM nonce（base64，16 字符）' })
  @IsOptional()
  @IsString()
  @Length(16, 16)
  @Matches(NONCE_BASE64_RE, { message: 'cipher_nonce 格式错误（需 12 字节 nonce 的 base64 编码）' })
  cipher_nonce?: string;

  @ApiPropertyOptional({ description: 'E2E 加密：AES-256-GCM 密文 + auth tag（base64）' })
  @IsOptional()
  @IsString()
  cipher_text?: string;
}

export class EditMessageDto {
  @ApiProperty()
  @IsString()
  content: string;
}

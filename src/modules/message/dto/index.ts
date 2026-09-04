import { IsString, IsUUID, IsIn, IsOptional, IsNumber, IsInt, Min, Max, MaxLength, Length, Matches, IsArray, ArrayMaxSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

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

  @ApiPropertyOptional({
    description: '@提及：被@的成员用户 ID 数组（前端 @ 选人后传入）。仅保留会话成员，非成员/重复 uid 自动过滤；前端据此精确判定「有人@我」，替代按昵称文本匹配（同名/改名会误判）',
    example: ['5e6f7a8b-9c0d-41e2-83f4-a5b6c7d8e9f0'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  mentions?: string[];
}

export class EditMessageDto {
  @ApiProperty()
  @IsString()
  content: string;
}

export class SearchMessagesDto {
  @ApiProperty({ description: '搜索关键词（trim 后 2~64 字符；单字无法命中 ngram 二元分词，返回 400）', example: '项目进度' })
  @IsString()
  keyword: string;

  @ApiPropertyOptional({ description: '限定会话 ID（UUID）；不传 = 搜索我所在的全部会话（权限仍在 SQL 层限定为我是成员的会话）' })
  @IsOptional()
  @IsUUID()
  conversation_id?: string;

  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页条数 1~50，默认 20', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 20;

  @ApiPropertyOptional({ description: '时间范围下界（ISO8601 日期或毫秒时间戳），只返回该时刻之后的消息' })
  @IsOptional()
  @IsString()
  after?: string;

  @ApiPropertyOptional({ description: '时间范围上界（ISO8601 日期或毫秒时间戳），只返回该时刻之前的消息' })
  @IsOptional()
  @IsString()
  before?: string;
}

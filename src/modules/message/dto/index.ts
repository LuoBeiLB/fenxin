import { IsString, IsUUID, IsIn, IsOptional, IsNumber, IsInt, Min, Max, MaxLength, Length, Matches, IsArray, ArrayMaxSize, ArrayNotEmpty } from 'class-validator';
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

  @ApiPropertyOptional({ description: '音视频时长（秒，v5.8.9 播完才焚）：语音=录音时长、视频=播放器 metadata duration。焚毁消息点开后的消费窗口 = max(burn_ttl_seconds, media_duration_seconds + 缓冲30s)，确保播完才焚；不传则 reveal 时走默认窗口' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7200)
  media_duration_seconds?: number;

  @ApiPropertyOptional({ description: '原图地址（v5.8.7）：file_url 为前端压缩版时，此字段存原图供下载原图。发送时可直接带，也可事后 PATCH /messages/:id/original-file 补传回填' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  file_original_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  reply_to_id?: string;

  @ApiPropertyOptional({ description: '点开才焚：点开查看后多少秒焚毁（如 5）。不传 = 普通消息。焚毁消息对全员（含发送方）先显示马赛克占位，调 POST /messages/:id/reveal 才下发内容并开始各自倒计时' })
  @IsOptional()
  @IsNumber()
  burn_ttl_seconds?: number;

  /**
   * 【已废弃】旧客户端（2026-09-09 之前的构建）发消息时传的是绝对销毁时间。
   * 当时后端直接落库；V5.6 起改为 burn_ttl_seconds，但 ValidationPipe 的
   * whitelist:true 会把该字段静默丢弃 → 老 APK 发的"焚毁消息"变成永久消息。
   * V6.0 起保留此字段做兼容：优先 burn_ttl_seconds，缺失时用 destroy_at 反算 ttl。
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: '【旧客户端兼容】绝对销毁时间（ISO8601）。新客户端请改用 burn_ttl_seconds',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  destroy_at?: string;

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

/**
 * POST /messages/:id/reveal body（v5.8.9 播完才焚）：音视频焚毁消息点开时可带媒体时长，
 * 后端据此计算「消费窗口」= max(用户设的 burn_ttl_seconds, 时长 + BURN_MEDIA_BUFFER_SECONDS)。
 * 时长优先用发送时存库的 media_duration，本参数仅在存库值缺失时兜底（老消息）。
 * 都不传 → 窗口用 BURN_MEDIA_DEFAULT_WINDOW_SECONDS 兜底。文本/图片焚毁消息忽略此参数（逻辑不变）。
 */
export class RevealMessageDto {
  @ApiPropertyOptional({
    description:
      '音视频时长（秒，1~7200）。仅音视频焚毁消息生效（voice/video 或 file+视频扩展名）：消费窗口 = max(ttl, 时长+缓冲)；窗口内可反复播放，播放完成/放弃时前端调 POST /messages/:id/consume 提前焚毁，窗口到期未调则调度器兜底焚毁',
    example: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7200)
  media_duration_seconds?: number;
}

/** PATCH /messages/:id/original-file：发送者补传原图地址（v5.8.7 双上传策略：压缩版先发、原图后补） */
export class UpdateOriginalFileDto {
  @ApiProperty({ description: '原图文件 URL（由 POST /upload 上传原图后获得）' })
  @IsString()
  @MaxLength(500)
  file_original_url: string;
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

/**
 * POST /messages/:conversationId/read-messages body（按消息 id 标记已读）。
 *
 * 为什么不能复用 `POST /messages/:id/read`：后者的语义是「≤ up_to_message_id 全部置已读」，
 * 塞 message_ids 进去会被 whitelist 静默丢弃并退化成整会话已读，
 * 前端已经按「404 则降级到旧接口」实现，所以这里必须是独立端点。
 */
export class MarkMessagesReadDto {
  @ApiProperty({
    description: '要标记已读的消息 ID（1~200 条；不属于该会话的会被忽略，已读的幂等跳过）',
    type: [String],
    example: ['3f9a2b8e-1111-4222-8333-444455556666'],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'message_ids 不能为空' })
  @ArrayMaxSize(200, { message: '单次最多标记 200 条' })
  @IsUUID('4', { each: true, message: 'message_ids 内必须是合法 UUID' })
  message_ids: string[];
}

/**
 * POST /messages/:conversationId/read body（V6.0）：支持"只标记到某条为止"。
 * 不传 = 整会话全部标记已读（兼容旧客户端行为）。
 */
export class MarkReadDto {
  @ApiPropertyOptional({
    description: '只把该条（含）之前的消息标记已读；不传 = 整会话全部标记',
  })
  @IsOptional()
  @IsUUID()
  up_to_message_id?: string;
}

/**
 * POST /messages/:conversationId/destroy-ack body（V6.0 两阶段销毁·阶段②）：
 * 前端确认这些已焚毁的消息可以真删除（行 + 附件）。
 * 后端会校验：① 调用者是会话成员 ② 每条消息确实 is_destroyed=1。
 */
export class DestroyAckDto {
  @ApiProperty({
    description: '确认可以真删除的消息 ID 列表（必须是本会话内、已焚毁的消息）',
    type: [String],
    example: ['3f9a2b8e-1111-4222-8333-444455556666'],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'message_ids 不能为空' })
  @ArrayMaxSize(500, { message: '单次最多确认 500 条' })
  @IsUUID('4', { each: true, message: 'message_ids 内必须是合法 UUID' })
  message_ids: string[];
}

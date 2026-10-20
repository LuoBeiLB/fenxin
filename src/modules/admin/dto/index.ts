import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 管理端消息检索（GET /admin/messages）。
 * 全部字段可选：不传则按时间倒序返回最近的消息。
 */
export class AdminMessageQueryDto {
  @ApiPropertyOptional({ description: '限定会话 ID' })
  @IsOptional()
  @IsUUID()
  conversation_id?: string;

  @ApiPropertyOptional({ description: '限定发送者用户 ID' })
  @IsOptional()
  @IsUUID()
  sender_id?: string;

  @ApiPropertyOptional({ description: '消息类型', enum: ['text', 'image', 'voice', 'video', 'file'] })
  @IsOptional()
  @IsIn(['text', 'image', 'voice', 'video', 'file'])
  type?: string;

  @ApiPropertyOptional({ description: '只看焚毁消息（burn_ttl_seconds 非空）', enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  burn_only?: string;

  @ApiPropertyOptional({ description: '按焚毁状态过滤（true=已焚毁 / false=正常）', enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  is_destroyed?: string;

  @ApiPropertyOptional({ description: '内容关键词（LIKE 匹配，仅未焚毁消息可命中）' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ description: '时间范围下界（ISO8601）' })
  @IsOptional()
  @IsString()
  start_time?: string;

  @ApiPropertyOptional({ description: '时间范围上界（ISO8601）' })
  @IsOptional()
  @IsString()
  end_time?: string;

  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页条数 1~100', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

/**
 * 管理端焚毁记录查询（GET /admin/destroy-records）。
 * stage 用于区分两阶段：pending_purge=已标记待真删 / purged=已真删（有墓碑）/ all
 */
export class AdminDestroyRecordQueryDto {
  @ApiPropertyOptional({
    description: '阶段：pending_purge 已标记待真删 / purged 已真删（墓碑）/ all 全部',
    enum: ['pending_purge', 'purged', 'all'],
    default: 'all',
  })
  @IsOptional()
  @IsIn(['pending_purge', 'purged', 'all'])
  stage?: 'pending_purge' | 'purged' | 'all' = 'all';

  @ApiPropertyOptional({
    description: '焚毁原因',
    enum: ['fallback_expired', 'all_read', 'owner_dissolve', 'admin_dissolve', 'manual'],
  })
  @IsOptional()
  @IsIn(['fallback_expired', 'all_read', 'owner_dissolve', 'admin_dissolve', 'manual'])
  reason?: string;

  @ApiPropertyOptional({ description: '限定会话 ID' })
  @IsOptional()
  @IsUUID()
  conversation_id?: string;

  @ApiPropertyOptional({ description: '焚毁时间下界（ISO8601）' })
  @IsOptional()
  @IsString()
  start_time?: string;

  @ApiPropertyOptional({ description: '焚毁时间上界（ISO8601）' })
  @IsOptional()
  @IsString()
  end_time?: string;

  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页条数 1~100', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

/** 管理端在线设备列表查询（GET /admin/presence/devices） */
export class AdminDeviceQueryDto {
  @ApiPropertyOptional({ description: '只返回在线设备', enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  online_only?: string;

  @ApiPropertyOptional({ description: '设备类型', enum: ['android', 'ios', 'web', 'desktop', 'unknown'] })
  @IsOptional()
  @IsString()
  device_type?: string;

  @ApiPropertyOptional({ description: '按手机号/昵称搜索' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页条数 1~100', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

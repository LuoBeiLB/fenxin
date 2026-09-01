import { IsString, IsInt, IsBoolean, IsOptional, Length, Min, Max, MaxLength, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/**
 * multipart form-data 场景下 boolean 会被传成字符串 'true'/'false'。
 * enableImplicitConversion 对字符串转 boolean 不可靠（Boolean('false') === true），
 * 这里统一用 @Transform 显式归一化。
 */
const ToBoolean = () =>
  Transform(({ value }) => value === true || value === 'true' || value === 1 || value === '1');

/** 支持的平台（iOS 上线前实际只发 android，但契约先定好，避免 App 端对接后再改） */
export const APP_PLATFORMS = ['android', 'ios'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

export class CreateAppVersionDto {
  @ApiPropertyOptional({ description: '平台，默认 android', enum: APP_PLATFORMS, example: 'android' })
  @IsOptional()
  @IsIn(APP_PLATFORMS, { message: 'platform 仅支持 android / ios' })
  platform?: AppPlatform;

  @ApiProperty({ description: '版本名（仅展示用，如 5.8）', example: '5.8' })
  @IsString()
  @Length(1, 20)
  version_name: string;

  @ApiProperty({
    description: 'versionCode / build number：同平台内递增整数，必须大于该平台当前最大值（如 58）',
    example: 58,
  })
  @IsInt()
  @Min(1)
  @Max(2100000000)
  version_code: number;

  @ApiPropertyOptional({ description: '是否强制更新（不装不让进 App），默认 false' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({ description: '更新说明（发版日志）', example: '1. 修复焚毁倒计时偏移\n2. 新增点开才焚' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateAppVersionDto {
  @ApiPropertyOptional({ description: '是否强制更新' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({ description: '更新说明' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ description: '发布状态：false=撤回（App 端不再返回该版本），true=恢复发布' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  published?: boolean;
}

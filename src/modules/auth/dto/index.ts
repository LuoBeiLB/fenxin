import {
  IsString,
  Matches,
  MinLength,
  IsIn,
  IsOptional,
  MaxLength,
  IsInt,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * 用户默认焚毁时长偏好的取值范围（秒）。
 * 下界 1 秒；上界 30 天——覆盖"几分钟 ~ 几天"的真实焚毁场景，同时挡住单位填错
 * （如把 1 天误填成毫秒 86400000）这类明显非法值。需要放宽只改这里。
 */
export const BURN_TTL_PREF_MIN_SECONDS = 1;
export const BURN_TTL_PREF_MAX_SECONDS = 30 * 24 * 3600; // 2592000

export class LoginDto {
  @ApiProperty({ example: '13800138000' })
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' })
  phone: string;

  @ApiProperty({ example: 'Admin@123456' })
  @IsString()
  @MinLength(1, { message: '密码不能为空' })
  password: string;

  @ApiProperty({ example: 'iPhone 15' })
  @IsString()
  device_name: string;

  @ApiProperty({ example: 'mobile', enum: ['mobile', 'desktop', 'tablet', 'web'] })
  @IsIn(['mobile', 'desktop', 'tablet', 'web'])
  device_type: string;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description:
      '客户端生成并持久化的设备唯一标识（localStorage）。重复登录传相同值则复用已有设备记录，不产生重复设备条目；不传则由服务端随机生成（兼容旧客户端）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  device_id?: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  old_password: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: '新密码长度不能少于8位' })
  new_password: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  refresh_token: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signature?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar_url?: string;

  /** 主题色标识（值域由前端定义，如 default/dark/blue，或 20 字符内的任意标识），不传则不修改 */
  @ApiPropertyOptional({ description: '用户自选主题色标识（值域由前端定义），用于前端换肤', example: 'dark' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  topic?: string;

  /**
   * 默认焚毁时长偏好（秒）：用户在设置页选好"以后发消息默认焚毁多久"后同步到这里，
   * 换设备 / 重启浏览器登录时随 profile 一起拿回，无需重新选择。
   *
   * 三态语义（务必区分，前端按需使用）：
   * - 传正整数（1 ~ 2592000）：设置默认焚毁时长（如 600 = 10 分钟、86400 = 1 天）
   * - 显式传 null：清除偏好 = 默认不焚毁（用户主动关掉焚毁）
   * - 不传该字段：保持不变（与 display_name 等字段同语义）
   */
  @ApiPropertyOptional({
    description:
      '默认焚毁时长偏好（秒，1~2592000）。传正整数 = 设置；显式传 null = 清除偏好（默认不焚毁）；不传 = 不变',
    nullable: true,
    minimum: BURN_TTL_PREF_MIN_SECONDS,
    maximum: BURN_TTL_PREF_MAX_SECONDS,
    example: 600,
  })
  // ValidateIf 放在最前：显式 null 时跳过后续类型/范围校验（null 是合法值：清除偏好）；
  // undefined（不传）由 IsOptional 放行，两者都在 service 里按 !== undefined 区分
  @ValidateIf((o) => o.default_burn_ttl_seconds !== null)
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'default_burn_ttl_seconds 必须是整数秒' })
  @Min(BURN_TTL_PREF_MIN_SECONDS, {
    message: `default_burn_ttl_seconds 不能小于 ${BURN_TTL_PREF_MIN_SECONDS} 秒`,
  })
  @Max(BURN_TTL_PREF_MAX_SECONDS, {
    message: `default_burn_ttl_seconds 不能大于 ${BURN_TTL_PREF_MAX_SECONDS} 秒（30 天）`,
  })
  default_burn_ttl_seconds?: number | null;
}

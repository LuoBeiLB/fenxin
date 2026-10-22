import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** 焚毁时长下限（秒）：与用户偏好一致 */
export const BURN_TTL_MIN_SECONDS = 1;
/** 焚毁时长上限（秒）：30 天 */
export const BURN_TTL_MAX_SECONDS = 30 * 24 * 3600;

/** PUT /burn-settings/users/:targetUserId 与 PUT /burn-settings/conversations/:id 的 body */
export class SetBurnSettingDto {
  @ApiProperty({
    description: '焚毁时长（秒），1 ~ 2592000（30 天）',
    minimum: BURN_TTL_MIN_SECONDS,
    maximum: BURN_TTL_MAX_SECONDS,
    example: 3600,
  })
  @Type(() => Number)
  @IsInt({ message: 'ttl_seconds 必须是整数秒' })
  @Min(BURN_TTL_MIN_SECONDS, { message: `ttl_seconds 不能小于 ${BURN_TTL_MIN_SECONDS} 秒` })
  @Max(BURN_TTL_MAX_SECONDS, {
    message: `ttl_seconds 不能大于 ${BURN_TTL_MAX_SECONDS} 秒（30 天）`,
  })
  ttl_seconds: number;
}

/** GET /burn-settings/users 的查询参数 */
export class BurnSettingListQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页条数 1~200', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}

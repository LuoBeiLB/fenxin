import { IsString, IsOptional, IsIn, MaxLength, IsArray, ArrayMaxSize, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAnnouncementDto {
  @ApiProperty({ example: '系统维护通知' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiProperty({ example: '本周六 22:00-24:00 服务器升级维护，期间消息可能延迟。' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ enum: ['normal', 'urgent'], default: 'normal', description: 'urgent 会走 WebSocket 实时弹窗推送到在线 App' })
  @IsOptional()
  @IsIn(['normal', 'urgent'])
  priority?: 'normal' | 'urgent' = 'normal';

  @ApiPropertyOptional({ enum: ['all', 'department'], default: 'all', description: 'all=全员；department=按部门定向' })
  @IsOptional()
  @IsIn(['all', 'department'])
  target_type?: 'all' | 'department' = 'all';

  @ApiPropertyOptional({ type: [String], description: 'target_type=department 时必填，部门名单（需与账号部门完全一致）', example: ['技术部', '市场部'] })
  @ValidateIf((o) => o.target_type === 'department')
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  target_departments?: string[];
}

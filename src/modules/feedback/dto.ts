import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFeedbackDto {
  @ApiProperty({ example: '希望群聊支持按部门批量拉人，每次手动加人太麻烦了。' })
  @IsString()
  @MaxLength(2000)
  content: string;

  @ApiPropertyOptional({ example: '13800138000', description: '用户自愿留下的联系方式，便于管理员回访（可选）' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contact?: string;
}

export class ReplyFeedbackDto {
  @ApiProperty({ example: '已收到，该功能已列入下个版本计划，感谢反馈！' })
  @IsString()
  @MaxLength(2000)
  reply: string;
}

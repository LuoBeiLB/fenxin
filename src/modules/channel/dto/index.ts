import {
  IsString,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChannelVisibility } from '../../../entities/conversation.entity';

/** 创建我的频道（一人一个） */
export class CreateChannelDto {
  @ApiProperty({ example: '萝卜的实验室', description: '频道名称（个人空间的名字）' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ example: '折腾加密通讯的日常，欢迎围观', description: '个人描述：对外展示在频道广场与详情页' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: '频道头像 URL' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar_url?: string;
}

/** 修改频道资料（仅频道主） */
export class UpdateChannelDto {
  @ApiPropertyOptional({ description: '频道名称' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: '个人描述' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: '频道头像 URL' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar_url?: string;

  @ApiPropertyOptional({ enum: ['public', 'private'], description: 'public=进广场可自主订阅；private=不进广场（P1 支持邀请链接订阅）' })
  @IsOptional()
  @IsIn(['public', 'private'])
  visibility?: ChannelVisibility;
}

/** 频道广场分页查询 */
export class DiscoverChannelsQueryDto {
  @ApiPropertyOptional({ example: 1, default: 1, description: '页码（从 1 开始）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20, description: '每页数量（1-100）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

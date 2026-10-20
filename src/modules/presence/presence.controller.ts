import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { PresenceService } from './presence.service';

class OnlineUsersQueryDto {
  @ApiPropertyOptional({ description: '按手机号/昵称过滤' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页条数 1~100', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 50;
}

class UsersPresenceQueryDto {
  @ApiPropertyOptional({
    description: '用户 ID 列表，逗号分隔（最多 200 个）',
    example: 'uuid1,uuid2',
  })
  @IsString()
  ids: string;
}

/**
 * 用户端：在线状态查询（V6.0）。
 *
 * 与管理端 `/admin/presence/*` 的区别：
 * - 这里**不暴露**设备名 / IP / 设备指纹，只给"是否在线 + 最后活跃时间"
 * - 通讯录是本系统全员可见的组织架构，因此在线列表对已登录用户开放
 */
@ApiTags('在线状态')
@ApiBearerAuth()
@Controller('presence')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get('online')
  listOnline(@Query() q: OnlineUsersQueryDto) {
    return this.presence.listOnlineUsers(q);
  }

  @Get('users')
  usersPresence(@CurrentUser() user: AuthPayload, @Query() q: UsersPresenceQueryDto) {
    return this.presence.getUsersPresence(user.userId, (q.ids || '').split(','));
  }

  @Get('me')
  myPresence(@CurrentUser() user: AuthPayload) {
    return this.presence.getMyPresence(user.userId, user.deviceId);
  }
}

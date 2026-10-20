import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { AdminMessageService } from './admin-message.service';
import { AdminDeviceQueryDto } from './dto';

/**
 * 管理端：在线监控。
 *
 * 数据来源（V6.0 起才有真实语义）：
 *  - `devices.is_online` 由 WS 连接数 + 客户端心跳共同维护；
 *  - PresenceScheduler 每分钟把「无连接且心跳过期」的设备置离线；
 *  - 概览里的 stale_online_devices 用于自检清扫是否正常（正常应为 0）。
 */
@ApiTags('管理端-在线监控')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin')
export class AdminPresenceController {
  constructor(private readonly adminMessage: AdminMessageService) {}

  @Get('presence/overview')
  overview() {
    return this.adminMessage.presenceOverview();
  }

  @Get('presence/devices')
  devices(@Query() q: AdminDeviceQueryDto) {
    return this.adminMessage.listDevices(q);
  }

  /** 强制下线：删设备记录 + 失效鉴权缓存 + WS 通知 + 审计 */
  @Post('devices/:deviceId/offline')
  @ResponseMessage('已强制下线')
  async forceOffline(
    @CurrentUser() user: AuthPayload,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Req() req: Request,
  ) {
    return this.adminMessage.forceOfflineDevice(deviceId, user.userId, req.ip);
  }
}

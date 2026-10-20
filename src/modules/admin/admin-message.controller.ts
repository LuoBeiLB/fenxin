import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { AdminMessageService } from './admin-message.service';
import {
  AdminDestroyRecordQueryDto,
  AdminMessageQueryDto,
} from './dto';

/**
 * 管理端：消息管理 / 焚毁记录 / 已读统计 / 焚毁概览。
 * 全部接口仅 admin 可调用（RolesGuard）。
 */
@ApiTags('管理端-消息与焚毁')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin')
export class AdminMessageController {
  constructor(private readonly adminMessage: AdminMessageService) {}

  // ===== 消息管理 =====

  @Get('messages')
  listMessages(@Query() q: AdminMessageQueryDto) {
    return this.adminMessage.listMessages(q);
  }

  @Get('messages/:id')
  messageDetail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.adminMessage.getMessageDetail(id);
  }

  /**
   * 手动焚毁：只做阶段①标记（is_destroyed=1, reason=manual），不物理删除。
   * 真删除仍由前端确认 / 超期兜底执行，保证只有一条删除路径。
   */
  @Post('messages/:id/destroy')
  @ResponseMessage('已标记焚毁')
  async destroyMessage(
    @CurrentUser() user: AuthPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.adminMessage.manualDestroy(id, user.userId, req.ip);
  }

  // ===== 焚毁记录（两阶段统一视图）=====

  @Get('destroy-records')
  destroyRecords(@Query() q: AdminDestroyRecordQueryDto) {
    return this.adminMessage.listDestroyRecords(q);
  }

  // ===== 已读统计 =====

  @Get('read-stats/conversations/:id')
  readStatsConversation(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.adminMessage.readStatsConversation(id);
  }

  @Get('read-stats/messages/:id')
  readStatsMessage(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.adminMessage.readStatsMessage(id);
  }

  // ===== 焚毁概览（数据总览页用）=====

  @Get('stats/burn-overview')
  burnOverview() {
    return this.adminMessage.burnOverview();
  }
}

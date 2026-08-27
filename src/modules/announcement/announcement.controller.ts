import { Body, Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AnnouncementService } from './announcement.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { CreateAnnouncementDto } from './dto';

@ApiTags('系统公告')
@ApiBearerAuth()
@Controller('announcements')
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  /**
   * 管理员发布公告：全员或按部门定向。
   * normal 进 App 公告中心；urgent 额外走 WebSocket 实时弹窗推送。
   */
  @Post()
  @Roles('admin')
  @ResponseMessage('公告发布成功')
  create(@Body() dto: CreateAnnouncementDto, @CurrentUser() user: AuthPayload, @Req() req: Request) {
    return this.announcementService.createAnnouncement({
      title: dto.title,
      content: dto.content,
      priority: dto.priority ?? 'normal',
      target_type: dto.target_type ?? 'all',
      target_departments: dto.target_departments,
      operatorId: user.userId,
      ip: req.ip,
    });
  }

  /** 管理端：全部公告列表（含阅读人数），倒序分页 */
  @Get('manage')
  @Roles('admin')
  adminList(@Query('page') page?: number, @Query('pageSize') pageSize?: number) {
    return this.announcementService.adminList(
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    );
  }

  /** 用户端：未读公告数（App 公告中心角标） */
  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthPayload) {
    return this.announcementService.unreadCount(user.userId);
  }

  /** 用户端：我可见的公告列表（含已读标记），倒序分页 */
  @Get()
  list(@CurrentUser() user: AuthPayload, @Query('page') page?: number, @Query('pageSize') pageSize?: number) {
    return this.announcementService.listMyAnnouncements(
      user.userId,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    );
  }

  /** 用户端：标记已读（幂等） */
  @Post(':id/read')
  @ResponseMessage('已标记为已读')
  async markRead(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    await this.announcementService.markRead(id, user.userId);
    return null;
  }

  /** 管理端：删除公告（连同已读记录） */
  @Delete(':id')
  @Roles('admin')
  @ResponseMessage('公告已删除')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthPayload, @Req() req: Request) {
    await this.announcementService.deleteAnnouncement(id, user.userId, req.ip);
    return null;
  }
}

import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { FeedbackService } from './feedback.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { CreateFeedbackDto, ReplyFeedbackDto } from './dto';
import { FeedbackStatus } from '../../entities/feedback.entity';

@ApiTags('意见反馈')
@ApiBearerAuth()
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  /** 用户提交意见反馈（contact 可选，自愿留联系方式便于回访） */
  @Post()
  @ResponseMessage('反馈提交成功')
  submit(@Body() dto: CreateFeedbackDto, @CurrentUser() user: AuthPayload, @Req() req: Request) {
    return this.feedbackService.submit({
      userId: user.userId,
      content: dto.content,
      contact: dto.contact,
      ip: req.ip,
    });
  }

  /** 用户端：我的反馈列表（含管理员回复），倒序分页 */
  @Get('my')
  my(@CurrentUser() user: AuthPayload, @Query('page') page?: number, @Query('pageSize') pageSize?: number) {
    return this.feedbackService.listMy(
      user.userId,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    );
  }

  /** 管理端：全量反馈列表（附提交人姓名/部门），可按 status=pending|processed 筛选 */
  @Get('admin/all')
  @Roles('admin')
  adminList(@Query('page') page?: number, @Query('pageSize') pageSize?: number, @Query('status') status?: FeedbackStatus) {
    return this.feedbackService.adminList({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      status,
    });
  }

  /** 管理端：回复反馈（回复即处理，状态自动置为 processed） */
  @Put('admin/:id/reply')
  @Roles('admin')
  @ResponseMessage('回复成功')
  reply(@Param('id') id: string, @Body() dto: ReplyFeedbackDto, @CurrentUser() user: AuthPayload, @Req() req: Request) {
    return this.feedbackService.reply({
      feedbackId: id,
      reply: dto.reply,
      operatorId: user.userId,
      ip: req.ip,
    });
  }
}

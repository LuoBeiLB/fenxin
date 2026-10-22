import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { BurnSettingService } from './burn-setting.service';
import { BurnSettingListQueryDto, SetBurnSettingDto } from './dto';
import {
  BurnSettingList,
  BurnSettingResolution,
  BurnSettingWriteResult,
} from './dto/response';

/**
 * 焚毁时长设置（V6.1「按人设置」，用户端）。
 *
 * 典型用法：
 *   1. 用户点开某个对话框 → GET /burn-settings/conversations/:cid 查出生效时长
 *   2. 用户修改 → PUT /burn-settings/users/:targetUserId
 *   3. 之后发消息不用再传 burn_ttl_seconds，后端自动套用（消息级显式传值仍优先）
 */
@ApiTags('焚毁设置')
@ApiBearerAuth()
@Controller('burn-settings')
export class BurnSettingController {
  constructor(private readonly burnSetting: BurnSettingService) {}

  /** 进会话时查询：我在这个会话里的生效焚毁时长（含来源，便于 UI 显示） */
  @Get('conversations/:conversationId')
  resolve(
    @CurrentUser() user: AuthPayload,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
  ): Promise<BurnSettingResolution> {
    return this.burnSetting.resolveForConversation(user.userId, conversationId);
  }

  /** 我对某个用户的焚毁时长（私聊） */
  @Put('users/:targetUserId')
  @ResponseMessage('焚毁时长已更新')
  setForUser(
    @CurrentUser() user: AuthPayload,
    @Param('targetUserId', new ParseUUIDPipe()) targetUserId: string,
    @Body() dto: SetBurnSettingDto,
  ): Promise<BurnSettingWriteResult> {
    return this.burnSetting.setForUser(user.userId, targetUserId, dto.ttl_seconds);
  }

  /** 清除我对某个用户的设置 → 回落到全局默认 */
  @Delete('users/:targetUserId')
  @ResponseMessage('焚毁时长设置已清除')
  clearForUser(
    @CurrentUser() user: AuthPayload,
    @Param('targetUserId', new ParseUUIDPipe()) targetUserId: string,
  ): Promise<BurnSettingWriteResult> {
    return this.burnSetting.clearForUser(user.userId, targetUserId);
  }

  /** 我在某个群/频道的焚毁时长（私聊不支持，请用按人设置） */
  @Put('conversations/:conversationId')
  @ResponseMessage('焚毁时长已更新')
  setForConversation(
    @CurrentUser() user: AuthPayload,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() dto: SetBurnSettingDto,
  ): Promise<BurnSettingWriteResult> {
    return this.burnSetting.setForConversation(user.userId, conversationId, dto.ttl_seconds);
  }

  /** 清除我在某个群/频道的设置 */
  @Delete('conversations/:conversationId')
  @ResponseMessage('焚毁时长设置已清除')
  clearForConversation(
    @CurrentUser() user: AuthPayload,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
  ): Promise<BurnSettingWriteResult> {
    return this.burnSetting.clearForConversation(user.userId, conversationId);
  }

  /** 我的「按人设置」列表（设置页用） */
  @Get('users')
  list(@CurrentUser() user: AuthPayload, @Query() q: BurnSettingListQueryDto): Promise<BurnSettingList> {
    return this.burnSetting.listUserSettings(user.userId, q.page, q.pageSize);
  }
}

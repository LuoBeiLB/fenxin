import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MessageService } from './message.service';
import { DestroyService } from './destroy.service';
import { BurnSettingService } from '../burn-setting/burn-setting.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import {
  SendMessageDto,
  EditMessageDto,
  SearchMessagesDto,
  UpdateOriginalFileDto,
  RevealMessageDto,
  MarkReadDto,
  DestroyAckDto,
} from './dto';

@ApiTags('消息管理')
@ApiBearerAuth()
@Controller('messages')
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly destroyService: DestroyService,
    private readonly burnSetting: BurnSettingService,
  ) {}

  /**
   * 发送消息。
   * V6.1：焚毁时长改为「按人设置」——请求体不传 burn_ttl_seconds 时，
   * 由 BurnSettingService 按「联系人设置 → 会话设置 → 全局默认」解析后套用；
   * 显式传了 burn_ttl_seconds / destroy_at 仍以参数为准（消息级覆盖）。
   */
  @Post()
  @ResponseMessage('发送成功')
  async send(@CurrentUser() user: AuthPayload, @Body() dto: SendMessageDto) {
    // 只有「既没传 ttl 也没传旧版 destroy_at」时才走设置解析，
    // 否则保持旧客户端"这一条临时指定"的语义
    const resolvedTtl =
      dto.burn_ttl_seconds == null && dto.destroy_at == null
        ? await this.burnSetting.resolveTtlForSend(user.userId, dto.conversation_id)
        : undefined;

    return this.messageService.sendMessage({
      conversationId: dto.conversation_id,
      senderId: user.userId,
      type: dto.type,
      content: dto.content,
      fileUrl: dto.file_url,
      fileName: dto.file_name,
      fileSize: dto.file_size,
      mediaDurationSeconds: dto.media_duration_seconds,
      replyToId: dto.reply_to_id,
      burnTtlSeconds: dto.burn_ttl_seconds ?? resolvedTtl ?? undefined,
      // 旧客户端兼容（V6.0）：只在 burn_ttl_seconds 缺失时用于反算 ttl
      destroyAt: dto.destroy_at,
      senderEphemeralPubkey: dto.sender_ephemeral_pubkey,
      cipherNonce: dto.cipher_nonce,
      cipherText: dto.cipher_text,
      mentions: dto.mentions,
    });
  }

  /**
   * 全局消息搜索（v5.8.5）：跨我所在的全部会话搜索关键词，可传 conversation_id 限定单会话。
   * 底层 MySQL FULLTEXT + ngram（索引见 docs/migration-20260904-messages-fulltext.sql，必须手工执行）。
   * ⚠️ 必须声明在 @Get(':conversationId') 之前：NestJS 按声明顺序匹配路由，
   *    放后面 'search' 会被 :conversationId 动态参数吞掉（表现为 404 / 空列表）。
   */
  @Get('search')
  searchGlobal(
    @CurrentUser() user: AuthPayload,
    @Query() dto: SearchMessagesDto,
  ) {
    return this.messageService.searchGlobal({
      userId: user.userId,
      keyword: dto.keyword,
      conversationId: dto.conversation_id,
      page: dto.page,
      pageSize: dto.pageSize,
      after: dto.after,
      before: dto.before,
    });
  }

  /**
   * 待确认真删除列表（V6.0 两阶段销毁·阶段②）。
   * 前端进入会话时调用：返回本会话内「已焚毁」且「我还没确认过」的消息元数据（不含内容），
   * 前端拿到后调 POST /messages/:conversationId/destroy-ack 确认。
   */
  @Get(':conversationId/pending-destroy')
  pendingDestroy(
    @CurrentUser() user: AuthPayload,
    @Param('conversationId') conversationId: string,
  ) {
    return this.destroyService.listPending(conversationId, user.userId);
  }

  /**
   * 确认真删除（V6.0 两阶段销毁·阶段②）：告知后端这些已焚毁消息可以物理删除了。
   * 后端校验「会话成员 + 确实已焚毁」后，满足策略立即真删（行 + 回执 + 附件），
   * 并写入 message_tombstones 供前端继续渲染"已焚毁"占位。
   */
  @Post(':conversationId/destroy-ack')
  @ResponseMessage('已确认销毁')
  destroyAck(
    @CurrentUser() user: AuthPayload,
    @Param('conversationId') conversationId: string,
    @Body() dto: DestroyAckDto,
  ) {
    return this.destroyService.ack({
      conversationId,
      userId: user.userId,
      deviceId: user.deviceId,
      messageIds: dto.message_ids,
    });
  }

  @Get(':conversationId')
  list(
    @CurrentUser() user: AuthPayload,
    @Param('conversationId') conversationId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: number,
  ) {
    return this.messageService.listMessages({
      conversationId,
      userId: user.userId,
      before,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':conversationId/search')
  search(
    @CurrentUser() user: AuthPayload,
    @Param('conversationId') conversationId: string,
    @Query('keyword') keyword: string,
    @Query('before') before?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    return this.messageService.searchMessages({
      conversationId,
      userId: user.userId,
      keyword,
      before,
      limit,  // service 内 Math.min(limit, 200) 二次兜底
    });
  }

  /**
   * 补传原图地址（v5.8.7）：双上传策略——前端先发压缩版消息（file_url），原图上传完成后回填。
   * 仅发送者本人、仅允许从空补填一次；已撤回/已焚毁消息不允许补。
   */
  @Patch(':id/original-file')
  @ResponseMessage('原图已更新')
  updateOriginalFile(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() dto: UpdateOriginalFileDto,
  ) {
    return this.messageService.updateOriginalFile(id, user.userId, dto.file_original_url);
  }

  @Put(':id')
  @ResponseMessage('消息已编辑')
  edit(@CurrentUser() user: AuthPayload, @Param('id') id: string, @Body() dto: EditMessageDto) {
    return this.messageService.editMessage(id, user.userId, dto.content);
  }

  @Post(':id/recall')
  @ResponseMessage('消息已撤回')
  async recall(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    await this.messageService.recallMessage(id, user.userId);
    return null;
  }

  /**
   * 点开查看焚毁消息：返回完整内容并从点开时刻起开始该用户的焚毁倒计时。
   * v5.8.9 播完才焚：音视频焚毁消息的倒计时为「消费窗口」（max(ttl, 媒体时长+缓冲)），
   * body 可带 media_duration_seconds（前端播放器 metadata 时长，仅存库缺失时兜底）；
   * 返回 media_burn_pending=true 提示前端播放完成/放弃时调 POST /messages/:id/consume
   * 提前焚毁。文本/图片逻辑不变。
   */
  @Post(':id/reveal')
  @ResponseMessage('已点开')
  reveal(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() dto?: RevealMessageDto,
  ) {
    return this.messageService.revealMessage(id, user.userId, dto?.media_duration_seconds);
  }

  /**
   * 消费音视频焚毁消息（v5.8.9 播完才焚）：前端播放完成/中途放弃时调用，
   * 后端把该用户的焚毁截止时间提前置为当下（此后再 reveal 即「已焚毁」；物理删除仍由
   * 调度器统一执行，群聊未看成员不受影响）。幂等接口：重复调用/已焚毁均返回成功。
   */
  @Post(':id/consume')
  @ResponseMessage('已消费，进入焚毁')
  consume(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.messageService.consumeMessage(id, user.userId);
  }

  /** :id 为会话 ID（与旧版 API 保持一致）；body 可带 up_to_message_id 只标记到某条（V6.0） */
  @Post(':id/read')
  @ResponseMessage('已读标记成功')
  async markRead(
    @CurrentUser() user: AuthPayload,
    @Param('id') conversationId: string,
    @Body() dto?: MarkReadDto,
  ) {
    await this.messageService.markAsRead(conversationId, user.userId, dto?.up_to_message_id);
    return null;
  }

  /**
   * 群聊已读进度（V6.0）：返回非发送方人数、已点开/已到期人数与逐人明细，
   * 供气泡下方显示「3/4 已读」。
   */
  @Get(':id/readers')
  readers(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.messageService.getReadProgress(id, user.userId);
  }

  @Get(':id/receipt')
  receipts(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.messageService.getMessageReceipts(id, user.userId);
  }
}

import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MessageService } from './message.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { SendMessageDto, EditMessageDto, SearchMessagesDto, UpdateOriginalFileDto, RevealMessageDto } from './dto';

@ApiTags('消息管理')
@ApiBearerAuth()
@Controller('messages')
export class MessageController {
  constructor(private readonly messageService: MessageService) {}

  @Post()
  @ResponseMessage('发送成功')
  send(@CurrentUser() user: AuthPayload, @Body() dto: SendMessageDto) {
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
      burnTtlSeconds: dto.burn_ttl_seconds,
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

  /** :id 为会话 ID（与旧版 API 保持一致） */
  @Post(':id/read')
  @ResponseMessage('已读标记成功')
  async markRead(@CurrentUser() user: AuthPayload, @Param('id') conversationId: string) {
    await this.messageService.markAsRead(conversationId, user.userId);
    return null;
  }

  @Get(':id/receipt')
  receipts(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.messageService.getMessageReceipts(id, user.userId);
  }
}

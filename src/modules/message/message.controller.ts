import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MessageService } from './message.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { SendMessageDto, EditMessageDto } from './dto';

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
      replyToId: dto.reply_to_id,
      destroyAt: dto.destroy_at,
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

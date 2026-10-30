import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { ConversationService } from './conversation.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';

class CreatePrivateDto {
  @ApiProperty({ description: '对方用户 ID' })
  @IsUUID()
  user_id: string;
}

@ApiTags('会话管理')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Post('private')
  createPrivate(@CurrentUser() user: AuthPayload, @Body() dto: CreatePrivateDto) {
    return this.conversationService.getOrCreatePrivateConversation(user.userId, dto.user_id);
  }

  /**
   * 会话列表（V6.2）：返回值已按**设备**过滤 ——
   *   · 普通会话：所有成员设备可见；
   *   · 私密会话 pending：双方所有设备可见（作为"请求"）；
   *   · 私密会话 active：仅两台绑定设备可见。
   */
  @Get()
  list(@CurrentUser() user: AuthPayload) {
    return this.conversationService.listMyConversations(user.userId, user.deviceId);
  }

  @Get(':id')
  getOne(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.conversationService.getConversation(id, user.userId, user.deviceId);
  }
}

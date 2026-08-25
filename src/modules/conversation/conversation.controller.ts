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

  @Get()
  list(@CurrentUser() user: AuthPayload) {
    return this.conversationService.listMyConversations(user.userId);
  }

  @Get(':id')
  getOne(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.conversationService.getConversation(id, user.userId);
  }
}

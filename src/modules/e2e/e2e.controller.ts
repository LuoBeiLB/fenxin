import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { E2eService } from './e2e.service';
import { RequestSecretChatDto } from './dto';
import { SecretChatAcceptResult, SecretChatMutationResult, SecretChatRequestResult } from './dto/response';

/**
 * 设备配对私密会话接口（V6.2）。
 *
 * 路径沿用 `/conversations/...`（会话语义），但**可见性与普通会话完全不同**：
 * active 状态只有两台绑定设备能访问，其余设备连会话行都查不到。
 *
 * device_id 一律取自 JWT，不接受 body 传参。
 */
@ApiTags('私密会话')
@ApiBearerAuth()
@Controller('conversations')
export class E2eController {
  constructor(private readonly e2eService: E2eService) {}

  /** 发起私密聊天请求（在当前设备上） */
  @Post('e2e-request')
  @ResponseMessage('私密聊天请求已发送')
  request(
    @CurrentUser() user: AuthPayload,
    @Body() dto: RequestSecretChatDto,
  ): Promise<SecretChatRequestResult> {
    return this.e2eService.requestSecretChat(user.userId, user.deviceId, dto.target_user_id);
  }

  /** 接受请求：当前设备成为绑定设备 */
  @Post(':id/e2e-accept')
  @HttpCode(200)
  @ResponseMessage('私密聊天已开启')
  accept(@CurrentUser() user: AuthPayload, @Param('id') id: string): Promise<SecretChatAcceptResult> {
    return this.e2eService.acceptSecretChat(id, user.userId, user.deviceId);
  }

  /** 拒绝请求（被邀请方任一设备） */
  @Post(':id/e2e-reject')
  @HttpCode(200)
  @ResponseMessage('已拒绝')
  reject(@CurrentUser() user: AuthPayload, @Param('id') id: string): Promise<SecretChatMutationResult> {
    return this.e2eService.rejectSecretChat(id, user.userId, user.deviceId);
  }

  /**
   * 关闭私密会话 / 撤回待接受的请求。
   * 服务端会**物理删除**会话与全部消息，双方都无法再查看。
   */
  @Post(':id/e2e-close')
  @HttpCode(200)
  @ResponseMessage('私密聊天已结束')
  close(@CurrentUser() user: AuthPayload, @Param('id') id: string): Promise<SecretChatMutationResult> {
    return this.e2eService.closeSecretChat(id, user.userId, user.deviceId, 'user');
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { E2eService } from './e2e.service';
import { RequestSecretChatDto } from './dto';
import { CloseAllSecretChatsDto } from './dto/close-all.dto';
import {
  SecretChatAcceptResult,
  SecretChatCloseAllResult,
  SecretChatMineView,
  SecretChatMutationResult,
  SecretChatRequestResult,
} from './dto/response';

/** GET /conversations/e2e-mine 的查询参数 */
class MineQueryDto {
  @ApiProperty({
    description: 'all=全部（默认） this=只列绑在本设备的 other=只列绑在其它设备的',
    enum: ['all', 'this', 'other'],
    required: false,
    default: 'all',
  })
  @IsOptional()
  @IsIn(['all', 'this', 'other'], { message: 'bound_device 只能是 all / this / other' })
  bound_device?: 'all' | 'this' | 'other';
}

/**
 * 设备配对私密会话接口（V6.2 / V6.2.1）。
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

  /**
   * B-1：跨设备列出我名下全部进行中私密会话。
   *
   * 与 `GET /conversations` 的区别：**不受当前设备绑定关系限制**，
   * 用于「退出登录前提示」「新设备登录提示」「锁面板：其他设备的加密聊天」。
   */
  @Get('e2e-mine')
  @ResponseMessage('ok')
  listMine(@CurrentUser() user: AuthPayload, @Query() query: MineQueryDto): Promise<SecretChatMineView[]> {
    return this.e2eService.listMine(user.userId, {
      deviceId: user.deviceId,
      boundDevice: query.bound_device ?? 'all',
    });
  }

  /** 发起私密聊天请求（在当前设备上） */
  @Post('e2e-request')
  @ResponseMessage('私密聊天请求已发送')
  request(
    @CurrentUser() user: AuthPayload,
    @Body() dto: RequestSecretChatDto,
  ): Promise<SecretChatRequestResult> {
    return this.e2eService.requestSecretChat(user.userId, user.deviceId, dto.target_user_id);
  }

  /**
   * B-3：一次结束我名下全部进行中私密会话（退出登录 / 换设备时用）。
   *
   * 与逐个调用 `:id/e2e-close` 等价，但只有一次往返；
   * 单条失败不会阻塞其余（失败项不会出现在 conversation_ids 里）。
   */
  @Post('e2e-close-all')
  @HttpCode(200)
  @ResponseMessage('私密会话已批量结束')
  closeAll(
    @CurrentUser() user: AuthPayload,
    @Body() dto: CloseAllSecretChatsDto,
  ): Promise<SecretChatCloseAllResult> {
    return this.e2eService.closeAll(user.userId, user.deviceId, dto.reason ?? 'user', {
      onlyOtherDevices: dto.only_other_devices ?? false,
    });
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
   *
   * V6.2.1 起：同一用户的**任意设备**都可以关闭自己名下的会话（解开换设备死锁）。
   */
  @Post(':id/e2e-close')
  @HttpCode(200)
  @ResponseMessage('私密聊天已结束')
  close(@CurrentUser() user: AuthPayload, @Param('id') id: string): Promise<SecretChatMutationResult> {
    return this.e2eService.closeSecretChat(id, user.userId, user.deviceId, 'user');
  }
}

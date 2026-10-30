import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KeysService } from './keys.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { UploadDeviceKeyDto } from './dto';
import { DeviceKeyUploadResult, MyDeviceKeyView, PeerDeviceKeyView } from './dto/response';

/**
 * 设备级加密密钥接口（V6.2）。
 *
 * 与旧接口的区别：旧版按 user 存公钥（后登录设备覆盖前一台），
 * 新版按 (user, device) 存，device_id 一律取自 JWT。
 */
@ApiTags('加密密钥')
@ApiBearerAuth()
@Controller('keys')
export class KeysController {
  constructor(private readonly keysService: KeysService) {}

  /**
   * 上传/更新**本设备**的 X25519 identity 公钥。
   * 限流 5/min：公钥极少变动，限流防止脚本反复覆盖。
   */
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('device')
  @ResponseMessage('设备公钥已上传')
  uploadDeviceKey(
    @CurrentUser() user: AuthPayload,
    @Body() dto: UploadDeviceKeyDto,
  ): Promise<DeviceKeyUploadResult> {
    return this.keysService.uploadDeviceKey(user.userId, user.deviceId, dto.identity_pubkey);
  }

  /** 查本设备已上传的公钥（前端自检"服务端与本地是否一致"） */
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('device/me')
  @ResponseMessage('ok')
  getMyDeviceKey(@CurrentUser() user: AuthPayload): Promise<MyDeviceKeyView> {
    return this.keysService.getMyDeviceKey(user.userId, user.deviceId);
  }

  /**
   * 取私密会话中**对方绑定设备**的公钥。
   * 路径参数是 conversation_id（不是 user_id）：客户端只需要知道自己所在的私密会话，
   * 由服务端根据绑定关系反查对方设备，避免在 URL 里暴露对方设备 ID。
   */
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('device/:conversationId')
  @ResponseMessage('ok')
  getPeerDeviceKey(
    @CurrentUser() user: AuthPayload,
    @Param('conversationId') conversationId: string,
  ): Promise<PeerDeviceKeyView> {
    return this.keysService.getPeerDeviceKey(user.userId, user.deviceId, conversationId);
  }
}

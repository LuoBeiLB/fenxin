import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { LoginDto, ChangePasswordDto, RefreshTokenDto, UpdateProfileDto } from './dto';

@ApiTags('认证模块')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * 登录（本系统不开自助注册，账号由管理后台 /accounts 统一开通）。
   * 收紧限流：每 IP 每分钟 5 次，防手机号遍历与暴力破解。
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ResponseMessage('登录成功')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(
      dto.phone,
      dto.password,
      { deviceName: dto.device_name, deviceType: dto.device_type, deviceId: dto.device_id },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
  }

  @Post('change-password')
  @ResponseMessage('密码修改成功')
  async changePassword(@CurrentUser() user: AuthPayload, @Body() dto: ChangePasswordDto) {
    await this.authService.changePassword(user.userId, dto.old_password, dto.new_password);
    return null;
  }

  /** 刷新 token：只认 refresh token（独立密钥），不要求 access token 有效 */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('refresh-token')
  @ResponseMessage('Token 刷新成功')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refresh_token);
  }

  @ApiBearerAuth()
  @Get('profile')
  getProfile(@CurrentUser() user: AuthPayload) {
    return this.authService.getProfile(user.userId);
  }

  @ApiBearerAuth()
  @Put('profile')
  @ResponseMessage('个人资料更新成功')
  updateProfile(@CurrentUser() user: AuthPayload, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(user.userId, dto);
  }

  @ApiBearerAuth()
  @Get('devices')
  getDevices(@CurrentUser() user: AuthPayload) {
    return this.authService.getDevices(user.userId);
  }

  @ApiBearerAuth()
  @Post('devices/:deviceId/offline')
  @ResponseMessage('设备已下线')
  async offlineDevice(@CurrentUser() user: AuthPayload, @Param('deviceId') deviceId: string) {
    await this.authService.removeDevice(user.userId, deviceId);
    return null;
  }
}

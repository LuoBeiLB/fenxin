import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PresenceScheduler } from './presence.scheduler';
import { E2eModule } from '../e2e/e2e.module';
import { KeysModule } from '../keys/keys.module';

@Module({
  // E2eModule：设备被踢下线时联动关闭它绑定的私密会话（V6.2）
  // KeysModule：同时删除该设备的设备级公钥
  imports: [E2eModule, KeysModule],
  controllers: [AuthController],
  providers: [AuthService, PresenceScheduler],
})
export class AuthModule {}

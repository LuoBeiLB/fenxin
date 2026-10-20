import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PresenceScheduler } from './presence.scheduler';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PresenceScheduler],
})
export class AuthModule {}

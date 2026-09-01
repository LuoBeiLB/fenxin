import { Module } from '@nestjs/common';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';

/**
 * App 版本管理模块（V5.8 App 自更新）。
 * EventsGateway 为 @Global 模块，直接注入即可广播 WS 事件。
 */
@Module({
  controllers: [AppVersionController],
  providers: [AppVersionService],
})
export class AppVersionModule {}

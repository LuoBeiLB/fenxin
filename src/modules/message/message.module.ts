import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';
import { DestroyService } from './destroy.service';
import { BurnScheduler } from './burn.scheduler';
import { OssModule } from '../upload/oss.module';
import { BurnSettingModule } from '../burn-setting/burn-setting.module';
import { PushModule } from '../push/push.module';

@Module({
  // BurnSettingModule：发送时若未显式传 ttl，按「按人设置」解析默认值（V6.1）
  // PushModule：发送后给离线成员发极光推送（V6.2）
  imports: [OssModule, BurnSettingModule, PushModule],
  controllers: [MessageController],
  providers: [MessageService, DestroyService, BurnScheduler],
  exports: [DestroyService],
})
export class MessageModule {}

import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';
import { DestroyService } from './destroy.service';
import { BurnScheduler } from './burn.scheduler';
import { OssModule } from '../upload/oss.module';
import { BurnSettingModule } from '../burn-setting/burn-setting.module';

@Module({
  // BurnSettingModule：发送消息时若未显式传 ttl，需要按「按人设置」解析默认值（V6.1）
  imports: [OssModule, BurnSettingModule],
  controllers: [MessageController],
  providers: [MessageService, DestroyService, BurnScheduler],
  exports: [DestroyService],
})
export class MessageModule {}

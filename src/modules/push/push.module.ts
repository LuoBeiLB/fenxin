import { Module } from '@nestjs/common';
import { JpushProvider } from './jpush.provider';
import { PushService } from './push.service';

/**
 * 离线推送模块（V6.2）。
 * 导出 PushService 供 MessageModule 在发送消息后调用（异步、不阻塞）。
 */
@Module({
  providers: [JpushProvider, PushService],
  exports: [PushService],
})
export class PushModule {}

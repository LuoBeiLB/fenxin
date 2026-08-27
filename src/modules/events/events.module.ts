import { Global, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';

/**
 * 实时事件模块（全局模块）。
 * 注册为 @Global 后，消息 / 会话 / 群组等业务模块可直接注入 EventsGateway
 * 推送事件，无需各自 import（与 TokenModule 同样的做法）。
 */
@Global()
@Module({
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}

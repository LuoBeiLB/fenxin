import { Module } from '@nestjs/common';
import { PresenceController } from './presence.controller';
import { PresenceService } from './presence.service';

/**
 * 用户端在线状态模块（V6.0）。
 * 注意与 `modules/auth/presence.scheduler.ts` 区分：
 * 那个是"兜底把过期设备置离线"的定时任务，本模块只提供查询接口。
 */
@Module({
  controllers: [PresenceController],
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}

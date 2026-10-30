import { Module } from '@nestjs/common';
import { E2eController } from './e2e.controller';
import { E2eService } from './e2e.service';

/**
 * 设备配对私密会话模块（V6.2）。
 *
 * 依赖的 EventsGateway / OssService 由 @Global 模块提供，无需 import。
 * E2eService 同时被 AuthModule 复用（设备下线时关闭其绑定的私密会话），故必须导出。
 */
@Module({
  controllers: [E2eController],
  providers: [E2eService],
  exports: [E2eService],
})
export class E2eModule {}

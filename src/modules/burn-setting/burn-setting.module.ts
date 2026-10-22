import { Module } from '@nestjs/common';
import { BurnSettingController } from './burn-setting.controller';
import { BurnSettingService } from './burn-setting.service';

/**
 * 焚毁时长设置模块（V6.1「按人设置」）。
 * 导出 Service 供 MessageModule 在发送消息时解析默认时长。
 */
@Module({
  controllers: [BurnSettingController],
  providers: [BurnSettingService],
  exports: [BurnSettingService],
})
export class BurnSettingModule {}

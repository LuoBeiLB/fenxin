import { Module } from '@nestjs/common';
import { AdminMessageController } from './admin-message.controller';
import { AdminPresenceController } from './admin-presence.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminMessageService } from './admin-message.service';
import { AuditModule } from '../audit/audit.module';

/**
 * 管理端扩展模块（V6.0）：消息管理、焚毁记录、已读统计、在线监控、保留策略。
 *
 * 为什么不塞进 message/conversation 模块：
 * ① 这些接口全部带 @Roles('admin')，独立模块便于整体审计"管理端暴露面"；
 * ② 依赖的是只读聚合查询，和业务写路径无关，拆开后业务模块不被管理端字段污染。
 */
@Module({
  imports: [AuditModule],
  controllers: [AdminMessageController, AdminPresenceController, AdminSettingsController],
  providers: [AdminMessageService],
  exports: [AdminMessageService],
})
export class AdminModule {}

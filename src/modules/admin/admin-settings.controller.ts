import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminMessageService } from './admin-message.service';

/**
 * 管理端：数据保留策略（只读）。
 *
 * 为什么不提供 PUT：这些值直接决定"消息能被真删得多快"，
 * 运行期改动会让同一批数据的生命周期不可预测（一半用旧值一半用新值）。
 * 因此保持 env-only，管理台只展示当前生效值 + 修改方式。
 */
@ApiTags('管理端-系统设置')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin')
export class AdminSettingsController {
  constructor(private readonly adminMessage: AdminMessageService) {}

  @Get('settings/retention')
  retention() {
    return this.adminMessage.retentionSettings();
  }
}

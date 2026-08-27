import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('统计概览')
@ApiBearerAuth()
@Roles('admin')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  /** Dashboard 首页概览：总账号数/今日活跃/今日消息量/存储占用等（仅管理员） */
  @Get('overview')
  overview() {
    return this.statsService.getOverview();
  }
}

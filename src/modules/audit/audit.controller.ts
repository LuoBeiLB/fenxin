import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { ListAuditLogsQuery } from './dto';

@ApiTags('审计日志')
@ApiBearerAuth()
@Roles('admin')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /** 审计日志分页查询：仅管理员，供管理后台使用；返回 { data, total } */
  @Get()
  list(@Query() query: ListAuditLogsQuery) {
    return this.auditService.listLogs(query);
  }
}

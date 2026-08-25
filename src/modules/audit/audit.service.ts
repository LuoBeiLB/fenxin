import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLog } from '../../entities/audit-log.entity';

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly dataSource: DataSource) {}

  /** 审计日志写入失败不阻断主流程，仅记录错误 */
  async log(params: {
    userId?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    try {
      await this.dataSource.getRepository(AuditLog).save({
        user_id: params.userId ?? null,
        action: params.action,
        target_type: params.targetType ?? null,
        target_id: params.targetId ?? null,
        detail: params.detail ?? null,
        ip_address: params.ipAddress ?? null,
        user_agent: params.userAgent ?? null,
      });
    } catch (err) {
      this.logger.error('Failed to create audit log', err as Error);
    }
  }
}

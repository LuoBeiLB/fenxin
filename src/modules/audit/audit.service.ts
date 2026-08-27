import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { AuditLog } from '../../entities/audit-log.entity';
import { AppUser } from '../../entities/app-user.entity';

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

  /** 审计日志分页查询（仅管理员，供管理后台使用），返回 { data, total } */
  async listLogs(params: {
    page?: number;
    pageSize?: number;
    user_id?: string;
    action?: string;
    target_type?: string;
    start_time?: string;
    end_time?: string;
    keyword?: string;
  }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;

    const qb = this.dataSource.getRepository(AuditLog).createQueryBuilder('log');

    if (params.user_id) qb.andWhere('log.user_id = :userId', { userId: params.user_id });
    if (params.action) qb.andWhere('log.action = :action', { action: params.action });
    if (params.target_type) {
      qb.andWhere('log.target_type = :targetType', { targetType: params.target_type });
    }
    if (params.start_time) {
      const start = new Date(params.start_time);
      if (Number.isNaN(start.getTime())) throw new BadRequestException('start_time 格式无效');
      qb.andWhere('log.created_at >= :start', { start });
    }
    if (params.end_time) {
      const end = new Date(params.end_time);
      if (Number.isNaN(end.getTime())) throw new BadRequestException('end_time 格式无效');
      qb.andWhere('log.created_at <= :end', { end });
    }
    if (params.keyword) qb.andWhere('log.detail LIKE :kw', { kw: `%${params.keyword}%` });

    qb.orderBy('log.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [logs, total] = await qb.getManyAndCount();

    // 批量补操作人姓名/手机号（一次 IN 查询，避免 N+1）
    const userIds = [...new Set(logs.map((l) => l.user_id).filter((id): id is string => !!id))];
    const users = userIds.length
      ? await this.dataSource.getRepository(AppUser).find({
          where: { id: In(userIds) },
          select: ['id', 'display_name', 'phone'],
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const data = logs.map((l) => {
      const u = l.user_id ? userMap.get(l.user_id) : undefined;
      return {
        ...l,
        user_display_name: u?.display_name ?? null,
        user_phone: u?.phone ?? null,
      };
    });

    return { data, total };
  }
}

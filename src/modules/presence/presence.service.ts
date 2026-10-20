import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppUser, SAFE_USER_FIELDS } from '../../entities/app-user.entity';
import { Device } from '../../entities/device.entity';

/**
 * 用户端在线状态查询（V6.0）。
 *
 * 说明：本系统通讯录是**全员可见**的组织架构（不是好友关系表），
 * 所以"谁在线"对已登录用户不是敏感信息，可以直接暴露；
 * 但**不暴露**设备名 / IP / 指纹等设备细节（那些只在管理端可见）。
 *
 * 数据来源：`devices.is_online`（由 WS 连接数 + 心跳维护，PresenceScheduler 兜底清扫）。
 */
@Injectable()
export class PresenceService {
  /** 批量查询的上限：防止一次拉全校 */
  private static readonly MAX_BATCH = 200;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * 当前在线用户列表（分页）。
   * 返回通讯录白名单字段 + 在线设备数 + 最后活跃时间。
   */
  async listOnlineUsers(params: {
    keyword?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = params.page && params.page > 0 ? params.page : 1;
    const pageSize =
      params.pageSize && params.pageSize > 0 ? Math.min(params.pageSize, 100) : 50;

    const qb = this.dataSource
      .getRepository(AppUser)
      .createQueryBuilder('u')
      .innerJoin(Device, 'd', 'd.user_id = u.id AND d.is_online = 1')
      // 注意：getRawMany() 下 TypeORM 会把 'u.phone' 落成列名 'u_phone'，
      // 必须显式 AS 成字段名，否则 toUserView 取到的全是 undefined（实测踩过）
      .select(SAFE_USER_FIELDS.map((f) => `u.${String(f)} AS ${String(f)}`))
      .addSelect('COUNT(DISTINCT d.id)', 'online_devices')
      .addSelect('MAX(d.last_active_at)', 'last_active_at')
      .where('u.status = :status', { status: 'active' })
      .andWhere('u.deleted_at IS NULL');

    if (params.keyword) {
      qb.andWhere('(u.phone = :kw OR u.display_name LIKE :kwLike)', {
        kw: params.keyword,
        kwLike: `%${params.keyword}%`,
      });
    }

    // 先算总数（GROUP BY 后 count 需要包一层，用 getRawMany 取全部 id 成本高，改为子查询）
    const totalRow = await this.dataSource.query(
      `SELECT COUNT(DISTINCT u.id) AS cnt
         FROM app_users u
         JOIN devices d ON d.user_id = u.id AND d.is_online = 1
        WHERE u.status = 'active' AND u.deleted_at IS NULL
        ${params.keyword ? 'AND (u.phone = ? OR u.display_name LIKE ?)' : ''}`,
      params.keyword ? [params.keyword, `%${params.keyword}%`] : [],
    );

    const rows = await qb
      .groupBy('u.id')
      .orderBy('MAX(d.last_active_at)', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getRawMany();

    return {
      total: Number(totalRow?.[0]?.cnt ?? 0),
      page,
      pageSize,
      data: rows.map((r) => this.toUserView(r)),
    };
  }

  /**
   * 批量查询指定用户的在线状态（≤200 个）。
   * 用于会话成员列表、@提及候选、消息发送者头像绿点等场景。
   */
  async getUsersPresence(userId: string, ids: string[]) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (unique.length === 0) throw new BadRequestException('ids 不能为空');
    if (unique.length > PresenceService.MAX_BATCH) {
      throw new BadRequestException(`单次最多查询 ${PresenceService.MAX_BATCH} 个用户`);
    }

    const rows = await this.dataSource.query(
      `SELECT user_id,
              MAX(is_online) AS is_online,
              MAX(last_active_at) AS last_active_at,
              SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) AS online_devices
         FROM devices
        WHERE user_id IN (${unique.map(() => '?').join(',')})
        GROUP BY user_id`,
      unique,
    );

    const map = new Map<string, any>(rows.map((r: any) => [r.user_id, r]));
    return {
      data: unique.map((id) => {
        const r = map.get(id);
        // 查不到设备记录 = 从未登录过，按离线处理
        return {
          user_id: id,
          is_online: !!Number(r?.is_online ?? 0),
          online_devices: Number(r?.online_devices ?? 0),
          last_active_at: r?.last_active_at ?? null,
        };
      }),
    };
  }

  /** 只返回"我"的在线状态（含当前设备），前端启动时可用它判断是否需要补心跳 */
  async getMyPresence(userId: string, currentDeviceRecordId: string) {
    const rows = await this.dataSource.query(
      `SELECT id, device_name, device_type, is_online, socket_count, online_at, last_active_at
         FROM devices WHERE user_id = ?`,
      [userId],
    );
    return {
      is_online: rows.some((r: any) => Number(r.is_online) === 1),
      current_device_id: currentDeviceRecordId,
      devices: rows.map((r: any) => ({
        id: r.id,
        device_name: r.device_name,
        device_type: r.device_type,
        is_online: !!Number(r.is_online),
        socket_count: Number(r.socket_count ?? 0),
        online_at: r.online_at,
        last_active_at: r.last_active_at,
        is_current: r.id === currentDeviceRecordId,
      })),
    };
  }

  private toUserView(r: any) {
    const view: Record<string, any> = {};
    for (const f of SAFE_USER_FIELDS) view[String(f)] = r[String(f)] ?? null;
    view.online_devices = Number(r.online_devices ?? 0);
    view.last_active_at = r.last_active_at ?? null;
    view.is_online = view.online_devices > 0;
    return view;
  }
}

import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PresenceService } from 'src/modules/presence/presence.service';

/**
 * 用户端在线状态查询单测（V6.0）。
 *
 * 覆盖：
 *  - 在线用户列表：分页、关键词过滤、只返回通讯录白名单字段（不含密码/角色等）
 *  - 批量查询：去重、上限 200、无设备记录按离线、online_devices 计数
 *  - 本人状态：标记当前设备
 */

function buildService(opts: {
  rawRows?: any[];
  totalRow?: any[];
  deviceRows?: any[];
  queryImpl?: (sql: string, params: any[]) => any;
}) {
  const query = jest.fn(async (sql: string, params: any[]) => {
    if (opts.queryImpl) {
      const custom = opts.queryImpl(sql, params);
      if (custom !== undefined) return custom;
    }
    if (sql.includes('COUNT(DISTINCT u.id)')) return opts.totalRow ?? [{ cnt: 0 }];
    if (sql.includes('FROM devices') && sql.includes('GROUP BY user_id')) return opts.rawRows ?? [];
    if (sql.includes('FROM devices WHERE user_id')) return opts.deviceRows ?? [];
    return [];
  });

  const qb: any = {};
  ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'orderBy', 'offset', 'limit', 'innerJoin'].forEach(
    (m) => {
      qb[m] = jest.fn(() => qb);
    },
  );
  qb.getRawMany = jest.fn(async () => opts.rawRows ?? []);

  const dataSource: any = {
    query,
    getRepository: () => ({ createQueryBuilder: () => qb }),
  };

  return { service: new PresenceService(dataSource as DataSource), query, qb };
}

describe('PresenceService（用户端在线状态）', () => {
  it('listOnlineUsers：返回白名单字段 + online_devices + is_online，不含敏感字段', async () => {
    const row = {
      id: 'u-1',
      phone: '13800000001',
      display_name: '张三',
      avatar_url: null,
      signature: null,
      department: '技术部',
      role: 'admin',
      status: 'active',
      password_hash: 'should-not-leak',
      online_devices: '2',
      last_active_at: '2026-10-20T07:00:00.000Z',
    };
    const { service } = buildService({ rawRows: [row], totalRow: [{ cnt: 1 }] });

    const r = await service.listOnlineUsers({ page: 1, pageSize: 50 });

    expect(r.total).toBe(1);
    expect(r.data[0]).toMatchObject({
      id: 'u-1',
      display_name: '张三',
      is_online: true,
      online_devices: 2,
    });
    // 关键：不得泄露密码/角色等非通讯录字段
    expect(JSON.stringify(r.data[0])).not.toContain('should-not-leak');
    expect(r.data[0]).not.toHaveProperty('password_hash');
  });

  it('listOnlineUsers：pageSize 超过 100 时钳到 100', async () => {
    const { service } = buildService({ rawRows: [], totalRow: [{ cnt: 0 }] });
    const r = await service.listOnlineUsers({ page: 3, pageSize: 999 });
    expect(r.pageSize).toBe(100);
    expect(r.page).toBe(3);
  });

  it('getUsersPresence：去重 + 无设备记录按离线', async () => {
    const { service, query } = buildService({
      queryImpl: (sql) =>
        sql.includes('GROUP BY user_id')
          ? [{ user_id: 'u-1', is_online: '1', last_active_at: '2026-10-20T07:00:00Z', online_devices: '2' }]
          : undefined,
    });

    const r = await service.getUsersPresence('me', ['u-1', 'u-1', 'u-2', '']);

    expect(r.data).toHaveLength(2);
    expect(r.data[0]).toMatchObject({ user_id: 'u-1', is_online: true, online_devices: 2 });
    // u-2 没有设备记录 → 离线
    expect(r.data[1]).toMatchObject({ user_id: 'u-2', is_online: false, online_devices: 0 });
    expect(query).toHaveBeenCalled();
  });

  it('getUsersPresence：空 ids → 400', async () => {
    const { service } = buildService({});
    await expect(service.getUsersPresence('me', [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getUsersPresence：超过 200 个 → 400（防一次拉全校）', async () => {
    const { service } = buildService({});
    const ids = Array.from({ length: 201 }, (_, i) => `u-${i}`);
    await expect(service.getUsersPresence('me', ids)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getMyPresence：标记当前设备并汇总是否在线', async () => {
    const { service } = buildService({
      deviceRows: [
        { id: 'd-1', device_name: '手机', device_type: 'android', is_online: 1, socket_count: 2, online_at: 'x', last_active_at: 'y' },
        { id: 'd-2', device_name: '电脑', device_type: 'web', is_online: 0, socket_count: 0, online_at: null, last_active_at: 'z' },
      ],
    });

    const r = await service.getMyPresence('u-1', 'd-1');
    expect(r.is_online).toBe(true);
    expect(r.current_device_id).toBe('d-1');
    expect(r.devices.find((d) => d.id === 'd-1')?.is_current).toBe(true);
    expect(r.devices.find((d) => d.id === 'd-2')?.is_current).toBe(false);
  });
});

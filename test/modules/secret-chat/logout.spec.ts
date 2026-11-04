import { DataSource } from 'typeorm';
import { AuthService } from 'src/modules/auth/auth.service';
import { Device } from 'src/entities/device.entity';

/**
 * V6.2.1 · B-4：退出登录时服务端兜底结束该设备的加密会话。
 *
 * 覆盖：
 *  - 有绑定会话：先关会话（reason=device_removed 之外的 logout），再删设备记录，返回关闭数量
 *  - 没有会话：正常退出，closed=0
 *  - 关会话抛错：不阻塞退出（仍删设备、仍写审计）
 *  - deviceId 为空：不操作，返回 0
 */

function makeService(opts: { closeThrows?: boolean; closed?: number } = {}) {
  const deleted: any[] = [];
  const auditLogs: any[] = [];
  const deviceRepo: any = {
    delete: jest.fn(async (criteria: any) => {
      deleted.push(criteria);
      return { affected: 1 };
    }),
    find: jest.fn(async () => []),
  };
  const dataSource: any = {
    getRepository: (entity: any) => (entity === Device ? deviceRepo : {}),
  };

  const e2eService: any = {
    closeSecretChatsBoundTo: jest.fn(async () => {
      if (opts.closeThrows) throw new Error('db down');
      return opts.closed ?? 0;
    }),
    listMine: jest.fn(async () => []),
  };
  const keysService: any = { deleteDeviceKeyByDeviceId: jest.fn(async () => 0) };
  const audit: any = { log: jest.fn(async (x: any) => auditLogs.push(x)) };
  const authCache: any = { invalidate: jest.fn() };
  const events: any = { emitToUsers: jest.fn() };

  const service = new AuthService(
    dataSource as DataSource,
    audit,
    { issueTokenPair: jest.fn() } as any,
    authCache,
    events,
    keysService,
    e2eService,
  );

  return { service, deleted, auditLogs, e2eService, deviceRepo, authCache, events };
}

describe('AuthService · 退出登录（V6.2.1 B-4）', () => {
  it('先结束该设备的加密会话，再删除设备记录，返回关闭数量', async () => {
    const { service, deleted, e2eService, auditLogs } = makeService({ closed: 2 });

    const r = await service.logout('u-1', 'dev-1');

    expect(r).toEqual({ closed_secret_chats: 2 });
    expect(e2eService.closeSecretChatsBoundTo).toHaveBeenCalledWith('dev-1', 'logout');
    // 设备记录被删（token 立即失效）
    expect(deleted).toEqual([{ id: 'dev-1', user_id: 'u-1' }]);
    // 审计留痕
    expect(auditLogs.map((x) => x.action)).toEqual(expect.arrayContaining(['logout']));
  });

  it('没有加密会话时正常退出（closed=0）', async () => {
    const { service, deleted } = makeService({ closed: 0 });
    const r = await service.logout('u-1', 'dev-1');
    expect(r.closed_secret_chats).toBe(0);
    expect(deleted).toHaveLength(1);
  });

  it('关闭会话抛错不阻塞退出（仍删设备、仍写审计）', async () => {
    const { service, deleted, auditLogs } = makeService({ closeThrows: true });
    const r = await service.logout('u-1', 'dev-1');
    expect(r.closed_secret_chats).toBe(0);
    expect(deleted).toHaveLength(1);
    expect(auditLogs.some((x) => x.action === 'logout')).toBe(true);
  });

  it('deviceId 为空 → 不做任何操作，返回 0', async () => {
    const { service, deleted, e2eService } = makeService();
    const r = await service.logout('u-1', '');
    expect(r.closed_secret_chats).toBe(0);
    expect(e2eService.closeSecretChatsBoundTo).not.toHaveBeenCalled();
    expect(deleted).toHaveLength(0);
  });
});

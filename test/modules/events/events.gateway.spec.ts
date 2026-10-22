import { DataSource } from 'typeorm';
import { EventsGateway } from 'src/modules/events/events.gateway';
import { TokenService } from 'src/modules/auth/token.service';

/**
 * WS 断连 → 立即置离线（V6.2）。
 *
 * 为什么需要这条：
 * 离线推送只对 `is_online = 0` 的用户发。原先离线判定要等
 * PresenceScheduler 每分钟扫一次 + `last_active_at` 超过 ONLINE_TTL_SECONDS(150s)，
 * 也就是「App 切后台断连 → 最多约 210 秒后才判离线」，这期间的消息完全不推。
 * 现在断连时若 socket_count 归 0 就立即置离线。
 *
 * 断言重点：
 *  1. 第一条 UPDATE 把 socket_count 减 1（GREATEST 防负数）
 *  2. 第二条 UPDATE 带 `socket_count = 0 AND is_online = 1` 守卫（多标签页不误判）
 *  3. 真的更新成功（affected>0）才广播 device:offline
 */

function buildGateway(opts: { affected?: number } = {}) {
  const calls: Array<{ set: any; where: string[]; params: any }> = [];
  const executeResults = () => ({ affected: opts.affected ?? 1 });

  const qb: any = {};
  const state: any = { set: null, where: [], params: {} };
  ['update', 'set', 'where', 'andWhere', 'execute'].forEach((m) => {
    qb[m] = jest.fn((...args: any[]) => {
      if (m === 'set') state.set = args[0];
      if (m === 'where' || m === 'andWhere') {
        state.where.push(String(args[0]));
        Object.assign(state.params, args[1] ?? {});
      }
      if (m === 'execute') {
        calls.push({ set: state.set, where: [...state.where], params: { ...state.params } });
        return Promise.resolve(executeResults());
      }
      return qb;
    });
  });

  const dataSource: any = {
    getRepository: () => ({ createQueryBuilder: () => qb }),
  };
  const tokenService: any = { verifyAccessToken: jest.fn() };

  const gateway = new EventsGateway(tokenService as TokenService, dataSource as DataSource);
  const emitSpy = jest.fn();
  (gateway as any).server = { to: () => ({ emit: emitSpy }) };
  return { gateway, calls, emitSpy };
}

const fakeSocket = (data: any) => ({ id: 'sid-1', data }) as any;

/** 等内部未 await 的 promise 链跑完 */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('EventsGateway · 断连即离线（V6.2）', () => {
  it('socket_count 归 0 → 立即置离线并广播 device:offline', async () => {
    const { gateway, calls, emitSpy } = buildGateway({ affected: 1 });

    gateway.handleDisconnect(fakeSocket({ userId: 'u-1', deviceId: 'd-1' }));
    await flush();

    expect(calls).toHaveLength(2);
    // ① 计数 -1，且用 GREATEST 防负数
    expect(calls[0].set.socket_count()).toContain('GREATEST');
    // ② 置离线，带 socket_count=0 / is_online=1 双重守卫
    expect(calls[1].set.is_online).toBe(false);
    expect(calls[1].where.join(' ')).toContain('socket_count = 0');
    expect(calls[1].where.join(' ')).toContain('is_online = 1');
    expect(calls[1].params.deviceId).toBe('d-1');
    // ③ 广播
    expect(emitSpy).toHaveBeenCalledWith(
      'device:offline',
      expect.objectContaining({ device_id: 'd-1' }),
    );
  });

  it('多标签页场景（还有连接，affected=0）→ 不广播离线', async () => {
    const { gateway, emitSpy } = buildGateway({ affected: 0 });

    gateway.handleDisconnect(fakeSocket({ userId: 'u-1', deviceId: 'd-1' }));
    await flush();

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('未完成握手的连接（无 deviceId）→ 不碰数据库', async () => {
    const { gateway, calls } = buildGateway();
    gateway.handleDisconnect(fakeSocket({}));
    await flush();
    expect(calls).toHaveLength(0);
  });
});

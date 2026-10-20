import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Device } from '../../entities/device.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';

/**
 * 在线状态兜底清扫（V6.0）。
 *
 * WS 断开时只把 socket_count 减 1，不直接置离线 —— 因为"关掉一个标签页但还有另一个"
 * 不代表离线；而进程被杀 / 断网时 socket 断开事件可能丢失，socket_count 会残留。
 * 所以每分钟做一次判定：
 *
 *   is_online = (socket_count > 0) OR (last_active_at 在 ONLINE_TTL_SECONDS 内)
 *
 * 两者都不满足 → 置离线、写 offline_at，并广播 `device:offline`。
 * ONLINE_TTL_SECONDS 默认 150s（心跳 45~60s 一次，留 2~3 个周期容错）。
 */
@Injectable()
export class PresenceScheduler {
  private readonly logger = new Logger('Presence');

  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
  ) {}

  private onlineTtlSeconds(): number {
    const n = parseInt(process.env.ONLINE_TTL_SECONDS || '150', 10);
    return Number.isFinite(n) && n > 0 ? n : 150;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepOffline(): Promise<void> {
    const cutoff = new Date(Date.now() - this.onlineTtlSeconds() * 1000);
    const repo = this.dataSource.getRepository(Device);

    try {
      // 先查再更新：需要知道具体是哪几台设备，才能精准广播 device:offline
      const stale = await repo
        .createQueryBuilder('d')
        .select(['d.id', 'd.user_id'])
        .where('d.is_online = :online', { online: true })
        .andWhere('d.socket_count <= 0')
        .andWhere('(d.last_active_at IS NULL OR d.last_active_at < :cutoff)', { cutoff })
        .take(500)
        .getMany();
      if (stale.length === 0) return;

      const offlineAt = new Date();
      await repo.update(
        stale.map((d) => d.id),
        { is_online: false, offline_at: offlineAt },
      );

      // 按用户分组广播（同一用户多台设备同时离线时合并推送）
      const byUser = new Map<string, string[]>();
      for (const d of stale) {
        const list = byUser.get(d.user_id) ?? [];
        list.push(d.id);
        byUser.set(d.user_id, list);
      }
      for (const [userId, deviceIds] of byUser) {
        for (const deviceId of deviceIds) {
          this.events.emitToUsers(WS_EVENTS.DEVICE_OFFLINE, [userId], {
            device_id: deviceId,
            offline_at: offlineAt.toISOString(),
          });
        }
      }

      this.logger.log(`Marked ${stale.length} device(s) offline`);
    } catch (err: any) {
      this.logger.error(`Presence sweep failed: ${err?.message || err}`);
    }
  }
}

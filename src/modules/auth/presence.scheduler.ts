import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Device } from '../../entities/device.entity';

/**
 * 在线状态兜底清扫（V6.0）。
 *
 * WS 断开时只把 socket_count 减 1，不直接置离线 —— 因为"关掉一个标签页但还有另一个"
 * 不代表离线；而进程被杀 / 断网时 socket 断开事件可能丢失，socket_count 会残留。
 * 所以每分钟做一次判定：
 *
 *   is_online = (socket_count > 0) OR (last_active_at 在 ONLINE_TTL_SECONDS 内)
 *
 * 两者都不满足 → 置离线并记录 offline_at。
 * ONLINE_TTL_SECONDS 默认 150s（心跳 45~60s 一次，留 2~3 个周期容错）。
 */
@Injectable()
export class PresenceScheduler {
  private readonly logger = new Logger('Presence');

  constructor(private readonly dataSource: DataSource) {}

  private onlineTtlSeconds(): number {
    const n = parseInt(process.env.ONLINE_TTL_SECONDS || '150', 10);
    return Number.isFinite(n) && n > 0 ? n : 150;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepOffline(): Promise<void> {
    const cutoff = new Date(Date.now() - this.onlineTtlSeconds() * 1000);
    try {
      const result = await this.dataSource
        .getRepository(Device)
        .createQueryBuilder()
        .update()
        .set({ is_online: false, offline_at: new Date() })
        .where('is_online = :online', { online: true })
        .andWhere('socket_count <= 0')
        .andWhere('(last_active_at IS NULL OR last_active_at < :cutoff)', { cutoff })
        .execute();
      const affected = result.affected ?? 0;
      if (affected > 0) this.logger.log(`Marked ${affected} device(s) offline`);
    } catch (err: any) {
      this.logger.error(`Presence sweep failed: ${err?.message || err}`);
    }
  }
}

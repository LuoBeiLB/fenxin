import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Message } from '../../entities/message.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';
import { DestroyService } from './destroy.service';

/** 焚毁原因（与 message.destroy_reason 取值一致） */
type DestroyReason = 'fallback_expired' | 'all_read';

/**
 * 焚毁调度器（V6.0 两阶段销毁）。
 *
 * **阶段①（本类的每分钟任务）**：只做「标记」，绝不删除
 *   R1 兜底到期：`destroy_at <= now`（destroy_at = 发送 + max(兜底, ttl)，点开时会被延长）
 *   R2 阅读完成：
 *       私聊 = 唯一非发送方已点开 且 burn_at 已到期
 *       群聊 = 所有非发送方都已点开 且 burn_at 都已到期（n-1）
 *   标记动作：is_destroyed=1 + destroyed_at=now + destroy_reason，并广播 WS `message:destroyed`。
 *   此时消息行与附件仍然存在，只是对用户不可见。
 *
 * **阶段②（DestroyService）**：真删除由前端进入会话时确认触发，另有 ACK_FALLBACK_DAYS 兜底。
 *   本类每小时调用一次 `destroyService.purgeConfirmedOrExpired()` 推进兜底清理。
 *
 * 与旧版的关键差异：旧版命中规则就直接 `DELETE` 行 + 删附件，导致
 *   ① 无法审计、② 前端只能靠本地 localStorage 幽灵显示"已焚毁"、③ destroy_at 与 ttl 语义分裂。
 */
@Injectable()
export class BurnScheduler {
  private readonly logger = new Logger('BurnScheduler');

  /** 单批上限：避免单次事务过大；剩余的下个 tick 继续处理 */
  private static readonly BATCH = 500;

  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
    private readonly destroyService: DestroyService,
  ) {}

  /** 阶段①：每分钟把到期的焚毁消息标记为已销毁（不删除） */
  @Cron(CronExpression.EVERY_MINUTE)
  async markDestroyed() {
    const now = new Date();
    let total = 0;

    // R1 兜底到期：destroy_at 已过（含解散时批量写入的 destroy_at）
    total += await this.markBatch(
      'fallback_expired',
      'm.is_destroyed = :destroyed AND m.destroy_at IS NOT NULL AND m.destroy_at <= :now',
      { destroyed: false, now },
      now,
    );

    // R2 阅读完成（私聊 n-1=1 / 群聊 n-1 通用）：
    //   至少有一个非发送方回执，且不存在"未点开 或 未到期"的非发送方回执
    total += await this.markBatch(
      'all_read',
      `m.is_destroyed = :destroyed
       AND m.burn_ttl_seconds IS NOT NULL
       AND EXISTS (SELECT 1 FROM message_receipts r
                    WHERE r.message_id = m.id AND r.user_id <> m.sender_id)
       AND NOT EXISTS (SELECT 1 FROM message_receipts r
                        WHERE r.message_id = m.id AND r.user_id <> m.sender_id
                          AND (r.revealed_at IS NULL OR r.burn_at IS NULL OR r.burn_at > :now))`,
      { destroyed: false, now },
      now,
    );

    if (total > 0) this.logger.log(`Marked ${total} message(s) as destroyed (pending purge)`);
  }

  /**
   * 阶段②兜底：每小时推进一次真删除。
   * - 已被客户端确认且满足策略的 → 立即真删
   * - 超过 ACK_FALLBACK_DAYS 仍无确认的 → 强制真删（防行与附件无限堆积）
   */
  @Cron('0 * * * *')
  async purgeSweep() {
    try {
      const r = await this.destroyService.purgeConfirmedOrExpired();
      if (r.acked + r.expired > 0) {
        this.logger.log(`Purge sweep done: acked=${r.acked} timeout=${r.expired}`);
      }
    } catch (err: any) {
      // 清理失败不能影响标记任务；下个周期重试
      this.logger.error(`Purge sweep failed: ${err?.message || err}`);
    }
  }

  /**
   * 批量标记：先查出 id + 会话，再按 id 批量更新，最后按会话广播 WS。
   * 幂等：只处理 is_destroyed=0 的行，重复执行不会重复写 destroyed_at。
   */
  private async markBatch(
    reason: DestroyReason,
    whereSql: string,
    params: Record<string, unknown>,
    now: Date,
  ): Promise<number> {
    const repo = this.dataSource.getRepository(Message);

    const rows = await repo
      .createQueryBuilder('m')
      .select(['m.id', 'm.conversation_id'])
      .where(whereSql, params)
      .orderBy('m.created_at', 'ASC')
      .take(BurnScheduler.BATCH)
      .getMany();
    if (rows.length === 0) return 0;

    const ids = rows.map((m) => m.id);
    await repo
      .createQueryBuilder()
      .update()
      .set({ is_destroyed: true, destroyed_at: now, destroy_reason: reason })
      .whereInIds(ids)
      // 双重保险：并发下若已被别的路径标记，不覆盖原 destroyed_at
      .andWhere('is_destroyed = :notYet', { notYet: false })
      .execute();

    // 按会话分组广播：前端就地切「已焚毁」墓碑，不再依赖 4 秒轮询
    const byConv = new Map<string, string[]>();
    for (const m of rows) {
      const list = byConv.get(m.conversation_id) ?? [];
      list.push(m.id);
      byConv.set(m.conversation_id, list);
    }
    const memberRepo = this.dataSource.getRepository(ConversationMember);
    for (const [conversationId, messageIds] of byConv) {
      const members = await memberRepo.find({
        where: { conversation_id: conversationId },
        select: ['user_id'],
      });
      this.events.emitToUsers(
        WS_EVENTS.MESSAGE_DESTROYED,
        members.map((x) => x.user_id),
        {
          conversation_id: conversationId,
          message_ids: messageIds,
          reason,
          destroyed_at: now.toISOString(),
        },
      );
    }

    return rows.length;
  }
}

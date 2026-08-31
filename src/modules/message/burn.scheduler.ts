import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, In } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';

/**
 * 阅后即焚调度器（点开才焚 v2）：每分钟扫描并彻底销毁两类消息——
 *   A. 兜底到期：发送后超过 BURN_FALLBACK_TTL_HOURS（destroy_at），无论有没有人点开过；
 *   B. 全员看完：所有成员（含发送方）都点开过且各自的 burn_at 倒计时都已到期 → 提前物理删。
 * 销毁 = 删除回执 + 断开其他消息的引用 + 整行 DELETE + 删除磁盘附件。
 * 数据库与文件系统均不留痕迹（listMessages 另有到期过滤兜底）。
 */
@Injectable()
export class BurnScheduler {
  private readonly logger = new Logger('BurnScheduler');

  constructor(private readonly dataSource: DataSource) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async destroyExpiredMessages() {
    const now = new Date();
    const msgRepo = this.dataSource.getRepository(Message);

    // A. 兜底到期：destroy_at（发送时 = created_at + BURN_FALLBACK_TTL_HOURS）
    const fallbackExpired = await msgRepo
      .createQueryBuilder('m')
      .select(['m.id', 'm.file_url'])
      .where('m.is_destroyed = :isDestroyed', { isDestroyed: false })
      .andWhere('m.destroy_at IS NOT NULL')
      .andWhere('m.destroy_at <= :now', { now })
      .take(500)
      .getMany();

    // B. 全员看完且各自倒计时都到期：至少有一条回执，且不存在「未点开 / 倒计时未结束」的回执
    const allBurned = await msgRepo
      .createQueryBuilder('m')
      .select(['m.id', 'm.file_url'])
      .where('m.is_destroyed = :isDestroyed', { isDestroyed: false })
      .andWhere('m.burn_ttl_seconds IS NOT NULL')
      .andWhere('(m.destroy_at IS NULL OR m.destroy_at > :now)', { now })
      .andWhere('EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id = m.id)')
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id = m.id AND (r.burn_at IS NULL OR r.burn_at > :now))',
        { now },
      )
      .take(500)
      .getMany();

    // 合并去重（同一消息可能同时命中 A 和 B）
    const expired = [...fallbackExpired];
    const seen = new Set(expired.map((m) => m.id));
    for (const m of allBurned) {
      if (!seen.has(m.id)) expired.push(m);
    }

    if (expired.length === 0) return;

    const ids = expired.map((m) => m.id);
    await this.dataSource.transaction(async (em) => {
      // 1. 删除这些消息的已读/送达回执
      await em.getRepository(MessageReceipt).delete({ message_id: In(ids) });
      // 2. 其他消息若引用了被销毁消息，断开引用（避免悬空 reply_to_id）
      await em.getRepository(Message).update({ reply_to_id: In(ids) }, { reply_to_id: null });
      // 3. 整行物理删除（content/file_name/file_size 等全部随行消失）
      await em.getRepository(Message).delete({ id: In(ids) });
    });

    // 4. 删除磁盘上的附件文件（/uploads/<filename> -> UPLOAD_DIR/<filename>）
    const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
    for (const m of expired) {
      if (!m.file_url) continue;
      const filename = path.basename(m.file_url); // 防路径穿越，只取文件名
      try {
        fs.unlinkSync(path.join(uploadDir, filename));
      } catch {
        // 文件可能已不存在（如未上传成功），不影响销毁流程
      }
    }

    this.logger.log(`Destroyed ${ids.length} expired message(s) (rows + attachments)`);
  }
}

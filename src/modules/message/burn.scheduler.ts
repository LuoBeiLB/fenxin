import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, In } from 'typeorm';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';

/**
 * 阅后即焚调度器：每分钟扫描到期消息并销毁。
 * 销毁 = 删除回执 + 清空 content/file_url + 置 is_destroyed。
 * （listMessages 另有到期过滤兜底，双保险）
 */
@Injectable()
export class BurnScheduler {
  private readonly logger = new Logger('BurnScheduler');

  constructor(private readonly dataSource: DataSource) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async destroyExpiredMessages() {
    const expired = await this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .select(['m.id'])
      .where('m.is_destroyed = :isDestroyed', { isDestroyed: false })
      .andWhere('m.destroy_at IS NOT NULL')
      .andWhere('m.destroy_at <= :now', { now: new Date() })
      .take(500)
      .getMany();

    if (expired.length === 0) return;

    const ids = expired.map((m) => m.id);
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(MessageReceipt).delete({ message_id: In(ids) });
      await em
        .getRepository(Message)
        .update({ id: In(ids) }, { is_destroyed: true, content: null, file_url: null });
    });

    this.logger.log(`Destroyed ${ids.length} expired message(s)`);
  }
}

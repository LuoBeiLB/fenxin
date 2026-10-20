import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { MessageTombstone } from '../../entities/message-tombstone.entity';
import { MessageDestroyAck } from '../../entities/message-destroy-ack.entity';
import { OssService } from '../upload/oss.service';

/**
 * 两阶段销毁的「阶段②」——真删除服务（V6.0）。
 *
 * 背景：阶段①由 BurnScheduler 把到期消息标记为 is_destroyed=1（软删，行与附件仍在）。
 * 真删除不再由服务端单方面决定，而是由**前端进入会话时确认**触发：
 *
 *   前端 GET  /messages/:cid/pending-destroy  → 拿到待确认列表
 *   前端 POST /messages/:cid/destroy-ack      → 确认
 *   后端校验（成员身份 + 确实已焚毁）→ 满足策略 → 本服务 purge()
 *
 * purge() 是整个系统**唯一**的物理删除入口：
 *   写墓碑 → 删确认记录 → 删回执 → 断 reply_to 引用 → 删消息行 → 删附件
 *
 * 兜底：ACK_FALLBACK_DAYS（默认 7 天）内没人确认 → 定时任务强制真删，
 * 避免"用户永不打开会话"导致行与磁盘文件无限堆积。
 */
@Injectable()
export class DestroyService {
  private readonly logger = new Logger('Destroy');

  constructor(
    private readonly dataSource: DataSource,
    private readonly oss: OssService,
  ) {}

  /** 本地附件目录（与 upload.controller 一致） */
  private get uploadDir(): string {
    return path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
  }

  /** 群聊确认阈值：1=任一成员确认即可；0=必须全部非发送方成员确认 */
  private ackThreshold(): number {
    const n = parseInt(process.env.PURGE_ACK_THRESHOLD ?? '1', 10);
    return Number.isFinite(n) && n >= 0 ? n : 1;
  }

  /** 真删除兜底天数：超期未确认则强制删除；0 或负数 = 关闭兜底（永不自动真删） */
  private ackFallbackDays(): number {
    const n = parseInt(process.env.ACK_FALLBACK_DAYS ?? '7', 10);
    return Number.isFinite(n) ? n : 7;
  }

  /** 断言调用者是会话成员 */
  private async assertMember(conversationId: string, userId: string): Promise<void> {
    const membership = await this.dataSource.getRepository(ConversationMember).findOne({
      where: { conversation_id: conversationId, user_id: userId },
    });
    if (!membership) throw new ForbiddenException('Access denied to this conversation');
  }

  /**
   * 待确认真删除列表：本会话内「已焚毁」且「我还没确认过」的消息。
   * 只返回渲染/确认必需的元数据，**不含任何消息内容**。
   */
  async listPending(conversationId: string, userId: string) {
    await this.assertMember(conversationId, userId);

    const rows = await this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .select(['m.id', 'm.destroy_reason', 'm.destroyed_at', 'm.file_url', 'm.file_original_url'])
      .where('m.conversation_id = :conversationId', { conversationId })
      .andWhere('m.is_destroyed = :destroyed', { destroyed: true })
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM message_destroy_acks a
                      WHERE a.message_id = m.id AND a.user_id = :userId)`,
        { userId },
      )
      .orderBy('m.destroyed_at', 'ASC')
      .take(500)
      .getMany();

    return {
      conversation_id: conversationId,
      total: rows.length,
      pending: rows.map((m) => ({
        message_id: m.id,
        destroy_reason: m.destroy_reason,
        destroyed_at: m.destroyed_at,
        has_attachment: !!(m.file_url || m.file_original_url),
      })),
    };
  }

  /**
   * 确认这些已焚毁消息可以真删除。
   *
   * 校验：
   *  - 调用者必须是会话成员（否则 403）
   *  - 请求里属于本会话但**未焚毁**的消息 → 400（只能确认已焚毁的）
   *  - 已不存在（已被真删）的消息 → 跳过（幂等）
   *
   * 满足策略后立即 purge：
   *  - 私聊：任一确认即删
   *  - 群聊：确认人数 ≥ PURGE_ACK_THRESHOLD（默认 1）；阈值 0 表示必须 n-1 全确认
   */
  async ack(params: {
    conversationId: string;
    userId: string;
    deviceId?: string | null;
    messageIds: string[];
  }): Promise<{ acked: number; purged: number; purged_ids: string[] }> {
    const { conversationId, userId, deviceId } = params;
    const ids = [...new Set(params.messageIds.filter(Boolean))];
    await this.assertMember(conversationId, userId);
    if (ids.length === 0) return { acked: 0, purged: 0, purged_ids: [] };

    const conv = await this.dataSource
      .getRepository(Conversation)
      .findOne({ where: { id: conversationId } });
    if (!conv) throw new BadRequestException('会话不存在');

    const msgs = await this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .where('m.id IN (:...ids)', { ids })
      .andWhere('m.conversation_id = :conversationId', { conversationId })
      .getMany();

    const msgMap = new Map(msgs.map((m) => [m.id, m]));
    for (const id of ids) {
      const m = msgMap.get(id);
      // 不存在 = 可能已被真删（或别的会话）→ 跳过，幂等
      if (!m) continue;
      if (!m.is_destroyed) {
        throw new BadRequestException('只能确认已焚毁的消息');
      }
    }

    // 写确认记录（幂等 upsert）
    const ackRepo = this.dataSource.getRepository(MessageDestroyAck);
    const now = new Date();
    for (const id of ids) {
      if (!msgMap.has(id)) continue;
      await ackRepo.upsert(
        { message_id: id, user_id: userId, device_id: deviceId ?? null, acked_at: now },
        ['message_id', 'user_id'],
      );
    }

    // 策略判定 → 真删
    const purgedIds: string[] = [];
    for (const id of ids) {
      const m = msgMap.get(id);
      if (!m) continue;
      const shouldPurge = await this.meetsPurgePolicy(conversationId, conv.type, id);
      if (shouldPurge && (await this.purge(id, 'ack_by_user'))) purgedIds.push(id);
    }

    return {
      acked: ids.filter((id) => msgMap.has(id)).length,
      purged: purgedIds.length,
      purged_ids: purgedIds,
    };
  }

  /**
   * 判断某条已焚毁消息是否满足"可以真删"的条件。
   * - 私聊：只要有一条确认即可（内容已对全员不可见）
   * - 群聊：确认人数 ≥ 阈值；阈值为 0 时要求所有非发送方成员都确认
   */
  private async meetsPurgePolicy(
    conversationId: string,
    convType: string,
    messageId: string,
  ): Promise<boolean> {
    const ackCount = await this.dataSource
      .getRepository(MessageDestroyAck)
      .count({ where: { message_id: messageId } });
    if (convType === 'private') return ackCount >= 1;

    const threshold = this.ackThreshold();
    if (threshold >= 1) return ackCount >= threshold;

    // 阈值 0：必须所有非发送方成员都确认
    const msg = await this.dataSource
      .getRepository(Message)
      .findOne({ where: { id: messageId }, select: ['id', 'sender_id'] });
    if (!msg) return true;
    const need = await this.dataSource
      .getRepository(ConversationMember)
      .createQueryBuilder('cm')
      .where('cm.conversation_id = :conversationId', { conversationId })
      .andWhere('cm.user_id != :senderId', { senderId: msg.sender_id })
      .getCount();
    return need > 0 && ackCount >= need;
  }

  /**
   * **唯一的物理删除入口**：墓碑 + 删确认/回执 + 断引用 + 删行 + 删附件。
   * 幂等：消息不存在或未标记焚毁 → 直接返回 false。
   */
  async purge(
    messageId: string,
    trigger: 'ack_by_user' | 'ack_timeout' | 'admin' | 'manual',
  ): Promise<boolean> {
    const msgRepo = this.dataSource.getRepository(Message);
    const msg = await msgRepo.findOne({ where: { id: messageId } });
    if (!msg || !msg.is_destroyed) return false;

    const destroyedAt = msg.destroyed_at ?? new Date();
    const reason = msg.destroy_reason ?? 'manual';

    await this.dataSource.transaction(async (em) => {
      // ① 墓碑（真删后前端仍能渲染"此消息已焚毁"）
      await em.getRepository(MessageTombstone).upsert(
        {
          id: msg.id,
          conversation_id: msg.conversation_id,
          sender_id: msg.sender_id,
          type: msg.type,
          created_at: msg.created_at,
          destroyed_at: destroyedAt,
          destroy_reason: reason,
        },
        ['id'],
      );
      // ② 清理从属数据
      await em.getRepository(MessageDestroyAck).delete({ message_id: msg.id });
      await em.getRepository(MessageReceipt).delete({ message_id: msg.id });
      await em
        .getRepository(Message)
        .update({ reply_to_id: msg.id }, { reply_to_id: null });
      // ③ 物理删除消息行
      await em.getRepository(Message).delete({ id: msg.id });
    });

    // ④ 附件物理删除（事务外：失败只告警，绝不能回滚行删除）
    await this.deleteAttachments(msg);

    this.logger.log(
      `Purged message=${msg.id} reason=${reason} trigger=${trigger}`,
    );
    return true;
  }

  /**
   * 定时兜底：真删除「已确认满足策略」或「超过 ACK_FALLBACK_DAYS 未确认」的焚毁消息。
   * 由 BurnScheduler 每小时调用一次。
   */
  async purgeConfirmedOrExpired(): Promise<{ acked: number; expired: number }> {
    const days = this.ackFallbackDays();
    const cutoff = days > 0 ? new Date(Date.now() - days * 86400_000) : null;

    const rows: Array<{
      id: string;
      conv_type: string;
      ack_count: number | string;
      destroyed_at: Date | null;
    }> = await this.dataSource.query(
      `SELECT m.id, c.type AS conv_type,
              (SELECT COUNT(*) FROM message_destroy_acks a WHERE a.message_id = m.id) AS ack_count,
              m.destroyed_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.is_destroyed = 1
        ORDER BY m.destroyed_at ASC
        LIMIT 200`,
    );
    if (rows.length === 0) return { acked: 0, expired: 0 };

    let acked = 0;
    let expired = 0;
    for (const r of rows) {
      const ackCount = Number(r.ack_count ?? 0);
      // A. 已确认且满足策略
      const policyMet =
        r.conv_type === 'private'
          ? ackCount >= 1
          : this.ackThreshold() >= 1
            ? ackCount >= this.ackThreshold()
            : false; // 阈值 0 的全员确认场景交给 ack() 即时判定，这里不重复算
      // B. 超期兜底
      const timeout = cutoff !== null && r.destroyed_at && new Date(r.destroyed_at) < cutoff;

      if (policyMet && (await this.purge(r.id, 'ack_by_user'))) acked += 1;
      else if (timeout && (await this.purge(r.id, 'ack_timeout'))) expired += 1;
    }
    if (acked + expired > 0) {
      this.logger.log(`Purge sweep: ${acked} acked + ${expired} timeout`);
    }
    return { acked, expired };
  }

  /**
   * 删除消息附件：本地文件 + OSS 对象（主文件与原图）。
   * 注意：缩略图按团队决定暂不清理（见 docs/BURN_V2_DESIGN.md 决策记录）。
   * 全部失败容忍——附件残留不影响消息行已被删除的事实。
   */
  private async deleteAttachments(msg: Message): Promise<void> {
    const urls = [msg.file_url, msg.file_original_url].filter(Boolean) as string[];
    for (const u of urls) {
      if (/^https?:/i.test(u)) {
        await this.oss.deleteByUrl(u); // OSS 对象（失败内部只告警）
        continue;
      }
      const base = path.basename(u.split('?')[0].split('#')[0]);
      if (!base) continue;
      try {
        fs.unlinkSync(path.join(this.uploadDir, base));
      } catch {
        // 文件可能本就不存在（未上传成功 / 已被清理）
      }
    }
  }
}

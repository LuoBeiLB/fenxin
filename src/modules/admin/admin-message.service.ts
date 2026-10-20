import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';
import { MessageTombstone } from '../../entities/message-tombstone.entity';
import { MessageDestroyAck } from '../../entities/message-destroy-ack.entity';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { AppUser } from '../../entities/app-user.entity';
import { Device } from '../../entities/device.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';
import { AuditService } from '../audit/audit.service';
import { AdminDeviceQueryDto, AdminDestroyRecordQueryDto, AdminMessageQueryDto } from './dto';

/**
 * 管理端消息 / 焚毁记录 / 已读统计服务（V6.0）。
 *
 * 设计原则：
 * - 只读为主：管理端能看、能手动焚毁，但不提供"物理删除"接口
 *   （真删除只能走 DestroyService.purge，避免出现第二条删除路径）。
 * - 内容最小暴露：已焚毁 / 已撤回 / 加密消息一律返回占位符，
 *   未焚毁消息也只返回 80 字摘录，不把整段明文吐给管理台。
 * - 所有人工操作写审计日志。
 */
@Injectable()
export class AdminMessageService {
  /** 内容摘录长度上限 */
  private static readonly SNIPPET = 80;

  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
  ) {}

  // ===================== 消息管理 =====================

  async listMessages(q: AdminMessageQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;

    const qb = this.messageQb().orderBy('m.created_at', 'DESC');
    if (q.conversation_id) qb.andWhere('m.conversation_id = :cid', { cid: q.conversation_id });
    if (q.sender_id) qb.andWhere('m.sender_id = :sid', { sid: q.sender_id });
    if (q.type) qb.andWhere('m.type = :type', { type: q.type });
    if (q.burn_only === 'true') qb.andWhere('m.burn_ttl_seconds IS NOT NULL');
    if (q.burn_only === 'false') qb.andWhere('m.burn_ttl_seconds IS NULL');
    if (q.is_destroyed === 'true') qb.andWhere('m.is_destroyed = 1');
    if (q.is_destroyed === 'false') qb.andWhere('m.is_destroyed = 0');
    if (q.keyword) qb.andWhere('m.content LIKE :kw', { kw: `%${q.keyword}%` });
    if (q.start_time) qb.andWhere('m.created_at >= :st', { st: new Date(q.start_time) });
    if (q.end_time) qb.andWhere('m.created_at <= :et', { et: new Date(q.end_time) });

    const total = await qb.getCount();
    const rows = await qb
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getRawMany();

    return { total, page, pageSize, data: rows.map((r) => this.toMessageView(r)) };
  }

  async getMessageDetail(id: string) {
    const raw = await this.messageQb().where('m.id = :id', { id }).getRawOne();
    if (!raw) throw new NotFoundException('消息不存在');

    const receipts = await this.dataSource
      .getRepository(MessageReceipt)
      .createQueryBuilder('r')
      .leftJoin(AppUser, 'u2', 'u2.id = r.user_id')
      .select([
        'r.user_id AS user_id',
        'u2.display_name AS display_name',
        'r.is_read AS is_read',
        'r.read_at AS read_at',
        'r.revealed_at AS revealed_at',
        'r.burn_at AS burn_at',
      ])
      .where('r.message_id = :id', { id })
      .getRawMany();

    const ackRow = await this.dataSource
      .getRepository(MessageDestroyAck)
      .createQueryBuilder('a')
      .select('COUNT(*)', 'cnt')
      .where('a.message_id = :id', { id })
      .getRawOne();

    return {
      message: this.toMessageView(raw),
      receipts: receipts.map((r) => ({
        user_id: r.user_id,
        display_name: r.display_name,
        is_sender: r.user_id === raw.sender_id,
        is_read: !!Number(r.is_read),
        read_at: r.read_at,
        revealed_at: r.revealed_at,
        burn_at: r.burn_at,
      })),
      acked_count: Number(ackRow?.cnt ?? 0),
      tombstone: await this.dataSource.getRepository(MessageTombstone).findOne({ where: { id } }),
    };
  }

  /**
   * 手动焚毁：只做阶段①标记（is_destroyed=1, reason=manual），不物理删除。
   * 真删除仍由前端确认 / 超期兜底执行，保证系统只有一条删除路径。
   */
  async manualDestroy(id: string, operatorId: string, ip?: string) {
    const repo = this.dataSource.getRepository(Message);
    const msg = await repo.findOne({ where: { id } });
    if (!msg) throw new NotFoundException('消息不存在');
    if (msg.is_destroyed) return { success: true, already: true, message_id: id };

    const now = new Date();
    await repo.update(id, { is_destroyed: true, destroyed_at: now, destroy_reason: 'manual' });

    const members = await this.dataSource
      .getRepository(ConversationMember)
      .find({ where: { conversation_id: msg.conversation_id }, select: ['user_id'] });
    this.events.emitToUsers(
      WS_EVENTS.MESSAGE_DESTROYED,
      members.map((m) => m.user_id),
      {
        conversation_id: msg.conversation_id,
        message_ids: [id],
        reason: 'manual',
        destroyed_at: now.toISOString(),
      },
    );

    await this.audit.log({
      userId: operatorId,
      action: 'admin_manual_destroy_message',
      targetType: 'message',
      targetId: id,
      detail: `conversation_id=${msg.conversation_id} sender=${msg.sender_id}`,
      ipAddress: ip,
    });

    return { success: true, already: false, message_id: id, destroyed_at: now.toISOString() };
  }

  // ===================== 焚毁记录（两阶段统一视图）=====================

  /**
   * - pending_purge：messages.is_destroyed=1（已标记、等确认或超期兜底真删）
   * - purged：message_tombstones（已真删，只剩墓碑元数据）
   */
  async listDestroyRecords(q: AdminDestroyRecordQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const stage = q.stage ?? 'all';

    const pending = stage === 'purged' ? [] : await this.queryPending(q);
    const purged = stage === 'pending_purge' ? [] : await this.queryPurged(q);

    // 合并后按焚毁时间倒序；两个来源各取 500 条上限，量级可控。
    // 后续数据量变大时可改为 UNION ALL 在数据库侧分页。
    const merged = [...pending, ...purged].sort(
      (a, b) => new Date(b.destroyed_at ?? 0).getTime() - new Date(a.destroyed_at ?? 0).getTime(),
    );
    const start = (page - 1) * pageSize;
    return { total: merged.length, page, pageSize, data: merged.slice(start, start + pageSize) };
  }

  private async queryPending(q: AdminDestroyRecordQueryDto) {
    const qb = this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .leftJoin(Conversation, 'c', 'c.id = m.conversation_id')
      .leftJoin(AppUser, 'u', 'u.id = m.sender_id')
      .select([
        'm.id AS id',
        'm.conversation_id AS conversation_id',
        'm.sender_id AS sender_id',
        'm.type AS type',
        'm.created_at AS created_at',
        'm.destroyed_at AS destroyed_at',
        'm.destroy_reason AS destroy_reason',
        'c.name AS conversation_name',
        'c.type AS conversation_type',
        'c.member_count AS member_count',
        'u.display_name AS sender_name',
      ])
      .where('m.is_destroyed = 1');

    if (q.reason) qb.andWhere('m.destroy_reason = :reason', { reason: q.reason });
    if (q.conversation_id) qb.andWhere('m.conversation_id = :cid', { cid: q.conversation_id });
    if (q.start_time) qb.andWhere('m.destroyed_at >= :st', { st: new Date(q.start_time) });
    if (q.end_time) qb.andWhere('m.destroyed_at <= :et', { et: new Date(q.end_time) });

    const rows = await qb.orderBy('m.destroyed_at', 'DESC').limit(500).getRawMany();
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const ackRows = await this.dataSource
      .getRepository(MessageDestroyAck)
      .createQueryBuilder('a')
      .select('a.message_id', 'message_id')
      .addSelect('COUNT(*)', 'cnt')
      .where('a.message_id IN (:...ids)', { ids })
      .groupBy('a.message_id')
      .getRawMany<{ message_id: string; cnt: string }>();
    const ackMap = new Map(ackRows.map((r) => [r.message_id, Number(r.cnt)]));
    const ackDays = this.ackFallbackDays();

    return rows.map((r) => {
      const destroyedAt = r.destroyed_at ? new Date(r.destroyed_at) : null;
      // 群聊需确认人数 = n-1（排除发送方）；私聊只需 1 人
      const need =
        r.conversation_type === 'private' ? 1 : Math.max(1, Number(r.member_count ?? 1) - 1);
      return {
        stage: 'pending_purge',
        message_id: r.id,
        conversation_id: r.conversation_id,
        conversation_name: r.conversation_name,
        conversation_type: r.conversation_type,
        sender_id: r.sender_id,
        sender_name: r.sender_name,
        type: r.type,
        created_at: r.created_at,
        destroyed_at: r.destroyed_at,
        destroy_reason: r.destroy_reason,
        alive_seconds: this.aliveSeconds(r.created_at, r.destroyed_at),
        acked_count: ackMap.get(r.id) ?? 0,
        members_need: need,
        will_purge_at:
          destroyedAt && ackDays > 0
            ? new Date(destroyedAt.getTime() + ackDays * 86400_000).toISOString()
            : null,
      };
    });
  }

  private async queryPurged(q: AdminDestroyRecordQueryDto) {
    const qb = this.dataSource
      .getRepository(MessageTombstone)
      .createQueryBuilder('t')
      .leftJoin(Conversation, 'c', 'c.id = t.conversation_id')
      .leftJoin(AppUser, 'u', 'u.id = t.sender_id')
      .select([
        't.id AS id',
        't.conversation_id AS conversation_id',
        't.sender_id AS sender_id',
        't.type AS type',
        't.created_at AS created_at',
        't.destroyed_at AS destroyed_at',
        't.destroy_reason AS destroy_reason',
        'c.name AS conversation_name',
        'c.type AS conversation_type',
        'u.display_name AS sender_name',
      ]);

    if (q.reason) qb.andWhere('t.destroy_reason = :reason', { reason: q.reason });
    if (q.conversation_id) qb.andWhere('t.conversation_id = :cid', { cid: q.conversation_id });
    if (q.start_time) qb.andWhere('t.destroyed_at >= :st', { st: new Date(q.start_time) });
    if (q.end_time) qb.andWhere('t.destroyed_at <= :et', { et: new Date(q.end_time) });

    const rows = await qb.orderBy('t.destroyed_at', 'DESC').limit(500).getRawMany();
    return rows.map((r) => ({
      stage: 'purged',
      message_id: r.id,
      conversation_id: r.conversation_id,
      conversation_name: r.conversation_name,
      conversation_type: r.conversation_type,
      sender_id: r.sender_id,
      sender_name: r.sender_name,
      type: r.type,
      created_at: r.created_at,
      destroyed_at: r.destroyed_at,
      destroy_reason: r.destroy_reason,
      alive_seconds: this.aliveSeconds(r.created_at, r.destroyed_at),
      acked_count: null,
      members_need: null,
      will_purge_at: null,
    }));
  }

  // ===================== 已读统计 =====================

  /** 会话维度：各成员已读/未读条数 + 已读水位 */
  async readStatsConversation(conversationId: string) {
    const conv = await this.dataSource
      .getRepository(Conversation)
      .findOne({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');

    const members = await this.dataSource
      .getRepository(ConversationMember)
      .createQueryBuilder('cm')
      .leftJoin(AppUser, 'u', 'u.id = cm.user_id')
      .select([
        'cm.user_id AS user_id',
        'cm.role AS role',
        'cm.last_read_message_id AS last_read_message_id',
        'cm.joined_at AS joined_at',
        'u.display_name AS display_name',
        'u.phone AS phone',
      ])
      .where('cm.conversation_id = :cid', { cid: conversationId })
      .getRawMany();

    const counts = await this.dataSource
      .getRepository(MessageReceipt)
      .createQueryBuilder('r')
      .innerJoin(Message, 'm', 'm.id = r.message_id')
      .select('r.user_id', 'user_id')
      .addSelect('SUM(CASE WHEN r.is_read = 1 THEN 1 ELSE 0 END)', 'read_cnt')
      .addSelect('SUM(CASE WHEN r.is_read = 0 THEN 1 ELSE 0 END)', 'unread_cnt')
      .where('m.conversation_id = :cid', { cid: conversationId })
      .andWhere('m.is_destroyed = 0')
      .groupBy('r.user_id')
      .getRawMany<{ user_id: string; read_cnt: string; unread_cnt: string }>();
    const countMap = new Map(counts.map((c) => [c.user_id, c]));

    const totalRow = await this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .select('COUNT(*)', 'cnt')
      .where('m.conversation_id = :cid', { cid: conversationId })
      .andWhere('m.is_destroyed = 0')
      .getRawOne();

    const rows = members.map((m) => {
      const c = countMap.get(m.user_id);
      const read = Number(c?.read_cnt ?? 0);
      const unread = Number(c?.unread_cnt ?? 0);
      return {
        user_id: m.user_id,
        display_name: m.display_name,
        phone: m.phone,
        role: m.role,
        joined_at: m.joined_at,
        last_read_message_id: m.last_read_message_id,
        read_count: read,
        unread_count: unread,
        read_rate: read + unread > 0 ? Number((read / (read + unread)).toFixed(4)) : null,
      };
    });

    return {
      conversation_id: conversationId,
      conversation_type: conv.type,
      message_total: Number(totalRow?.cnt ?? 0),
      members: rows.sort((a, b) => b.read_count - a.read_count),
    };
  }

  /** 消息维度：谁看了、谁没看（排除发送方统计） */
  async readStatsMessage(messageId: string) {
    const detail = await this.getMessageDetail(messageId);
    const others = detail.receipts.filter((r) => !r.is_sender);
    return {
      message_id: messageId,
      is_destroyed: detail.message.is_destroyed,
      total: others.length,
      revealed: others.filter((r) => !!r.revealed_at).length,
      read: others.filter((r) => r.is_read).length,
      readers: detail.receipts,
    };
  }

  // ===================== 焚毁概览（数据总览页）=====================

  async burnOverview() {
    const repo = this.dataSource.getRepository(Message);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [todayDestroyed, reasonRows, aliveRow, activeBurn, pendingPurge, purgedTotal] =
      await Promise.all([
        repo
          .createQueryBuilder('m')
          .select('COUNT(*)', 'cnt')
          .where('m.is_destroyed = 1')
          .andWhere('m.destroyed_at >= :t', { t: startOfToday })
          .getRawOne(),
        repo
          .createQueryBuilder('m')
          .select('m.destroy_reason', 'reason')
          .addSelect('COUNT(*)', 'cnt')
          .where('m.is_destroyed = 1')
          .andWhere('m.destroyed_at >= :t', { t: startOfToday })
          .groupBy('m.destroy_reason')
          .getRawMany(),
        repo
          .createQueryBuilder('m')
          .select('AVG(TIMESTAMPDIFF(SECOND, m.created_at, m.destroyed_at))', 'avg_seconds')
          .where('m.is_destroyed = 1')
          .andWhere('m.destroyed_at >= :t', { t: startOfToday })
          .getRawOne(),
        repo
          .createQueryBuilder('m')
          .select('COUNT(*)', 'cnt')
          .where('m.burn_ttl_seconds IS NOT NULL')
          .andWhere('m.is_destroyed = 0')
          .getRawOne(),
        repo.createQueryBuilder('m').select('COUNT(*)', 'cnt').where('m.is_destroyed = 1').getRawOne(),
        this.dataSource.getRepository(MessageTombstone).count(),
      ]);

    return {
      today_destroyed: Number(todayDestroyed?.cnt ?? 0),
      destroy_reason_today: reasonRows.map((r) => ({
        reason: r.reason,
        count: Number(r.cnt ?? 0),
      })),
      avg_alive_seconds_today: aliveRow?.avg_seconds ? Math.round(Number(aliveRow.avg_seconds)) : null,
      active_burn_messages: Number(activeBurn?.cnt ?? 0),
      pending_purge: Number(pendingPurge?.cnt ?? 0),
      purged_total: purgedTotal,
    };
  }

  // ===================== 在线监控 =====================

  async presenceOverview() {
    const deviceRepo = this.dataSource.getRepository(Device);
    const ttl = this.onlineTtlSeconds();
    const cutoff = new Date(Date.now() - ttl * 1000);

    const [onlineDevices, totalDevices, onlineUsersRow, typeRows] = await Promise.all([
      deviceRepo.count({ where: { is_online: true } }),
      deviceRepo.count(),
      deviceRepo
        .createQueryBuilder('d')
        .select('COUNT(DISTINCT d.user_id)', 'cnt')
        .where('d.is_online = 1')
        .getRawOne(),
      deviceRepo
        .createQueryBuilder('d')
        .select('d.device_type', 'device_type')
        .addSelect('COUNT(*)', 'cnt')
        .where('d.is_online = 1')
        .groupBy('d.device_type')
        .getRawMany(),
    ]);

    // 自检：超过 TTL 还标着在线的设备数（正常应为 0，异常说明清扫任务没跑）
    const staleRow = await deviceRepo
      .createQueryBuilder('d')
      .select('COUNT(*)', 'cnt')
      .where('d.is_online = 1')
      .andWhere('d.socket_count <= 0')
      .andWhere('(d.last_active_at IS NULL OR d.last_active_at < :cutoff)', { cutoff })
      .getRawOne();

    return {
      online_users: Number(onlineUsersRow?.cnt ?? 0),
      online_devices: onlineDevices,
      total_devices: totalDevices,
      online_by_type: typeRows.map((r) => ({
        device_type: r.device_type,
        count: Number(r.cnt ?? 0),
      })),
      online_ttl_seconds: ttl,
      stale_online_devices: Number(staleRow?.cnt ?? 0),
    };
  }

  async listDevices(q: AdminDeviceQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;

    const qb = this.dataSource
      .getRepository(Device)
      .createQueryBuilder('d')
      .leftJoin(AppUser, 'u', 'u.id = d.user_id')
      .select([
        'd.id AS id',
        'd.user_id AS user_id',
        'd.device_name AS device_name',
        'd.device_type AS device_type',
        'd.device_id AS device_id',
        'd.is_online AS is_online',
        'd.socket_count AS socket_count',
        'd.online_at AS online_at',
        'd.offline_at AS offline_at',
        'd.last_active_at AS last_active_at',
        'd.created_at AS created_at',
        'u.display_name AS display_name',
        'u.phone AS phone',
      ])
      .orderBy('d.is_online', 'DESC')
      .addOrderBy('d.last_active_at', 'DESC');

    if (q.online_only === 'true') qb.andWhere('d.is_online = 1');
    if (q.device_type) qb.andWhere('d.device_type = :dt', { dt: q.device_type });
    if (q.keyword) {
      qb.andWhere('(u.phone LIKE :kw OR u.display_name LIKE :kw)', { kw: `%${q.keyword}%` });
    }

    const total = await qb.getCount();
    const rows = await qb.offset((page - 1) * pageSize).limit(pageSize).getRawMany();

    return {
      total,
      page,
      pageSize,
      data: rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        display_name: r.display_name,
        phone: r.phone,
        device_name: r.device_name,
        device_type: r.device_type,
        device_fingerprint: r.device_id,
        is_online: !!Number(r.is_online),
        socket_count: Number(r.socket_count ?? 0),
        online_at: r.online_at,
        offline_at: r.offline_at,
        last_active_at: r.last_active_at,
        created_at: r.created_at,
      })),
    };
  }

  /** 强制下线：删设备记录（token 立即失效）+ WS 通知 + 审计 */
  async forceOfflineDevice(deviceRecordId: string, operatorId: string, ip?: string) {
    const device = await this.dataSource
      .getRepository(Device)
      .findOne({ where: { id: deviceRecordId } });
    if (!device) throw new NotFoundException('设备不存在');

    await this.dataSource.getRepository(Device).delete({ id: deviceRecordId });
    this.events.emitToUsers(WS_EVENTS.DEVICE_REMOVED, [device.user_id], {
      device_id: deviceRecordId,
    });
    await this.audit.log({
      userId: operatorId,
      action: 'admin_force_offline_device',
      targetType: 'device',
      targetId: deviceRecordId,
      detail: `user_id=${device.user_id} device=${device.device_name}(${device.device_type})`,
      ipAddress: ip,
    });
    return { success: true, device_id: deviceRecordId, user_id: device.user_id };
  }

  // ===================== 保留策略（只读 env）=====================

  retentionSettings() {
    return {
      ack_fallback_days: this.ackFallbackDays(),
      purge_ack_threshold: this.purgeAckThreshold(),
      burn_fallback_hours: this.burnFallbackHours(),
      online_ttl_seconds: this.onlineTtlSeconds(),
      editable: false,
      note:
        '保留策略由服务端环境变量控制（ACK_FALLBACK_DAYS / PURGE_ACK_THRESHOLD / ' +
        'BURN_FALLBACK_TTL_HOURS / ONLINE_TTL_SECONDS），修改后需重启生效',
    };
  }

  // ===================== 内部工具 =====================

  /** 消息检索/详情共用的查询（含会话名、发送者信息） */
  private messageQb(): SelectQueryBuilder<Message> {
    return this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .leftJoin(Conversation, 'c', 'c.id = m.conversation_id')
      .leftJoin(AppUser, 'u', 'u.id = m.sender_id')
      .select([
        'm.id AS id',
        'm.conversation_id AS conversation_id',
        'm.sender_id AS sender_id',
        'm.type AS type',
        'm.content AS content',
        'm.file_name AS file_name',
        'm.file_url AS file_url',
        'm.burn_ttl_seconds AS burn_ttl_seconds',
        'm.destroy_at AS destroy_at',
        'm.is_destroyed AS is_destroyed',
        'm.destroyed_at AS destroyed_at',
        'm.destroy_reason AS destroy_reason',
        'm.is_encrypted AS is_encrypted',
        'm.is_recalled AS is_recalled',
        'm.created_at AS created_at',
        'c.name AS conversation_name',
        'c.type AS conversation_type',
        'u.display_name AS sender_name',
        'u.phone AS sender_phone',
      ]);
  }

  private toMessageView(r: any) {
    const destroyed = !!Number(r.is_destroyed);
    const recalled = !!Number(r.is_recalled);
    const encrypted = !!Number(r.is_encrypted);
    return {
      id: r.id,
      conversation_id: r.conversation_id,
      conversation_name: r.conversation_name ?? null,
      conversation_type: r.conversation_type ?? null,
      sender_id: r.sender_id,
      sender_name: r.sender_name ?? null,
      sender_phone: r.sender_phone ?? null,
      type: r.type,
      // 内容最小暴露：已焚毁 / 已撤回 / 加密 一律占位
      content_snippet: destroyed
        ? '[已焚毁]'
        : recalled
          ? '[已撤回]'
          : encrypted
            ? '[加密消息]'
            : r.content
              ? String(r.content).slice(0, AdminMessageService.SNIPPET)
              : null,
      file_name: destroyed ? null : r.file_name,
      has_attachment: !!(r.file_url || r.file_name),
      is_burn: r.burn_ttl_seconds != null,
      burn_ttl_seconds: r.burn_ttl_seconds,
      is_destroyed: destroyed,
      destroyed_at: r.destroyed_at,
      destroy_reason: r.destroy_reason,
      destroy_at: r.destroy_at,
      is_encrypted: encrypted,
      is_recalled: recalled,
      created_at: r.created_at,
    };
  }

  private aliveSeconds(createdAt: any, destroyedAt: any): number | null {
    if (!createdAt || !destroyedAt) return null;
    const diff = (new Date(destroyedAt).getTime() - new Date(createdAt).getTime()) / 1000;
    return Number.isFinite(diff) && diff >= 0 ? Math.round(diff) : null;
  }

  private ackFallbackDays(): number {
    const n = parseInt(process.env.ACK_FALLBACK_DAYS ?? '7', 10);
    return Number.isFinite(n) ? n : 7;
  }

  private purgeAckThreshold(): number {
    const n = parseInt(process.env.PURGE_ACK_THRESHOLD ?? '1', 10);
    return Number.isFinite(n) && n >= 0 ? n : 1;
  }

  private burnFallbackHours(): number {
    const n = parseInt(process.env.BURN_FALLBACK_TTL_HOURS ?? '24', 10);
    return Number.isFinite(n) && n > 0 ? n : 24;
  }

  private onlineTtlSeconds(): number {
    const n = parseInt(process.env.ONLINE_TTL_SECONDS || '150', 10);
    return Number.isFinite(n) && n > 0 ? n : 150;
  }
}

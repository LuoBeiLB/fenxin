import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { AppUser } from '../../entities/app-user.entity';
import { MessageTombstone } from '../../entities/message-tombstone.entity';
import { EventsGateway } from '../events/events.gateway';
import { OssService } from '../upload/oss.service';
import { PushService } from '../push/push.service';
import { WS_EVENTS } from '../events/events.types';

/** 兜底强制焚毁时长（毫秒）：env BURN_FALLBACK_TTL_HOURS，默认 24 小时 */
function burnFallbackTtlMs(): number {
  const hours = parseInt(process.env.BURN_FALLBACK_TTL_HOURS || '24', 10);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600 * 1000;
}

/** 消息持续时长上限（秒）：与用户偏好字段一致（30 天），防把毫秒当秒填 */
const MAX_BURN_TTL_SECONDS = 30 * 24 * 3600;

/**
 * 音视频焚毁消息的消费窗口（秒）：max(用户设的 burn_ttl_seconds, 窗口值)。
 * v5.8.9 播完才焚：reveal 只发内容并开启一个「消费窗口」，前端播放完成/放弃时调
 * POST /messages/:id/consume 把自己的 burn_at 提前置为当下；窗口到期未 consume
 * 则由 BurnScheduler 按既有规则兜底焚毁（防杀进程/断网导致永不销毁）。
 * - duration > 0：窗口 = duration + BURN_MEDIA_BUFFER_SECONDS（默认 30s 缓冲，留给切后台接电话等场景）
 * - duration 缺失：窗口 = BURN_MEDIA_DEFAULT_WINDOW_SECONDS（默认 300s）
 * - 用户 ttl 更大时以 ttl 为准（用户设定的保护期不被缩短，如设 1 小时焚毁的窗口就是 1 小时）
 */
function burnMediaWindowSeconds(ttlSeconds: number, durationSeconds?: number): number {
  const buffer = parseInt(process.env.BURN_MEDIA_BUFFER_SECONDS || '30', 10);
  const fallbackWindow = parseInt(process.env.BURN_MEDIA_DEFAULT_WINDOW_SECONDS || '300', 10);
  const bufferSec = Number.isFinite(buffer) && buffer > 0 ? buffer : 30;
  const fallbackSec = Number.isFinite(fallbackWindow) && fallbackWindow > 0 ? fallbackWindow : 300;
  const windowSec =
    durationSeconds && durationSeconds > 0 ? durationSeconds + bufferSec : fallbackSec;
  return Math.max(ttlSeconds, windowSec);
}

/** 视频文件扩展名（与前端 isVideoMsg 判断保持一致：前端发送视频实际走 type='file'，靠扩展名识别） */
const VIDEO_FILE_EXT = /\.(mp4|webm|mov|m4v|mkv|avi|3gp)$/i;

/**
 * 是否音视频焚毁消息（v5.8.9 播完才焚的适用范围，对齐前端 is_media_burn 契约）：
 * type 为 voice / video，或 type='file' 但 file_name 扩展名是视频格式。
 * 文本 / 图片 / 普通文件焚毁消息不适用（reveal 即倒计时，无 consume）。
 */
function isMediaBurnMsg(msg: Pick<Message, 'type' | 'file_name'>): boolean {
  if (msg.type === 'voice' || msg.type === 'video') return true;
  return msg.type === 'file' && !!msg.file_name && VIDEO_FILE_EXT.test(msg.file_name);
}


/** 解析搜索时间参数：ISO8601 字符串或毫秒时间戳（10~13 位）→ Date；非法抛 400 */
function parseDateParam(name: 'after' | 'before', raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = /^\d{10,13}$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  if (isNaN(d.getTime())) {
    throw new BadRequestException(`${name} 参数格式错误，应为 ISO8601 日期或毫秒时间戳`);
  }
  return d;
}

/**
 * 生成搜索结果摘要（content_snippet）：关键词首个命中位置前后各 15 个 Unicode 码点，越界补 …。
 * 用 Array.from 按码点切片（emoji / 代理对安全），不用 SQL 的 SUBSTRING（其对 4 字节字符有截断风险）。
 * 未直接命中完整 keyword（如多词 OR 命中分词组合）时兜底截前 34 个码点。
 */
function buildSnippet(text: string, keyword: string): string {
  if (!text) return '';
  const chars = Array.from(text);
  const pos = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (pos < 0) {
    const head = chars.slice(0, 34).join('');
    return chars.length > 34 ? head + '…' : '';
  }
  const kwLen = Array.from(keyword).length;
  const cpIdx = Array.from(text.slice(0, pos)).length;
  const start = Math.max(0, cpIdx - 15);
  const end = Math.min(chars.length, cpIdx + kwLen + 15);
  return (start > 0 ? '…' : '') + chars.slice(start, end).join('') + (end < chars.length ? '…' : '');
}

@Injectable()
export class MessageService {
  private readonly logger = new Logger('Message');

  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
    private readonly oss: OssService,
    private readonly push: PushService,
  ) {}

  private async assertMember(conversationId: string, userId: string) {
    const membership = await this.dataSource.getRepository(ConversationMember).findOne({
      where: { conversation_id: conversationId, user_id: userId },
    });
    if (!membership) throw new ForbiddenException('Access denied to this conversation');
    return membership;
  }

  /**
   * 归一化焚毁时长（V6.0）：
   * - 优先 `burn_ttl_seconds`（新协议，秒）
   * - 旧客户端只传 `destroy_at`（ISO8601）→ 反算 ttl，避免"旧 APK 发的焚毁消息变成永久消息"
   * - 结果 clamp 到 [1, MAX_BURN_TTL_SECONDS]；无法解析 → null（视为非焚毁消息）
   */
  private normalizeBurnTtl(ttlSeconds?: number, destroyAtIso?: string): number | null {
    if (ttlSeconds != null && Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) > 0) {
      return Math.min(Math.ceil(Number(ttlSeconds)), MAX_BURN_TTL_SECONDS);
    }
    if (destroyAtIso) {
      const ms = new Date(destroyAtIso).getTime() - Date.now();
      if (Number.isFinite(ms) && ms > 0) {
        return Math.min(Math.max(1, Math.ceil(ms / 1000)), MAX_BURN_TTL_SECONDS);
      }
    }
    return null;
  }

  /**
   * 有效剩余秒数（V6.0）：`min(burn_at, destroy_at) - now`。
   * - 正常情况下 `reveal` 已把 destroy_at 推到 ≥ burn_at，取谁都一样
   * - 但对存量数据（destroy_at 曾被截断成 24h）取 min 才不会"显示比实际活得久"
   */
  private effectiveRemainSeconds(
    burnAt: Date | string | null,
    destroyAt: Date | string | null,
    nowMs: number,
  ): number {
    if (!burnAt) return 0;
    let deadline = new Date(burnAt).getTime();
    if (destroyAt) deadline = Math.min(deadline, new Date(destroyAt).getTime());
    return Math.max(0, Math.ceil((deadline - nowMs) / 1000));
  }

  /** 会话全体成员的用户 ID 列表（用于 WebSocket 定向推送） */
  private async getMemberUserIds(conversationId: string): Promise<string[]> {
    const members = await this.dataSource.getRepository(ConversationMember).find({
      where: { conversation_id: conversationId },
    });
    return members.map((m) => m.user_id);
  }

  /** 发消息：必须先是会话成员（修复旧版越权发消息漏洞） */
  async sendMessage(params: {
    conversationId: string;
    senderId: string;
    type: string;
    content?: string;
    fileUrl?: string;
    fileName?: string;
    fileSize?: number;
    /** 音视频时长（秒，v5.8.9 播完才焚）：语音=录音秒数、视频=播放器 metadata duration */
    mediaDurationSeconds?: number;
    fileOriginalUrl?: string;
    replyToId?: string;
    burnTtlSeconds?: number;
    /** 【旧客户端兼容】绝对销毁时间（ISO8601）；仅在 burnTtlSeconds 缺失时用于反算 ttl */
    destroyAt?: string;
    senderEphemeralPubkey?: string;
    cipherNonce?: string;
    cipherText?: string;
    mentions?: string[];
  }): Promise<Message> {
    const msgRepo = this.dataSource.getRepository(Message);
    const convRepo = this.dataSource.getRepository(Conversation);
    const memberRepo = this.dataSource.getRepository(ConversationMember);
    const receiptRepo = this.dataSource.getRepository(MessageReceipt);

    const membership = await this.assertMember(params.conversationId, params.senderId);

    const conv = await convRepo.findOne({ where: { id: params.conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    if (conv.dissolved_at) throw new ForbiddenException('群组已解散，不能再发送消息');

    // 个人频道为纯广播（v5.8.6）：仅频道主（owner）可以发布内容，订阅者只读
    if (conv.type === 'channel' && membership.role !== 'owner') {
      throw new ForbiddenException('频道为广播模式，仅频道主可以发布内容');
    }

    // 成员列表一次查询两用：@提及过滤（V5.8）+ 落库后建回执
    const members = await memberRepo.find({ where: { conversation_id: params.conversationId } });
    // @提及（V5.8）：只保留真实成员的 uid（防伪造脏数据），Set 去重
    const memberUids = new Set(members.map((m) => m.user_id));
    const mentions = [...new Set(params.mentions ?? [])].filter((uid) => memberUids.has(uid));

    // E2E：三个加密字段必须同时提供（全密文）或同时缺省（明文），不允许半加密状态
    const encFields = [params.senderEphemeralPubkey, params.cipherNonce, params.cipherText];
    const isEncrypted = encFields.every((f) => f !== undefined && f !== null && f !== '');
    if (!isEncrypted && encFields.some((f) => f !== undefined && f !== null && f !== '')) {
      throw new BadRequestException(
        '加密字段不完整：sender_ephemeral_pubkey / cipher_nonce / cipher_text 必须同时提供',
      );
    }

    // 加密消息豁免 content 必填：密文在 cipher_text，服务端不应接触明文
    if (params.type === 'text' && !params.content && !isEncrypted) {
      throw new BadRequestException('文本消息 content 不能为空');
    }
    if (params.type !== 'text' && !params.fileUrl) {
      throw new BadRequestException(`${params.type} 消息 file_url 不能为空`);
    }

    // ===== 焚毁参数归一化（V6.0）=====
    // 优先级：burn_ttl_seconds（新协议）> destroy_at（旧客户端兼容，反算 ttl）
    // destroy_at 落库值 = now + max(兜底时长, ttl)，保证"兜底不会早于用户设定的持续时间"。
    const burnTtl = this.normalizeBurnTtl(params.burnTtlSeconds, params.destroyAt);
    const fallbackMs = burnFallbackTtlMs();

    const savedMsg = await msgRepo.save(
      msgRepo.create({
        conversation_id: params.conversationId,
        sender_id: params.senderId,
        type: params.type as Message['type'],
        // E2E 语义：密文消息的 content 一律强制占位，即使调用方传了 content 也不落库（服务端不见明文）
        content: isEncrypted ? '[加密消息]' : (params.content ?? null),
        file_url: params.fileUrl ?? null,
        file_name: params.fileName ?? null,
        file_size: params.fileSize ?? null,
        // v5.8.9 播完才焚：发送端上报音视频时长，reveal 时计算消费窗口（老消息 null 走默认窗口）
        media_duration: params.mediaDurationSeconds ?? null,
        file_original_url: params.fileOriginalUrl ?? null,
        reply_to_id: params.replyToId ?? null,
        // 焚毁消息：burn_ttl_seconds 非空；
        // destroy_at = 绝对销毁上限 = now + max(兜底, ttl)（首次点开时还会按 burn_at 延长）
        burn_ttl_seconds: burnTtl,
        destroy_at: burnTtl ? new Date(Date.now() + Math.max(fallbackMs, burnTtl * 1000)) : null,
        // E2E 加密字段（明文消息全为 null / false）
        is_encrypted: isEncrypted,
        cipher_nonce: isEncrypted ? params.cipherNonce! : null,
        cipher_text: isEncrypted ? params.cipherText! : null,
        sender_ephemeral_pubkey: isEncrypted ? params.senderEphemeralPubkey! : null,
        mentions,
      }),
    );

    await convRepo.update(params.conversationId, { last_message_at: new Date() });

    // 点开才焚 v2：全体成员（含发送方）都建回执——发送方这份也要走 reveal 才计时。
    // 发送方天然已读自己发的消息；receipt 同时承载每人各自的 revealed_at / burn_at。
    const now = new Date();
    await receiptRepo.save(
      members.map((m) =>
        receiptRepo.create({
          message_id: savedMsg.id,
          user_id: m.user_id,
          is_read: m.user_id === params.senderId,
          read_at: m.user_id === params.senderId ? now : null,
        }),
      ),
    );

    // 实时推送：新消息 + 会话列表刷新信号（推给全体成员，含发送者的其他在线设备）
    // 焚毁消息必须马赛克化推送，否则前端从 WS 推送体里直接拿到内容，马赛克形同虚设
    const memberIds = members.map((m) => m.user_id);
    this.events.emitToUsers(WS_EVENTS.MESSAGE_NEW, memberIds, {
      conversation_id: params.conversationId,
      message: savedMsg.burn_ttl_seconds ? this.maskBurnMessage(savedMsg) : savedMsg,
    });
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, memberIds, {
      conversation_id: params.conversationId,
      reason: 'message',
    });

    // 离线推送（V6.2）：只推当前离线的成员，内容按类型脱敏。
    // 必须异步、不 await —— 极光慢或挂掉都不能拖慢/影响发消息。
    // catch 里**要落日志**：PushService 内部已兜底，这层是防止将来改动后异常被静默吞掉。
    void this.push
      .notifyNewMessage({ message: savedMsg, memberIds, senderId: params.senderId })
      .catch((err: any) => this.logger.warn(`[push] notify skipped: ${err?.message || err}`));

    return savedMsg;
  }

  /** 焚毁消息马赛克化：未点开前不下发任何内容字段（含密文与附件地址） */
  private maskBurnMessage(msg: Message): Message & { is_blurred: boolean } {
    return {
      ...msg,
      content: null,
      file_url: null,
      file_name: null,
      file_size: null,
      file_original_url: null,
      cipher_nonce: null,
      cipher_text: null,
      sender_ephemeral_pubkey: null,
      is_blurred: true,
    };
  }

  /**
   * 点开才焚视图：按当前用户的 receipt 状态决定每条焚毁消息返回什么。
   * - 未点开：马赛克占位（is_blurred=true），不下发内容
   * - 已点开未到期：完整内容 + burn_at + remain_seconds（前端据此跑本地倒计时）
   * - 已到期：整条不返回（对该用户而言已焚毁）
   * 非焚毁消息原样返回。
   */
  private async applyBurnView(messages: Message[], userId: string) {
    // 加列前的存量老消息 mentions 为 JSON null（NOT NULL 无默认值时的隐式填充），
    // 统一归一化为 []，保证前端 m.mentions?.includes(...) 永远拿到数组
    for (const m of messages) {
      if (!Array.isArray(m.mentions)) m.mentions = [];
    }

    const burnIds = messages.filter((m) => m.burn_ttl_seconds !== null).map((m) => m.id);
    if (burnIds.length === 0) return messages;

    const receipts = await this.dataSource.getRepository(MessageReceipt).find({
      where: { message_id: In(burnIds), user_id: userId },
    });
    const receiptMap = new Map(receipts.map((r) => [r.message_id, r]));

    const now = Date.now();
    const result: unknown[] = [];
    for (const m of messages) {
      if (m.burn_ttl_seconds === null) {
        result.push(m);
        continue;
      }
      const r = receiptMap.get(m.id);
      // 已点开且倒计时到期 → 对该用户已焚毁，不返回
      if (r?.burn_at && new Date(r.burn_at).getTime() <= now) continue;
      // 未点开（含老数据无 receipt 的防御场景）→ 马赛克占位
      if (!r?.revealed_at) {
        result.push(this.maskBurnMessage(m));
        continue;
      }
      // 已点开未到期 → 完整内容 + 剩余秒数（burn_at 必非空：到期分支已 continue）
      result.push({
        ...m,
        is_blurred: false,
        burn_at: r.burn_at,
        // V6.0：取 min(burn_at, destroy_at)，避免"显示还有 7 天、实际 24 小时就删"
        remain_seconds: this.effectiveRemainSeconds(r.burn_at, m.destroy_at, now),
      });
    }
    return result;
  }

  async listMessages(params: {
    conversationId: string;
    userId: string;
    before?: string;
    limit?: number;
    /** true = 历史里也返回已焚毁消息（墓碑形式；正文/附件全 null，占分页位置） */
    includeDestroyed?: boolean;
  }): Promise<unknown[]> {
    await this.assertMember(params.conversationId, params.userId);

    const limit = params.limit || 50;
    const now = new Date();
    const qb = this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .where('m.conversation_id = :conversationId', { conversationId: params.conversationId });

    if (!params.includeDestroyed) {
      // 默认（向后兼容）：过滤已焚毁 + 兜底到期（定时任务还没跑也不返回）
      qb.andWhere('m.is_destroyed = :isDestroyed', { isDestroyed: false });
      qb.andWhere('(m.destroy_at IS NULL OR m.destroy_at > :now)', { now });
    }

    qb.orderBy('m.created_at', 'DESC').take(limit);

    if (params.before) {
      qb.andWhere('m.created_at < :before', { before: new Date(params.before) });
    }

    const messages = await qb.getMany();

    // include_destroyed 时把「已焚毁 / 已到期」的行拆出来，直接渲染成墓碑，
    // 不再走 applyBurnView —— 否则焚毁消息会因为 receipt 到期被整条丢弃
    let destroyedViews: unknown[] = [];
    let alive = messages;
    if (params.includeDestroyed) {
      const nowMs = now.getTime();
      destroyedViews = messages
        .filter((m) => m.is_destroyed || (m.destroy_at != null && new Date(m.destroy_at).getTime() <= nowMs))
        .map((m) => this.tombstoneOf(m));
      const destroyedIds = new Set(
        messages
          .filter((m) => m.is_destroyed || (m.destroy_at != null && new Date(m.destroy_at).getTime() <= nowMs))
          .map((m) => m.id),
      );
      alive = messages.filter((m) => !destroyedIds.has(m.id));
    }

    // 点开才焚：按当前用户 receipt 状态过滤/马赛克化（只处理未焚毁的部分）
    const view = await this.applyBurnView(alive.reverse(), params.userId);
    const merged = [...view, ...destroyedViews].sort(
      (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    // V6.0：把「已真删」的墓碑（message_tombstones）补回聊天流
    return this.attachTombstones(params.conversationId, merged, {
      before: params.before,
      limit,
    });
  }

  /**
   * 已焚毁消息的对外视图（墓碑）：**只保留渲染占位必需的元数据**，
   * 正文、附件、密文一律置 null —— 焚毁后绝不能再吐出内容。
   */
  private tombstoneOf(m: {
    id: string;
    conversation_id: string;
    sender_id: string;
    type: string;
    created_at: Date | string;
    destroyed_at?: Date | string | null;
    destroy_reason?: string | null;
  }): Record<string, unknown> {
    return {
      id: m.id,
      conversation_id: m.conversation_id,
      sender_id: m.sender_id,
      type: m.type,
      created_at: m.created_at,
      destroyed_at: m.destroyed_at ?? null,
      destroy_reason: m.destroy_reason ?? null,
      is_destroyed: true,
      is_burned: true,
      is_blurred: false,
      is_recalled: false,
      is_edited: false,
      is_encrypted: false,
      content: null,
      file_url: null,
      file_name: null,
      file_size: null,
      file_original_url: null,
      cipher_nonce: null,
      cipher_text: null,
      sender_ephemeral_pubkey: null,
      reply_to_id: null,
      mentions: [],
    };
  }

  /**
   * 墓碑合并（V6.0）：把当前页时间范围内「已焚毁」的消息补成墓碑。
   *
   * 数据来源两处：
   *  ① `messages.is_destroyed=1`（已标记、尚未真删）—— 行还在
   *  ② `message_tombstones`（已真删）—— 行没了，只剩元数据
   * 墓碑不含任何内容字段，只用于渲染占位。
   *
   * 时间范围策略：
   *  - 当前页有消息：取 [最早, 最晚] 区间，保证墓碑插在正确位置、不破坏分页
   *  - 当前页为空（例如会话里唯一一条已被真删）：取最近 `limit` 条墓碑；
   *    翻历史（before）时取 before 之前的
   */
  private async attachTombstones(
    conversationId: string,
    list: unknown[],
    opts: { before?: string; limit: number },
  ): Promise<unknown[]> {
    let from: Date | undefined;
    let to: Date | undefined;
    if (list.length > 0) {
      const times = list
        .map((m: any) => new Date(m.created_at).getTime())
        .filter((t) => Number.isFinite(t));
      if (times.length > 0) {
        from = new Date(Math.min(...times));
        to = new Date(Math.max(...times));
      }
    } else if (opts.before) {
      to = new Date(opts.before);
    }

    const tombstoneRepo = this.dataSource.getRepository(MessageTombstone);
    const tombQb = tombstoneRepo
      .createQueryBuilder('t')
      .where('t.conversation_id = :conversationId', { conversationId })
      .orderBy('t.created_at', 'DESC')
      .take(opts.limit);
    const markedQb = this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .select([
        'm.id',
        'm.conversation_id',
        'm.sender_id',
        'm.type',
        'm.created_at',
        'm.destroyed_at',
        'm.destroy_reason',
      ])
      .where('m.conversation_id = :conversationId', { conversationId })
      .andWhere('m.is_destroyed = :destroyed', { destroyed: true })
      .orderBy('m.created_at', 'DESC')
      .take(opts.limit);

    if (from && to) {
      tombQb.andWhere('t.created_at BETWEEN :from AND :to', { from, to });
      markedQb.andWhere('m.created_at BETWEEN :from AND :to', { from, to });
    } else if (to) {
      tombQb.andWhere('t.created_at < :to', { to });
      markedQb.andWhere('m.created_at < :to', { to });
    }

    const [purged, marked] = await Promise.all([tombQb.getMany(), markedQb.getMany()]);
    if (purged.length === 0 && marked.length === 0) return list;

    const seen = new Set(list.map((m: any) => String(m.id)));
    const extra: unknown[] = [];
    const push = (id: string, conversation_id: string, sender_id: string, type: string,
                  created_at: Date, destroyed_at: Date | null, destroy_reason: string | null) => {
      if (seen.has(String(id))) return;
      seen.add(String(id));
      extra.push(this.tombstoneOf({ id, conversation_id, sender_id, type, created_at, destroyed_at, destroy_reason }));
    };

    for (const t of purged) {
      push(t.id, t.conversation_id, t.sender_id, t.type, t.created_at, t.destroyed_at, t.destroy_reason);
    }
    for (const m of marked) {
      push(m.id, m.conversation_id, m.sender_id, m.type, m.created_at, m.destroyed_at, m.destroy_reason);
    }

    return [...list, ...extra].sort(
      (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }

  /**
   * 点开查看焚毁消息：返回完整内容，并从点开时刻起为该用户开始倒计时焚毁。
   * 重复点开不重置计时；自己那份倒计时到期 / 兜底到期后一律按「已焚毁」404 处理。
   *
   * v5.8.9 播完才焚：voice/video 焚毁消息的倒计时为消费窗口（max(ttl, 媒体时长+缓冲)），
   * 返回 media_burn_pending / consume_deadline 提示前端播完调 consume 提前焚毁。
   */
  async revealMessage(messageId: string, userId: string, mediaDurationSeconds?: number) {
    const msgRepo = this.dataSource.getRepository(Message);
    const receiptRepo = this.dataSource.getRepository(MessageReceipt);

    const msg = await msgRepo.findOne({ where: { id: messageId } });
    if (!msg || msg.is_destroyed) throw new NotFoundException('消息不存在');
    await this.assertMember(msg.conversation_id, userId);
    if (!msg.burn_ttl_seconds) throw new BadRequestException('该消息不是焚毁消息，无需点开');
    if (msg.is_recalled) throw new BadRequestException('消息已撤回');

    const now = new Date();
    // 兜底到期（一直没点开，超过 BURN_FALLBACK_TTL_HOURS）
    if (msg.destroy_at && new Date(msg.destroy_at).getTime() <= now.getTime()) {
      throw new NotFoundException('消息已焚毁');
    }

    let receipt = await receiptRepo.findOne({
      where: { message_id: messageId, user_id: userId },
    });
    if (!receipt) {
      // 防御：老数据可能没给该成员建 receipt
      receipt = await receiptRepo.save(
        receiptRepo.create({
          message_id: messageId,
          user_id: userId,
          is_read: false,
        }),
      );
    }

    // 自己这份倒计时已到期
    if (receipt.burn_at && new Date(receipt.burn_at).getTime() <= now.getTime()) {
      throw new NotFoundException('消息已焚毁');
    }

    if (!receipt.revealed_at) {
      // 首次点开：开始该用户的焚毁倒计时，点开即已读
      // v5.8.9 播完才焚（仅音视频焚毁消息，含 type=file 的视频扩展名）：倒计时不再是短 ttl
      // （防 10s ttl 焚毁 30s 视频），而是 max(ttl, 消费窗口)——窗口内可反复播放；
      // 前端播完/放弃时调 consume 提前焚，窗口到期未调则 BurnScheduler 按既有规则兜底焚毁。
      // 时长优先级：发送时存库的 media_duration > reveal 请求带的 media_duration_seconds > 默认窗口。
      const isMedia = isMediaBurnMsg(msg);
      const burnSeconds = isMedia
        ? burnMediaWindowSeconds(msg.burn_ttl_seconds, msg.media_duration ?? mediaDurationSeconds)
        : msg.burn_ttl_seconds;
      const burnAt = new Date(now.getTime() + burnSeconds * 1000);
      await receiptRepo.update(receipt.id, {
        revealed_at: now,
        burn_at: burnAt,
        is_read: true,
        read_at: now,
      });
      receipt.revealed_at = now;
      receipt.burn_at = burnAt;

      // V6.0：把消息的绝对销毁上限推到不早于本人这份的到期时刻。
      // 否则会出现"7 天档消息在第 24 小时（destroy_at）被兜底删掉，而用户手里还有 6 天"。
      const curDestroyMs = msg.destroy_at ? new Date(msg.destroy_at).getTime() : 0;
      if (burnAt.getTime() > curDestroyMs) {
        await msgRepo.update(msg.id, { destroy_at: burnAt });
        msg.destroy_at = burnAt;
      }

      // 广播已读回执：发送方实时看到「对方已点开」
      const memberIds = await this.getMemberUserIds(msg.conversation_id);
      this.events.emitToUsers(WS_EVENTS.RECEIPT_READ, memberIds, {
        conversation_id: msg.conversation_id,
        user_id: userId,
        last_read_message_id: messageId,
        read_at: now.toISOString(),
      });
    }

    return {
      ...msg,
      is_blurred: false,
      burn_at: receipt.burn_at,
      // V6.0：剩余时间取 min(burn_at, destroy_at)，保证「显示的天数 = 实际存活天数」
      remain_seconds: this.effectiveRemainSeconds(receipt.burn_at, msg.destroy_at, now.getTime()),
      // v5.8.9 播完才焚（仅音视频焚毁消息）：media_burn_pending=true 提示前端
      // 播放完成/放弃时调 POST /messages/:id/consume 提前焚毁（对齐前端契约字段名）；
      // consume_deadline = 消费窗口截止（ISO8601），到点未 consume 由调度器兜底焚毁。
      // 文本/图片焚毁消息两者均为 undefined / false，老前端可安全忽略新增字段。
      media_burn_pending: isMediaBurnMsg(msg),
      consume_deadline: isMediaBurnMsg(msg) && receipt.burn_at
        ? new Date(receipt.burn_at).toISOString()
        : undefined,
    };
  }

  /**
   * 消费音视频焚毁消息（v5.8.9 播完才焚）：前端播放完成或中途放弃时调用。
   * 语义 = 把「该成员这份内容」的焚毁截止时间（burn_at）提前置为当下——此后他再 reveal
   * 即得「已焚毁」；物理删除仍由 BurnScheduler 统一执行（所有接收方都到期才删行删文件，
   * 群聊「各看各的」语义不变，未看成员不受影响）。
   * - 幂等：重复调用 / 自己窗口已到期 / 消息已被调度器物理删除 → 均返回 already=true 成功
   * - 仅音视频焚毁消息支持（voice/video 或 file+视频扩展名，对齐前端 is_media_burn 契约）；
   *   必须先 reveal（拿到过内容才谈得上消费）
   * - 返回焚毁视图：is_blurred=true、content/file_url 置 null、burned=true（对齐前端契约）
   * - 广播 message:consumed 事件：对端与本人其他设备实时切「已焚毁」态
   */
  async consumeMessage(messageId: string, userId: string) {
    const msgRepo = this.dataSource.getRepository(Message);
    const receiptRepo = this.dataSource.getRepository(MessageReceipt);

    // 与调度器竞态：消息行可能已被物理删除 → 视为已焚毁，幂等成功
    const msg = await msgRepo.findOne({ where: { id: messageId } });
    if (!msg) return { burned: true, already: true };

    await this.assertMember(msg.conversation_id, userId);
    if (!msg.burn_ttl_seconds) {
      throw new BadRequestException('该消息不是焚毁消息，无需消费');
    }
    if (!isMediaBurnMsg(msg)) {
      throw new BadRequestException('仅音视频焚毁消息支持播完才焚（consume）');
    }
    if (msg.is_recalled) throw new BadRequestException('消息已撤回');

    const receipt = await receiptRepo.findOne({
      where: { message_id: messageId, user_id: userId },
    });
    // 未点开过（无 receipt 或从未 reveal）：没拿过内容谈不上消费
    if (!receipt || !receipt.revealed_at) {
      throw new BadRequestException('请先点开查看后再消费');
    }

    const now = new Date();
    // 自己这份已到期（已 consume 过 / 消费窗口已烧完）→ 幂等成功
    // 返回焚毁视图（对齐前端契约：200 + 已焚毁的消息结构，内容字段置 null，不吐密文）
    if (receipt.burn_at && new Date(receipt.burn_at).getTime() <= now.getTime()) {
      return {
        id: msg.id,
        conversation_id: msg.conversation_id,
        type: msg.type,
        is_blurred: true,
        content: null,
        file_url: null,
        file_original_url: null,
        burn_at: receipt.burn_at,
        burned: true,
        already: true,
      };
    }

    // 核心动作：把自己这份的钟拨到现在（物理删除交给调度器按既有规则统一执行）
    await receiptRepo.update(receipt.id, { burn_at: now });

    // 广播消费事件：对端与本人其他在线设备实时切「已焚毁」态
    const memberIds = await this.getMemberUserIds(msg.conversation_id);
    this.events.emitToUsers(WS_EVENTS.MESSAGE_CONSUMED, memberIds, {
      conversation_id: msg.conversation_id,
      message_id: messageId,
      user_id: userId,
      consumed_at: now.toISOString(),
    });

    // 返回焚毁视图（前端契约：is_blurred=true + content/file_url 置 null + burned=true）
    return {
      id: msg.id,
      conversation_id: msg.conversation_id,
      type: msg.type,
      is_blurred: true,
      content: null,
      file_url: null,
      file_original_url: null,
      burn_at: now.toISOString(),
      burned: true,
      already: false,
    };
  }

  async editMessage(messageId: string, userId: string, newContent: string): Promise<Message> {
    const msgRepo = this.dataSource.getRepository(Message);
    const message = await msgRepo.findOne({ where: { id: messageId } });
    if (!message || message.is_destroyed) throw new NotFoundException('消息不存在');
    if (message.sender_id !== userId) throw new ForbiddenException('You can only edit your own messages');
    if (message.is_recalled) throw new BadRequestException('Cannot edit a recalled message');
    // 焚毁消息禁止编辑：内容只在点开时下发，编辑会破坏「点开才焚」计时语义
    if (message.burn_ttl_seconds) throw new BadRequestException('焚毁消息不支持编辑');

    const hoursSinceCreated = (Date.now() - new Date(message.created_at).getTime()) / (1000 * 60 * 60);
    if (hoursSinceCreated > 48) throw new BadRequestException('Cannot edit messages older than 48 hours');

    await msgRepo.update(messageId, { content: newContent, is_edited: true });
    const updated = await msgRepo.findOne({ where: { id: messageId } });

    // 实时推送：编辑后的完整消息体（前端就地更新对应气泡）
    if (updated) {
      const memberIds = await this.getMemberUserIds(message.conversation_id);
      this.events.emitToUsers(WS_EVENTS.MESSAGE_EDITED, memberIds, {
        conversation_id: message.conversation_id,
        message: updated,
      });
    }
    return updated;
  }

  async recallMessage(messageId: string, userId: string): Promise<void> {
    const msgRepo = this.dataSource.getRepository(Message);
    const message = await msgRepo.findOne({ where: { id: messageId } });
    if (!message || message.is_destroyed) throw new NotFoundException('消息不存在');
    if (message.sender_id !== userId) throw new ForbiddenException('You can only recall your own messages');

    const hoursSinceCreated = (Date.now() - new Date(message.created_at).getTime()) / (1000 * 60 * 60);
    if (hoursSinceCreated > 48) throw new BadRequestException('Cannot recall messages older than 48 hours');

    await msgRepo.update(messageId, { is_recalled: true });

    // 实时推送：撤回信号（前端把对应消息就地替换为「消息已撤回」灰条）
    const memberIds = await this.getMemberUserIds(message.conversation_id);
    this.events.emitToUsers(WS_EVENTS.MESSAGE_RECALLED, memberIds, {
      conversation_id: message.conversation_id,
      message_id: messageId,
      recalled_at: new Date().toISOString(),
    });
  }

  /** 标记已读：单条 UPDATE + 子查询，不再先查全量消息 ID */
  /**
   * 标记已读（V6.0 支持上界）：
   * - 传 `upToMessageId`：只把该条（含）之前、且尚未读的消息标记已读
   *   —— 避免"刚进会话就把后面没看过的也标成已读"
   * - 不传：整会话全部标记（兼容旧客户端）
   */
  async markAsRead(
    conversationId: string,
    userId: string,
    upToMessageId?: string,
  ): Promise<void> {
    await this.assertMember(conversationId, userId);

    // 上界消息的 created_at（用于只标记到该条）
    let upToCreatedAt: Date | null = null;
    if (upToMessageId) {
      const upTo = await this.dataSource.getRepository(Message).findOne({
        where: { id: upToMessageId, conversation_id: conversationId },
        select: ['id', 'created_at'],
      });
      if (upTo) upToCreatedAt = upTo.created_at;
    }

    // V6.1 口径（按 READ_UNREAD_API.md §4）：整会话标记时**跳过**两类消息
    //   ① 未点开的焚毁消息（必须 reveal 后才算已读）
    //   ② 未查看的加密消息（必须先点开查看；由 /read-messages 单条上报）
    // 同时跳过已焚毁的消息（已销毁的东西不该产生已读回执）。
    //
    // 用 JOIN 形式的 UPDATE，而不是 `message_id IN (SELECT ... FROM message_receipts)`：
    // 后者会触发 MySQL 1093「不能在子查询里引用正在更新的表」。
    // `r.revealed_at` 直接取自被更新的同一行，语义更准确也更省一次查询。
    const params: any[] = [new Date(), userId, conversationId];
    let sql = `UPDATE message_receipts r
      JOIN messages m ON m.id = r.message_id
         SET r.is_read = 1, r.read_at = ?
       WHERE r.user_id = ?
         AND r.is_read = 0
         AND m.conversation_id = ?
         AND m.is_destroyed = 0
         AND m.is_encrypted = 0
         AND (m.burn_ttl_seconds IS NULL OR r.revealed_at IS NOT NULL)`;
    if (upToCreatedAt) {
      sql += ' AND m.created_at <= ?';
      params.push(upToCreatedAt);
    }
    const result = await this.dataSource.query(sql, params);
    const affected = Number(result?.affectedRows ?? 0);

    // 已读水位线：取「本次标记范围内」的最后一条消息（而不是会话最后一条，
    // 否则上界生效时会把水位线错误推进到未读消息上）
    const lastMsgQb = this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .where('m.conversation_id = :conversationId', { conversationId })
      .orderBy('m.created_at', 'DESC');
    if (upToCreatedAt) {
      lastMsgQb.andWhere('m.created_at <= :upToCreatedAt', { upToCreatedAt });
    }
    const lastMsg = await lastMsgQb.getOne();

    if (lastMsg) {
      await this.advanceLastRead(conversationId, userId, lastMsg.id);
    }

    // 实时推送：已读回执（仅当确实把新消息从「未读」翻成「已读」时才广播，
    // 避免用户每次打开聊天页都向会话其他成员发送无效事件）
    if (affected > 0) {
      const memberIds = await this.getMemberUserIds(conversationId);
      this.events.emitToUsers(WS_EVENTS.RECEIPT_READ, memberIds, {
        conversation_id: conversationId,
        user_id: userId,
        last_read_message_id: lastMsg ? lastMsg.id : null,
        read_at: new Date().toISOString(),
      });
    }
  }

  /**
   * 按消息 id 标记已读（V6.1，前端可视区域观察上报）。
   *
   * 与 `markAsRead` 的区别：那个是"≤ 某条全部置已读"，这个是"只动我明确列出的这几条"。
   * 语义（对齐 READ_UNREAD_API.md §2）：
   *  - 只改**当前用户**在这些消息上的回执；
   *  - 不属于该会话的 id 静默忽略（不报错）；已读的幂等跳过；
   *  - 只有真的发生「未读 → 已读」才广播 WS `receipt:read`；
   *  - 不可逆：任何路径都不会把 is_read 改回 0。
   */
  async markMessagesRead(
    conversationId: string,
    userId: string,
    messageIds: string[],
  ): Promise<{ marked: number; conversation_id: string }> {
    await this.assertMember(conversationId, userId);

    const conv = await this.dataSource
      .getRepository(Conversation)
      .findOne({ where: { id: conversationId }, select: ['id'] });
    if (!conv) throw new NotFoundException('会话不存在');

    const ids = [...new Set((messageIds || []).filter(Boolean))];
    if (ids.length === 0) throw new BadRequestException('message_ids 不能为空');
    if (ids.length > 200) throw new BadRequestException('单次最多标记 200 条');

    const qb = this.dataSource
      .getRepository(MessageReceipt)
      .createQueryBuilder()
      .update()
      .set({ is_read: true, read_at: new Date() })
      .where('user_id = :userId', { userId })
      .andWhere('is_read = :isRead', { isRead: false })
      .andWhere('message_id IN (:...ids)', { ids })
      .andWhere(
        'message_id IN (SELECT id FROM messages WHERE conversation_id = :conversationId AND is_destroyed = 0)',
        { conversationId },
      );
    const result = await qb.execute();
    const marked = result.affected ?? 0;

    if (marked > 0) {
      // 水位线推到本次标记里最新的那条（只增不减）
      const latestQb = this.dataSource
        .getRepository(Message)
        .createQueryBuilder('m')
        .select(['m.id', 'm.created_at'])
        .where('m.id IN (:...ids)', { ids })
        .andWhere('m.conversation_id = :conversationId', { conversationId })
        .orderBy('m.created_at', 'DESC')
        .limit(1);
      const latest = await latestQb.getOne();
      if (latest) await this.advanceLastRead(conversationId, userId, latest.id);

      const memberIds = await this.getMemberUserIds(conversationId);
      this.events.emitToUsers(WS_EVENTS.RECEIPT_READ, memberIds, {
        conversation_id: conversationId,
        user_id: userId,
        last_read_message_id: latest ? latest.id : null,
        read_at: new Date().toISOString(),
      });
    }

    return { marked, conversation_id: conversationId };
  }

  /**
   * 推进「已读水位线」（last_read_message_id），**只增不减**：
   * 只有当候选消息比当前水位线更新（或当前为空）时才更新。
   * 用一条带 JOIN 的 UPDATE 完成，避免读-改-写竞态。
   */
  private async advanceLastRead(
    conversationId: string,
    userId: string,
    candidateMessageId: string,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE conversation_members cm
         JOIN messages m_new ON m_new.id = ?
         LEFT JOIN messages m_old ON m_old.id = cm.last_read_message_id
          SET cm.last_read_message_id = ?
        WHERE cm.conversation_id = ?
          AND cm.user_id = ?
          AND (cm.last_read_message_id IS NULL
               OR m_old.created_at IS NULL
               OR m_new.created_at >= m_old.created_at)`,
      [candidateMessageId, candidateMessageId, conversationId, userId],
    );
  }

  /**
   * 消息回执：仅会话成员可见（修复旧版任意用户可查漏洞）；已焚毁消息不再提供回执。
   *
   * V6.9 合并：原 `GET /messages/:id/readers` 的「已读进度」能力已并入这里，该接口已删除。
   * - 每条回执额外带 `is_sender`，前端据此区分"我"与"对方"，
   *   并自行聚合出「3/4 已读」（`items.filter(r => !r.is_sender && r.is_read).length`）。
   * - 一次 LEFT JOIN 取回姓名，修掉原先「每个回执查一次 users」的 N+1
   *   （100 人群聊从 101 次 SQL 降到 2 次）。
   * - 返回结构保持**数组**（不加外层包装），老前端的 `asArray(resp)` 无需改动。
   */
  async getMessageReceipts(messageId: string, userId: string) {
    const msgRepo = this.dataSource.getRepository(Message);
    const message = await msgRepo.findOne({ where: { id: messageId } });
    if (!message || message.is_destroyed) throw new NotFoundException('消息不存在');

    await this.assertMember(message.conversation_id, userId);

    const qb = this.dataSource.getRepository(MessageReceipt).createQueryBuilder('r');
    qb.leftJoin(AppUser, 'u', 'u.id = r.user_id');
    qb.select([
      'r.id AS id',
      'r.message_id AS message_id',
      'r.user_id AS user_id',
      'r.is_read AS is_read',
      'r.read_at AS read_at',
      'r.revealed_at AS revealed_at',
      'r.burn_at AS burn_at',
    ]);
    qb.addSelect('u.display_name', 'display_name');
    qb.where('r.message_id = :messageId', { messageId });
    qb.orderBy('r.user_id', 'ASC');
    const rows = await qb.getRawMany<{
      id: string;
      message_id: string;
      user_id: string;
      is_read: number | string;
      read_at: Date | string | null;
      revealed_at: Date | string | null;
      burn_at: Date | string | null;
      display_name: string | null;
    }>();

    return rows.map((r) => ({
      id: r.id,
      message_id: r.message_id,
      user_id: r.user_id,
      user_display_name: r.display_name || 'Unknown',
      // V6.9 新增：标出哪条是发送者自己（原 /readers 的能力）
      is_sender: r.user_id === message.sender_id,
      is_read: !!Number(r.is_read),
      read_at: r.read_at ?? null,
      revealed_at: r.revealed_at ?? null,
      burn_at: r.burn_at ?? null,
    }));
  }

  /**
   * 补传原图地址（v5.8.7 双上传策略）：
   * 前端先发压缩版消息（file_url，聊天流秒开），原图上传完成后再回填 file_original_url。
   * 约束：① 仅发送者本人可补；② 仅允许从 NULL 补填一次（防止覆盖/篡改已回填的原图）；
   * ③ 不允许补到已撤回/已焚毁的消息上。返回更新后的完整消息。
   */
  async updateOriginalFile(messageId: string, userId: string, fileOriginalUrl: string): Promise<Message> {
    const repo = this.dataSource.getRepository(Message);
    const msg = await repo.findOne({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('消息不存在');
    if (msg.sender_id !== userId) throw new ForbiddenException('仅发送者本人可补传原图');
    if (msg.is_recalled || msg.is_destroyed) throw new BadRequestException('消息已撤回或已焚毁，不能补传原图');
    if (msg.file_original_url) throw new BadRequestException('原图已存在，不能重复补传');
    await repo.update({ id: messageId }, { file_original_url: fileOriginalUrl });
    return repo.findOne({ where: { id: messageId } });
  }

  /**
   * 按关键字搜索会话内历史消息。
   * ① 仅会话成员可访问；
   * ② E2EE 加密消息后端无法解密（密文存 cipher_text，content 只是占位符）—— 仅搜明文消息 is_encrypted=false；
   * ③ 与 listMessages 一样过滤已销毁 + 到期未销毁 的消息。
   * keyword 必填，前后 trim；用 content LIKE 模糊匹配，命中按 created_at 倒序再翻转为正序。
   */
  async searchMessages(params: {
    conversationId: string;
    userId: string;
    keyword: string;
    before?: string;
    limit?: number;
  }): Promise<Message[]> {
    const keyword = (params.keyword ?? '').trim();
    if (!keyword) {
      throw new BadRequestException('keyword 不能为空');
    }
    if (keyword.length > 100) {
      throw new BadRequestException('关键字过长（最长 100 字符）');
    }
    await this.assertMember(params.conversationId, params.userId);

    // 限制单次返回数量上限为 200，防止恶意传大 limit 导致内存爆掉
    const limit = Math.min(params.limit || 50, 200);
    const qb = this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .where('m.conversation_id = :conversationId', { conversationId: params.conversationId })
      .andWhere('m.is_destroyed = :isDestroyed', { isDestroyed: false })
      .andWhere('(m.destroy_at IS NULL OR m.destroy_at > :now)', { now: new Date() })
      // E2EE：加密消息后端无法解密，仅搜明文
      .andWhere('m.is_encrypted = :isEncrypted', { isEncrypted: false })
      // 点开才焚：焚毁消息未点开前内容是受保护的，不参与搜索（防止搜索泄露马赛克内容）
      .andWhere('m.burn_ttl_seconds IS NULL')
      .andWhere('m.content LIKE :kw', { kw: `%${keyword}%` })
      .orderBy('m.created_at', 'DESC')
      .take(limit);

    if (params.before) {
      // 校验 before 必须是合法日期字符串（UUID 不行，ISO 日期才行）
      // 接受 ISO8601 字符串或时间戳（毫秒）
      let beforeDate: Date;
      if (/^\d{10,13}$/.test(params.before)) {
        beforeDate = new Date(Number(params.before));
      } else {
        beforeDate = new Date(params.before);
      }
      if (isNaN(beforeDate.getTime())) {
        throw new BadRequestException('before 参数格式错误，应为 ISO8601 日期或毫秒时间戳');
      }
      qb.andWhere('m.created_at < :before', { before: beforeDate });
    }

    const messages = await qb.getMany();
    return messages.reverse();
  }

  /**
   * 全局消息搜索（v5.8.5，GET /messages/search）：
   * - 范围：我所在的全部会话 —— INNER JOIN conversation_members 在 SQL 层焊死权限，杜绝跨会话泄露；
   *         传 conversationId 时先 assertMember 校验（非成员 403，与老会话内搜索接口行为一致）
   * - 引擎：MySQL FULLTEXT（ft_messages_search(content, file_name) WITH PARSER ngram）；
   *         MATCH 列清单必须与索引列完全一致才能命中索引
   * - 过滤（与老 searchMessages 语义对齐并加固）：
   *         加密消息（content 只是「[加密消息]」占位，密文在 cipher_text，服务端无明文）、
   *         已焚毁（is_destroyed / destroy_at）、点开才焚（burn_ttl_seconds，防止搜索泄露受保护内容）、
   *         已撤回（is_recalled）
   * - 文本消息命中 content；图片/语音/视频/文件消息命中 file_name（2026-09-04 决策）
   * - keyword trim 后 2~64 字符（ngram 最小切 2 字，单字 400）；清洗 BOOLEAN MODE 操作符防语法错
   */
  async searchGlobal(params: {
    userId: string;
    keyword: string;
    conversationId?: string;
    page?: number;
    pageSize?: number;
    after?: string;
    before?: string;
  }): Promise<{
    list: Array<{
      id: string;
      conversation_id: string;
      sender_id: string;
      sender_name: string;
      content_snippet: string;
      type: string;
      is_encrypted: boolean;
      created_at: Date;
    }>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const keyword = (params.keyword ?? '').trim();
    if (keyword.length < 2) {
      throw new BadRequestException('关键词至少 2 个字符（中文按二元分词，单字无法命中）');
    }
    if (keyword.length > 64) {
      throw new BadRequestException('关键词过长（最长 64 字符）');
    }
    // BOOLEAN MODE 操作符清洗：+ - > < ( ) ~ * " @ 会被 MySQL 当语法解析，直接移除防 500
    const ftKeyword = keyword.replace(/[+\-><()~*"@]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!ftKeyword) {
      throw new BadRequestException('关键词包含非法字符');
    }
    const afterDate = parseDateParam('after', params.after);
    const beforeDate = parseDateParam('before', params.before);
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;

    if (params.conversationId) {
      await this.assertMember(params.conversationId, params.userId);
    }

    const buildQb = (mode: 'fulltext' | 'like') => {
      const qb = this.dataSource
        .getRepository(Message)
        .createQueryBuilder('m')
        .select('m.id', 'id')
        .addSelect('m.conversation_id', 'conversation_id')
        .addSelect('m.sender_id', 'sender_id')
        .addSelect('m.type', 'type')
        .addSelect('m.content', 'content')
        .addSelect('m.file_name', 'file_name')
        .addSelect('m.created_at', 'created_at')
        .addSelect('u.display_name', 'sender_name')
        .innerJoin(
          ConversationMember,
          'cm',
          'cm.conversation_id = m.conversation_id AND cm.user_id = :uid',
          { uid: params.userId },
        )
        .leftJoin(AppUser, 'u', 'u.id = m.sender_id')
        .andWhere('m.is_encrypted = :isEncrypted', { isEncrypted: false })
        .andWhere('m.is_destroyed = :isDestroyed', { isDestroyed: false })
        .andWhere('(m.destroy_at IS NULL OR m.destroy_at > :now)', { now: new Date() })
        .andWhere('m.is_recalled = :isRecalled', { isRecalled: false })
        .andWhere('m.burn_ttl_seconds IS NULL')
        .orderBy('m.created_at', 'DESC')
        .skip((page - 1) * pageSize)
        .take(pageSize);

      if (mode === 'fulltext') {
        qb.where('MATCH(m.content, m.file_name) AGAINST (:kw IN BOOLEAN MODE)', { kw: ftKeyword });
      } else {
        // 降级：索引缺失时用 LIKE 兜底（慢，但不会 500）。
        // 转义 % _ \ 三个有特殊含义的字符，避免关键词被当成通配符。
        const escaped = keyword.replace(/[\\%_]/g, (c) => `\\${c}`);
        qb.where('(m.content LIKE :likeKw OR m.file_name LIKE :likeKw)', {
          likeKw: `%${escaped}%`,
        });
      }

      if (params.conversationId) {
        qb.andWhere('m.conversation_id = :cid', { cid: params.conversationId });
      }
      if (afterDate) {
        qb.andWhere('m.created_at > :after', { after: afterDate });
      }
      if (beforeDate) {
        qb.andWhere('m.created_at < :before', { before: beforeDate });
      }
      return qb;
    };

    // raw 拿列表（带别名列），getCount 单独算总数（COUNT 天然忽略 LIMIT/OFFSET）
    let qb = buildQb('fulltext');
    let rows: any[];
    let total: number;
    try {
      rows = await qb.getRawMany();
      total = await qb.getCount();
    } catch (err: any) {
      // 1191 = ER_CANT_FIND_FULLTEXT_INDEX_MATCHING_THE_COLUMN_LIST
      // 线上若漏跑 FULLTEXT 迁移（历史遗留的"手工执行"脚本），这里降级而不是 500
      if (!MessageService.isFulltextIndexMissing(err)) throw err;
      this.logger.warn(
        'FULLTEXT 索引 ft_messages_search 不存在，搜索降级为 LIKE（请执行 npm run migration:run）',
      );
      qb = buildQb('like');
      rows = await qb.getRawMany();
      total = await qb.getCount();
    }

    const list = rows.map((r: any) => {
      // 文本消息用 content 生成摘要；媒体消息（图/语音/视频/文件）用 file_name
      const source = (r.type === 'text' && r.content) || r.file_name || r.content || '';
      return {
        id: r.id,
        conversation_id: r.conversation_id,
        sender_id: r.sender_id,
        sender_name: r.sender_name || 'Unknown',
        content_snippet: buildSnippet(source, keyword),
        type: r.type,
        is_encrypted: false,
        created_at: r.created_at,
      };
    });
    return { list, total, page, pageSize };
  }

  /** 判断错误是否 = MySQL 1191「找不到与 MATCH 列清单匹配的 FULLTEXT 索引」 */
  private static isFulltextIndexMissing(err: any): boolean {
    const code = Number(err?.errno ?? err?.code ?? err?.driverError?.errno ?? 0);
    if (code === 1191) return true;
    const msg = String(err?.message ?? '');
    return /Can't find FULLTEXT index/i.test(msg) || /ER_CANT_FIND_FULLTEXT_INDEX/i.test(msg);
  }
}

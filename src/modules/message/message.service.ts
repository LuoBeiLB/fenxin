import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { AppUser } from '../../entities/app-user.entity';
import { EventsGateway } from '../events/events.gateway';
import { OssService } from '../upload/oss.service';
import { WS_EVENTS } from '../events/events.types';

/** 兜底强制焚毁时长（毫秒）：env BURN_FALLBACK_TTL_HOURS，默认 24 小时 */
function burnFallbackTtlMs(): number {
  const hours = parseInt(process.env.BURN_FALLBACK_TTL_HOURS || '24', 10);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600 * 1000;
}

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
  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
    private readonly oss: OssService,
  ) {}

  private async assertMember(conversationId: string, userId: string) {
    const membership = await this.dataSource.getRepository(ConversationMember).findOne({
      where: { conversation_id: conversationId, user_id: userId },
    });
    if (!membership) throw new ForbiddenException('Access denied to this conversation');
    return membership;
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
        // 点开才焚 v2：burn_ttl_seconds 非空 = 焚毁消息；
        // destroy_at 语义为兜底强制焚毁时间（env BURN_FALLBACK_TTL_HOURS，默认 24h），防止有人一直不点开导致消息永久留存
        burn_ttl_seconds: params.burnTtlSeconds ?? null,
        destroy_at: params.burnTtlSeconds ? new Date(Date.now() + burnFallbackTtlMs()) : null,
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
          is_delivered: false,
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
        remain_seconds: Math.max(0, Math.ceil((new Date(r.burn_at!).getTime() - now) / 1000)),
      });
    }
    return result;
  }

  async listMessages(params: {
    conversationId: string;
    userId: string;
    before?: string;
    limit?: number;
  }): Promise<unknown[]> {
    await this.assertMember(params.conversationId, params.userId);

    const limit = params.limit || 50;
    const qb = this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .where('m.conversation_id = :conversationId', { conversationId: params.conversationId })
      .andWhere('m.is_destroyed = :isDestroyed', { isDestroyed: false })
      // 阅后即焚兜底：到期消息即使定时任务尚未执行也不返回
      .andWhere('(m.destroy_at IS NULL OR m.destroy_at > :now)', { now: new Date() })
      .orderBy('m.created_at', 'DESC')
      .take(limit);

    if (params.before) {
      qb.andWhere('m.created_at < :before', { before: new Date(params.before) });
    }

    const messages = await qb.getMany();
    // 点开才焚：按当前用户 receipt 状态过滤/马赛克化
    return this.applyBurnView(messages.reverse(), params.userId);
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
          is_delivered: true,
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
      remain_seconds: Math.max(
        0,
        Math.ceil((new Date(receipt.burn_at!).getTime() - now.getTime()) / 1000),
      ),
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
    if (!message) throw new NotFoundException('消息不存在');
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
    if (!message) throw new NotFoundException('消息不存在');
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
  async markAsRead(conversationId: string, userId: string): Promise<void> {
    await this.assertMember(conversationId, userId);

    const result = await this.dataSource
      .getRepository(MessageReceipt)
      .createQueryBuilder()
      .update()
      .set({ is_read: true, read_at: new Date() })
      .where('user_id = :userId', { userId })
      .andWhere('is_read = :isRead', { isRead: false })
      .andWhere('message_id IN (SELECT id FROM messages WHERE conversation_id = :conversationId)', {
        conversationId,
      })
      .execute();

    const lastMsg = await this.dataSource.getRepository(Message).findOne({
      where: { conversation_id: conversationId },
      order: { created_at: 'DESC' },
    });

    if (lastMsg) {
      await this.dataSource.getRepository(ConversationMember).update(
        { conversation_id: conversationId, user_id: userId },
        { last_read_message_id: lastMsg.id },
      );
    }

    // 实时推送：已读回执（仅当确实把新消息从「未读」翻成「已读」时才广播，
    // 避免用户每次打开聊天页都向会话其他成员发送无效事件）
    if ((result.affected ?? 0) > 0) {
      const memberIds = await this.getMemberUserIds(conversationId);
      this.events.emitToUsers(WS_EVENTS.RECEIPT_READ, memberIds, {
        conversation_id: conversationId,
        user_id: userId,
        last_read_message_id: lastMsg ? lastMsg.id : null,
        read_at: new Date().toISOString(),
      });
    }
  }

  /** 消息回执：仅会话成员可见（修复旧版任意用户可查漏洞） */
  async getMessageReceipts(messageId: string, userId: string) {
    const msgRepo = this.dataSource.getRepository(Message);
    const message = await msgRepo.findOne({ where: { id: messageId } });
    if (!message) throw new NotFoundException('消息不存在');

    await this.assertMember(message.conversation_id, userId);

    const receipts = await this.dataSource.getRepository(MessageReceipt).find({
      where: { message_id: messageId },
    });

    const userRepo = await this.dataSource.getRepository(AppUser);
    return Promise.all(
      receipts.map(async (receipt) => {
        const user = await userRepo.findOne({ where: { id: receipt.user_id } });
        return { ...receipt, user_display_name: user?.display_name || 'Unknown' };
      }),
    );
  }

  /** 销毁单条消息：删回执 + 断开引用 + 整行删除 + 删磁盘附件（与 BurnScheduler 语义一致） */
  async destroyMessage(messageId: string): Promise<void> {
    const msg = await this.dataSource.getRepository(Message).findOne({ where: { id: messageId } });
    if (!msg) return;
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(MessageReceipt).delete({ message_id: messageId });
      await em.getRepository(Message).update({ reply_to_id: messageId }, { reply_to_id: null });
      await em.getRepository(Message).delete({ id: messageId });
    });
    // v5.8.7：压缩版 + 原图（如有）一并删除，避免原图成为焚毁残留
    const urls = [msg.file_url, msg.file_original_url].filter(Boolean);
    if (urls.length) {
      const fs = require('fs');
      const path = require('path');
      const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
      for (const u of urls) {
        try {
          fs.unlinkSync(path.join(uploadDir, path.basename(u)));
        } catch {
          // 文件可能已不存在，不影响销毁
        }
        // v5.9.0 OSS 外置：完整 http(s) URL 的附件（OSS 签名地址）同步删 OSS 对象，避免焚毁残留
        if (/^https?:/.test(u)) await this.oss.deleteByUrl(u);
      }
    }
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
      .where('MATCH(m.content, m.file_name) AGAINST (:kw IN BOOLEAN MODE)', { kw: ftKeyword })
      .andWhere('m.is_encrypted = :isEncrypted', { isEncrypted: false })
      .andWhere('m.is_destroyed = :isDestroyed', { isDestroyed: false })
      .andWhere('(m.destroy_at IS NULL OR m.destroy_at > :now)', { now: new Date() })
      .andWhere('m.is_recalled = :isRecalled', { isRecalled: false })
      .andWhere('m.burn_ttl_seconds IS NULL')
      .orderBy('m.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (params.conversationId) {
      qb.andWhere('m.conversation_id = :cid', { cid: params.conversationId });
    }
    if (afterDate) {
      qb.andWhere('m.created_at > :after', { after: afterDate });
    }
    if (beforeDate) {
      qb.andWhere('m.created_at < :before', { before: beforeDate });
    }

    // raw 拿列表（带别名列），getCount 单独算总数（COUNT 天然忽略 LIMIT/OFFSET）
    const rows = await qb.getRawMany();
    const total = await qb.getCount();

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
}

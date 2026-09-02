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
import { WS_EVENTS } from '../events/events.types';

/** 兜底强制焚毁时长（毫秒）：env BURN_FALLBACK_TTL_HOURS，默认 24 小时 */
function burnFallbackTtlMs(): number {
  const hours = parseInt(process.env.BURN_FALLBACK_TTL_HOURS || '24', 10);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600 * 1000;
}

@Injectable()
export class MessageService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
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

    await this.assertMember(params.conversationId, params.senderId);

    const conv = await convRepo.findOne({ where: { id: params.conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    if (conv.dissolved_at) throw new ForbiddenException('群组已解散，不能再发送消息');

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
   */
  async revealMessage(messageId: string, userId: string) {
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
      const burnAt = new Date(now.getTime() + msg.burn_ttl_seconds * 1000);
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

    const userRepo = this.dataSource.getRepository(AppUser);
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
    if (msg.file_url) {
      const fs = require('fs');
      const path = require('path');
      const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
      try {
        fs.unlinkSync(path.join(uploadDir, path.basename(msg.file_url)));
      } catch {
        // 文件可能已不存在，不影响销毁
      }
    }
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
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Message } from '../../entities/message.entity';
import { MessageReceipt } from '../../entities/message-receipt.entity';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { AppUser } from '../../entities/app-user.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';

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
    destroyAt?: string;
    senderEphemeralPubkey?: string;
    cipherNonce?: string;
    cipherText?: string;
  }): Promise<Message> {
    const msgRepo = this.dataSource.getRepository(Message);
    const convRepo = this.dataSource.getRepository(Conversation);
    const memberRepo = this.dataSource.getRepository(ConversationMember);
    const receiptRepo = this.dataSource.getRepository(MessageReceipt);

    await this.assertMember(params.conversationId, params.senderId);

    const conv = await convRepo.findOne({ where: { id: params.conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    if (conv.dissolved_at) throw new ForbiddenException('群组已解散，不能再发送消息');

    if (params.type === 'text' && !params.content) {
      throw new BadRequestException('文本消息 content 不能为空');
    }
    if (params.type !== 'text' && !params.fileUrl) {
      throw new BadRequestException(`${params.type} 消息 file_url 不能为空`);
    }

    // E2E：三个加密字段必须同时提供（全密文）或同时缺省（明文），不允许半加密状态
    const encFields = [params.senderEphemeralPubkey, params.cipherNonce, params.cipherText];
    const isEncrypted = encFields.every((f) => f !== undefined && f !== null && f !== '');
    if (!isEncrypted && encFields.some((f) => f !== undefined && f !== null && f !== '')) {
      throw new BadRequestException(
        '加密字段不完整：sender_ephemeral_pubkey / cipher_nonce / cipher_text 必须同时提供',
      );
    }

    const savedMsg = await msgRepo.save(
      msgRepo.create({
        conversation_id: params.conversationId,
        sender_id: params.senderId,
        type: params.type as Message['type'],
        content: params.content ?? null,
        file_url: params.fileUrl ?? null,
        file_name: params.fileName ?? null,
        file_size: params.fileSize ?? null,
        reply_to_id: params.replyToId ?? null,
        destroy_at: params.destroyAt ? new Date(params.destroyAt) : null,
        // E2E 加密字段（明文消息全为 null / false）
        is_encrypted: isEncrypted,
        cipher_nonce: isEncrypted ? params.cipherNonce! : null,
        cipher_text: isEncrypted ? params.cipherText! : null,
        sender_ephemeral_pubkey: isEncrypted ? params.senderEphemeralPubkey! : null,
      }),
    );

    await convRepo.update(params.conversationId, { last_message_at: new Date() });

    const members = await memberRepo.find({ where: { conversation_id: params.conversationId } });
    const otherMembers = members.filter((m) => m.user_id !== params.senderId);
    if (otherMembers.length > 0) {
      await receiptRepo.save(
        otherMembers.map((m) =>
          receiptRepo.create({
            message_id: savedMsg.id,
            user_id: m.user_id,
            is_delivered: false,
            is_read: false,
          }),
        ),
      );
    }

    // 实时推送：新消息 + 会话列表刷新信号（推给全体成员，含发送者的其他在线设备）
    const memberIds = members.map((m) => m.user_id);
    this.events.emitToUsers(WS_EVENTS.MESSAGE_NEW, memberIds, {
      conversation_id: params.conversationId,
      message: savedMsg,
    });
    this.events.emitToUsers(WS_EVENTS.CONVERSATION_UPDATED, memberIds, {
      conversation_id: params.conversationId,
      reason: 'message',
    });

    return savedMsg;
  }

  async listMessages(params: {
    conversationId: string;
    userId: string;
    before?: string;
    limit?: number;
  }): Promise<Message[]> {
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
    return messages.reverse();
  }

  async editMessage(messageId: string, userId: string, newContent: string): Promise<Message> {
    const msgRepo = this.dataSource.getRepository(Message);
    const message = await msgRepo.findOne({ where: { id: messageId } });
    if (!message) throw new NotFoundException('消息不存在');
    if (message.sender_id !== userId) throw new ForbiddenException('You can only edit your own messages');
    if (message.is_recalled) throw new BadRequestException('Cannot edit a recalled message');

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

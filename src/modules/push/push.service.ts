import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { Device } from '../../entities/device.entity';
import { Message } from '../../entities/message.entity';
import { AppUser } from '../../entities/app-user.entity';
import { Conversation } from '../../entities/conversation.entity';
import { JpushProvider } from './jpush.provider';

/**
 * 离线推送编排（V6.2）。
 *
 * 职责边界：
 *  - 决定**推给谁**：排除发送者本人；只推当前离线的成员（在线已被 WS 覆盖）；
 *  - 决定**推什么**：按消息类型脱敏（焚毁 / 加密消息绝不带正文）；
 *  - 决定**失败怎么办**：吞掉异常只记日志，绝不影响发消息。
 *
 * 内容脱敏是红线：通知会显示在锁屏、会经过极光服务器，
 * 焚毁消息一旦把正文放进通知，阅后即焚等于失效。
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger('Push');

  /** 推送正文的文本截断长度 */
  private static readonly SNIPPET = 30;

  constructor(
    private readonly dataSource: DataSource,
    private readonly jpush: JpushProvider,
  ) {}

  /**
   * 启动时打印推送配置状态。
   *
   * 为什么需要：排查「为什么没推」时，第一件事就是确认运行中的进程到底有没有
   * 读到 `JPUSH_ENABLED` / 密钥。以前只能靠猜（改 .env 不重启、容器没注入 env
   * 都表现为"静默不推"）。这里启动即见，且**不打印任何密钥值**。
   */
  onModuleInit(): void {
    // 日志正文用**纯 ASCII**：生产日志会经过 docker / pm2 / 面板 / ELK 等下游，
    // 只要有一个按 GBK(936) 解码，中文就会变成「鎺ㄩ€佸凡鍚敤」这种乱码。
    // 注释保留中文，日志正文保持英文，任何终端都不会花。
    if (this.jpush.enabled) {
      this.logger.log(
        `push enabled: channel=${process.env.JPUSH_CHANNEL_ID || 'messages'} ` +
          `small_icon=${process.env.JPUSH_SMALL_ICON || '(unset)'} ` +
          `ttl=${process.env.JPUSH_TTL_SECONDS || '3600'}s ` +
          `endpoint=${process.env.JPUSH_ENDPOINT || 'api.jpush.cn'}`,
      );
      return;
    }

    // 关闭时把「缺哪一项」说清楚，避免误以为代码没跑
    const missing: string[] = [];
    if (process.env.JPUSH_ENABLED !== 'true') missing.push('JPUSH_ENABLED!=true');
    if (!process.env.JPUSH_APP_KEY) missing.push('JPUSH_APP_KEY empty');
    if (!process.env.JPUSH_MASTER_SECRET) missing.push('JPUSH_MASTER_SECRET empty');
    this.logger.warn(`push disabled (no push will be sent): ${missing.join(' / ')}`);
  }

  /**
   * 新消息推送入口（`MessageService.sendMessage` 末尾调用，**不 await**）。
   * 内部已做全量兜底，不会抛出。
   */
  async notifyNewMessage(params: {
    message: Message;
    memberIds: string[];
    senderId: string;
  }): Promise<void> {
    try {
      if (!this.jpush.enabled) return;

      const { message, memberIds, senderId } = params;
      // 不推给自己（自己的其他设备由 WS 覆盖）
      const candidates = (memberIds || []).filter((id) => id !== senderId);
      if (candidates.length === 0) return;

      const offline = await this.pickOffline(candidates);
      if (offline.length === 0) return;

      const content = await this.buildContent(message);
      if (!content) return;

      await this.jpush.pushToUsers(offline, {
        title: content.title,
        alert: content.alert,
        conversationId: message.conversation_id,
        extra: { message_id: message.id, type: message.type },
      });
    } catch (err: any) {
      this.logger.error(`notifyNewMessage failed: ${err?.message || err}`);
    }
  }

  /**
   * 离线判定：`devices.is_online = 1` 即在线（由 WS 连接数 + 心跳维护，见 ONLINE_PRESENCE.md）。
   * 没有任何设备记录的用户按离线处理（可能是从没登录过，推了也没用，但不会报错）。
   */
  private async pickOffline(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];

    const qb: SelectQueryBuilder<Device> = this.dataSource
      .getRepository(Device)
      .createQueryBuilder('d');
    qb.select('DISTINCT d.user_id', 'user_id');
    qb.where('d.user_id IN (:...userIds)', { userIds });
    qb.andWhere('d.is_online = 1');
    const rows = await qb.getRawMany<{ user_id: string }>();

    const online = new Set(rows.map((r) => r.user_id));
    return userIds.filter((id) => !online.has(id));
  }

  /**
   * 生成推送文案（脱敏规则见 docs/PUSH_JPUSH.md §6）：
   *  - 焚毁消息 → 「你有一条阅后即焚消息」
   *  - 加密消息 → 「你有一条加密消息」
   *  - 附件类   → 「[图片] 张三」等
   *  - 文本     → 「张三：前 30 字」
   */
  private async buildContent(
    message: Message,
  ): Promise<{ title: string; alert: string } | null> {
    const convQb: SelectQueryBuilder<Conversation> = this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c');
    convQb.select('c.name', 'name');
    convQb.where('c.id = :cid', { cid: message.conversation_id });
    const conv = await convQb.getRawOne<{ name: string | null }>();

    const senderQb: SelectQueryBuilder<AppUser> = this.dataSource
      .getRepository(AppUser)
      .createQueryBuilder('u');
    senderQb.select('u.display_name', 'display_name');
    senderQb.where('u.id = :uid', { uid: message.sender_id });
    const sender = await senderQb.getRawOne<{ display_name: string | null }>();

    const title = conv?.name || sender?.display_name || '焚信';
    const name = sender?.display_name || '对方';

    // 红线：焚毁 / 加密消息不带任何内容
    if (message.burn_ttl_seconds != null) {
      return { title, alert: '你有一条阅后即焚消息' };
    }
    if (message.is_encrypted) {
      return { title, alert: '你有一条加密消息' };
    }

    switch (message.type) {
      case 'image':
        return { title, alert: `[图片] ${name}` };
      case 'voice':
        return { title, alert: `[语音] ${name}` };
      case 'video':
        return { title, alert: `[视频] ${name}` };
      case 'file':
        return { title, alert: `[文件] ${name}` };
      default:
        return {
          title,
          alert: `${name}：${(message.content ?? '').slice(0, PushService.SNIPPET)}`,
        };
    }
  }
}

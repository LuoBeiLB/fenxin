import { Injectable, Logger } from '@nestjs/common';

/** 推送内容（已由调用方脱敏，provider 不再做任何内容加工） */
export interface PushPayload {
  title: string;
  alert: string;
  conversationId: string;
  extra?: Record<string, string>;
}

/**
 * 极光推送提供方（REST 直连，不依赖任何 SDK）。
 *
 * 为什么不用 SDK：
 *  - 只是「一个带 Basic Auth 的 POST」，自己写更能看清 payload 结构，也少一个依赖；
 *  - 出问题直接看日志里的原始响应体，不用猜 SDK 封装了什么。
 *
 * 投递方式：`audience.alias = [userId]`（见 docs/PUSH_JPUSH.md 附录 A），
 * 因此**不需要**维护 registration_id 表；alias 由 APK 登录时 `setAlias(userId)` 绑定。
 *
 * 开关：`JPUSH_ENABLED=true` 且 AppKey / MasterSecret 都存在时才真发；
 * 否则直接返回 false（本地开发、灰度期都不会误推）。
 */
@Injectable()
export class JpushProvider {
  private readonly logger = new Logger('JPush');

  /**
   * 极光推送地址。支持 `JPUSH_ENDPOINT` 覆盖，用途：
   *  - 本地端到端测试（指向 mock 服务，验证 payload）；
   *  - 需要走公司正向代理 / 私有网关时。
   */
  private get endpoint(): string {
    return process.env.JPUSH_ENDPOINT || 'https://api.jpush.cn/v3/push';
  }

  /** 是否真正具备发送条件 */
  get enabled(): boolean {
    return (
      process.env.JPUSH_ENABLED === 'true' &&
      !!process.env.JPUSH_APP_KEY &&
      !!process.env.JPUSH_MASTER_SECRET
    );
  }

  private get channelId(): string {
    return process.env.JPUSH_CHANNEL_ID || 'messages';
  }

  /** 小图标名（APK 的 drawable 资源名）；留空则不传，用极光默认 */
  private get smallIcon(): string {
    return process.env.JPUSH_SMALL_ICON || '';
  }

  /** 离线消息保留时长（秒）：超时后不再打扰 */
  private get ttlSeconds(): number {
    const n = parseInt(process.env.JPUSH_TTL_SECONDS || '3600', 10);
    return Number.isFinite(n) && n > 0 ? n : 3600;
  }

  /**
   * 推给一组 userId（极光侧 alias）。
   * **永不抛错**：推送失败只记日志，绝不能影响发消息主流程。
   */
  async pushToUsers(userIds: string[], msg: PushPayload): Promise<boolean> {
    if (!this.enabled) return false;
    if (!userIds || userIds.length === 0) return false;

    const body = {
      platform: ['android'],
      audience: { alias: userIds },
      notification: {
        android: {
          alert: msg.alert,
          title: msg.title,
          // 必须与 APK 里创建的 NotificationChannel id 一致，否则 Android 8+ 不显示
          channel_id: this.channelId,
          // 可选：白色剪影小图标名（APK 的 res/drawable 里存在才有效）。
          // 不配则用极光默认图标（彩色图标在 Android 8+ 会渲染成方块）。
          ...(this.smallIcon ? { small_icon: this.smallIcon } : {}),
          extras: { conversation_id: msg.conversationId, ...(msg.extra ?? {}) },
        },
      },
      options: { time_to_live: this.ttlSeconds },
    };

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${process.env.JPUSH_APP_KEY}:${process.env.JPUSH_MASTER_SECRET}`).toString(
              'base64',
            ),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        this.logger.warn(`push failed status=${res.status} body=${text}`);
        return false;
      }
      // 只记数量与 msg_id，不记 alert 正文（可能是消息内容）
      this.logger.log(`push ok users=${userIds.length} resp=${text}`);
      return true;
    } catch (err: any) {
      this.logger.error(`push error: ${err?.message || err}`);
      return false;
    }
  }
}

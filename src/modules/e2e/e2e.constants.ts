/**
 * 设备配对私密会话（Secret Chat）的共享常量。
 *
 * 放在独立文件是为了让 conversation / message / e2e 三个模块共用同一套定义，
 * 避免"服务端 7 天，列表里算出 3 天"这种不一致。
 */

/** 私有会话状态（对应 conversations.e2e_state） */
export const E2E_STATE = {
  /** 非私密会话 */
  NONE: 0,
  /** 待接受（双方所有设备可见，作为"请求"） */
  PENDING: 1,
  /** 已激活（仅两台绑定设备可见） */
  ACTIVE: 2,
} as const;

/** pending 请求有效期（天）：超时由定时任务直接删除该行 */
export const PENDING_TTL_DAYS = 7;

/** pending 会话的过期时间（用于前端显示"剩余 N 天"与角标） */
export function pendingExpiresAt(createdAt: Date | string): Date {
  return new Date(new Date(createdAt).getTime() + PENDING_TTL_DAYS * 24 * 3600 * 1000);
}

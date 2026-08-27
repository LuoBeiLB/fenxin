import { Message } from '../../entities/message.entity';

/**
 * 服务端 → 客户端的 WebSocket 事件名。
 * 与前端 fenxin-app/src/services/ws.ts 中的 WS_EVENTS 保持一致，勿单独改动一侧。
 */
export const WS_EVENTS = {
  /** 新消息（含完整消息体） */
  MESSAGE_NEW: 'message:new',
  /** 消息被编辑（含编辑后的完整消息体） */
  MESSAGE_EDITED: 'message:edited',
  /** 消息被撤回 */
  MESSAGE_RECALLED: 'message:recalled',
  /** 已读回执（谁读到了哪条消息） */
  RECEIPT_READ: 'receipt:read',
  /** 会话列表刷新信号（新建会话 / last_message_at 变化 / 成员变动） */
  CONVERSATION_UPDATED: 'conversation:updated',
} as const;

export type WsServerEvent = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];

/** message:new / message:edited 的 payload */
export interface WsMessagePayload {
  /** 事件所属会话，前端据此判断是否是当前打开的聊天页 */
  conversation_id: string;
  /** 完整消息实体（JSON 序列化后 Date 字段变为 ISO8601 字符串） */
  message: Message;
}

/** message:recalled 的 payload */
export interface WsMessageRecalledPayload {
  conversation_id: string;
  message_id: string;
  /** 撤回时间（ISO8601） */
  recalled_at: string;
}

/** receipt:read 的 payload */
export interface WsReceiptReadPayload {
  conversation_id: string;
  /** 执行已读标记的用户 ID */
  user_id: string;
  /** 该用户读到的最新消息 ID（标记时刻会话内的最后一条消息） */
  last_read_message_id: string | null;
  /** 标记时间（ISO8601） */
  read_at: string;
}

/** conversation:updated 的 payload */
export interface WsConversationUpdatedPayload {
  conversation_id: string;
  /** 触发原因：message=新消息/last_message_at 更新；created=新建会话；members=成员变动；info=群资料变更 */
  reason: 'message' | 'created' | 'members' | 'info';
}

/** 事件名 → payload 类型映射，供 emitToUsers 做类型约束 */
export interface WsEventPayloadMap {
  'message:new': WsMessagePayload;
  'message:edited': WsMessagePayload;
  'message:recalled': WsMessageRecalledPayload;
  'receipt:read': WsReceiptReadPayload;
  'conversation:updated': WsConversationUpdatedPayload;
}

/** 每个用户专属的房间名：同一用户的所有在线设备（socket）都会加入该房间 */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

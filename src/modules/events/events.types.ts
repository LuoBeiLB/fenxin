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
  /** 紧急公告（priority=urgent 时实时弹窗推送；普通公告不发 WS，仅进公告中心） */
  ANNOUNCEMENT_NEW: 'announcement:new',
  /** 同账号新设备登录通知（推给该用户全部设备，payload 带新设备信息，客户端自行忽略本设备） */
  DEVICE_ADDED: 'device:added',
  /** 设备被下线通知 */
  DEVICE_REMOVED: 'device:removed',
  /** 身份公钥变更通知（TOFU）：某用户轮换了 identity 公钥，通知其共同会话用户重新比对本地缓存 */
  KEY_CHANGED: 'key:changed',
  /** App 新版本发布（V5.8 自更新）：管理员发布/恢复发布/切换强更时推给全部在线用户，客户端弹更新提示 */
  APP_UPDATE: 'app:update',
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
  /** 触发原因：message=新消息/last_message_at 更新；created=新建会话；members=成员变动；info=群资料变更；dissolved=群被解散；owner_changed=群主转让 */
  reason: 'message' | 'created' | 'members' | 'info' | 'dissolved' | 'owner_changed';
  /** 当 reason=owner_changed 时携带：新群主用户 ID（UUIDv4） */
  new_owner_id?: string;
}

/** announcement:new 的 payload（仅紧急公告） */
export interface WsAnnouncementNewPayload {
  id: string;
  title: string;
  content: string;
  priority: 'normal' | 'urgent';
  /** 发布时间（ISO8601） */
  created_at: string;
}

/** device:added 的 payload */
export interface WsDeviceAddedPayload {
  device_id: string;
  device_name: string;
  device_type: string;
  /** 登录时间（ISO8601） */
  logged_in_at: string;
  ip?: string;
}

/** device:removed 的 payload */
export interface WsDeviceRemovedPayload {
  device_id: string;
}

/**
 * key:changed 的 payload（TOFU 支撑）。
 * 只带 user_id + updated_at，不带公钥本体：客户端收到后自行 GET /keys/:userId
 * 与本地钉住的公钥比对，不一致才告警 —— 保证所有公钥都走同一条 TOFU 比对路径。
 */
export interface WsKeyChangedPayload {
  /** 轮换了公钥的用户 ID */
  user_id: string;
  /** 服务端记录的公钥更新时间（ISO8601） */
  updated_at: string;
}

/**
 * app:update 的 payload（V5.8 App 自更新）。
 * 版本判定用整数 version_code：客户端比自己的 versionCode 小才提示更新，
 * 不要用 version_name 字符串比较（"5.10" < "5.9" 的字符串比较是错的）。
 */
export interface WsAppUpdatePayload {
  /** 平台：android / ios（客户端按自己的平台过滤，另一平台的事件忽略） */
  platform: string;
  /** 新版本的 Android versionCode / iOS build number（整数） */
  version_code: number;
  /** 展示用版本名，如 "5.8" */
  version_name: string;
  /** APK 下载地址（相对路径 /uploads/app/xxx.apk，客户端拼 baseURL） */
  apk_url: string;
  /** APK 文件大小（字节） */
  file_size: number;
  /** 是否强制更新（true 时客户端弹窗不给"下次再说"） */
  force: boolean;
  /** 更新说明 */
  notes: string;
  /** 发布时间（ISO8601） */
  published_at: string;
}

/** 事件名 → payload 类型映射，供 emitToUsers 做类型约束 */
export interface WsEventPayloadMap {
  'message:new': WsMessagePayload;
  'message:edited': WsMessagePayload;
  'message:recalled': WsMessageRecalledPayload;
  'receipt:read': WsReceiptReadPayload;
  'conversation:updated': WsConversationUpdatedPayload;
  'announcement:new': WsAnnouncementNewPayload;
  'device:added': WsDeviceAddedPayload;
  'device:removed': WsDeviceRemovedPayload;
  'key:changed': WsKeyChangedPayload;
  'app:update': WsAppUpdatePayload;
}

/** 每个用户专属的房间名：同一用户的所有在线设备（socket）都会加入该房间 */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

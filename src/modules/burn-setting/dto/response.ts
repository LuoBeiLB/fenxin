/**
 * 焚毁时长设置的响应 DTO（出参类型）。
 */

/**
 * 生效来源：前端据此决定标签文案。
 *
 * 注意：归属规则是「发送方生效」——只看**我**对对方/本群的设置，
 * 对方对我的设置影响的是「对方发出的消息」，与这里无关，所以没有
 * counterpart_setting / both_min 这类来源。
 */
export type BurnTtlSource =
  | 'contact_setting' // 我对这个人单独设过（我发的消息按它焚毁）
  | 'conversation_setting' // 我对这个群单独设过
  | 'global_default' // 用我的全局默认
  | 'none'; // 都没设，不焚毁

/** 一条设置记录 */
export class BurnSettingView {
  ttl_seconds!: number;
  updated_at!: Date | string;
}

/** GET /burn-settings/conversations/:conversationId */
export class BurnSettingResolution {
  conversation_id!: string;
  conversation_type!: string;
  /** 私聊对方；群/频道为 null */
  counterpart!: { user_id: string; display_name: string | null } | null;
  /** 我发消息时应用的时长（秒）；null = 不焚毁 */
  effective_ttl_seconds!: number | null;
  source!: BurnTtlSource;
  /** 我对该对象设置的值（可能为 null） */
  my_setting!: BurnSettingView | null;
  /** 我的全局默认（用于 UI 显示"用的是默认设置"） */
  global_default_seconds!: number | null;
}

/** GET /burn-settings/users 的单行 */
export class BurnSettingListItem {
  target_user_id!: string;
  display_name!: string | null;
  avatar_url!: string | null;
  ttl_seconds!: number;
  updated_at!: Date | string;
}

/** GET /burn-settings/users 分页 */
export class BurnSettingList {
  total!: number;
  page!: number;
  pageSize!: number;
  data!: BurnSettingListItem[];
}

/** PUT / DELETE 的结果 */
export class BurnSettingWriteResult {
  success!: boolean;
  /** 写入后的生效时长；清除后为 null */
  ttl_seconds!: number | null;
  /** 被作用的对象：user_id 或 conversation_id */
  scope_id!: string;
  scope_type!: 'user' | 'conversation';
}

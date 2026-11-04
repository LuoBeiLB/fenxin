import { ApiProperty } from '@nestjs/swagger';

/** POST /conversations/e2e-request 的返回 */
export class SecretChatRequestResult {
  @ApiProperty({ description: '新建的私密会话 ID（pending 状态）' })
  conversation_id: string;

  @ApiProperty({ description: '会话状态：1=pending 2=active' })
  e2e_state: number;

  @ApiProperty({ description: '请求过期时间（ISO8601，默认 7 天）' })
  expires_at: Date;
}

/** POST /conversations/:id/e2e-accept 的返回 */
export class SecretChatAcceptResult {
  @ApiProperty({ description: '私密会话 ID' })
  conversation_id: string;

  @ApiProperty({ description: '会话状态（接受后固定为 2）' })
  e2e_state: number;

  @ApiProperty({ description: '本端绑定的设备 ID（接受者）' })
  bound_device_id: string;

  @ApiProperty({ description: '对方绑定的设备 ID（发起者）' })
  peer_device_id: string;
}

/** 关闭 / 撤回 的返回：服务端已物理删除，无任何残留 */
export class SecretChatMutationResult {
  @ApiProperty({ description: '私密会话 ID' })
  conversation_id: string;

  @ApiProperty({ description: '是否已删除（幂等调用时可能为 true 但消息数为 0）' })
  deleted: boolean;

  @ApiProperty({ description: '被删除的消息条数' })
  deleted_messages: number;
}

/**
 * B-1：跨设备列出「我名下」的私密会话（V6.2.1）。
 * 不依赖当前设备是否绑定，用于退出登录提示 / 新设备登录提示 / 锁面板。
 */
export class SecretChatMineView {
  @ApiProperty({ description: '私密会话 ID' })
  conversation_id: string;

  @ApiProperty({ description: '会话状态', enum: ['pending', 'active'] })
  state: 'pending' | 'active';

  @ApiProperty({ description: '对方用户 ID', nullable: true })
  peer_user_id: string | null;

  @ApiProperty({ description: '对方昵称', nullable: true })
  peer_name: string | null;

  @ApiProperty({ description: '我在这条会话上绑定的设备 ID（null=尚未绑定/已失去）', nullable: true })
  bound_device_id: string | null;

  @ApiProperty({ description: '绑定设备名称，如「电脑A」', nullable: true })
  bound_device_name: string | null;

  @ApiProperty({ description: '绑定设备当前是否在线', nullable: true })
  bound_device_online: boolean | null;

  @ApiProperty({ description: '绑定设备最后活跃时间（用于显示「已 3 天未上线」）', nullable: true })
  bound_device_last_seen_at: Date | null;

  @ApiProperty({ description: '绑定的设备是否就是本次请求的设备' })
  is_bound_device: boolean;

  @ApiProperty({ description: '对方绑定的设备 ID（active 才有）', nullable: true })
  peer_device_id: string | null;

  @ApiProperty({ description: '会话创建时间' })
  created_at: Date;

  @ApiProperty({ description: 'pending 请求的过期时间（active 为 null）', nullable: true })
  expires_at: string | null;

  @ApiProperty({ description: '本次查询时间（前端算「几天前」用，避免依赖本机时钟）' })
  as_of: string;
}

/** B-3：批量结束的返回 */
export class SecretChatCloseAllResult {
  @ApiProperty({ description: '实际结束的会话数' })
  closed: number;

  @ApiProperty({ description: '被结束的会话 ID 列表', type: [String] })
  conversation_ids: string[];

  @ApiProperty({ description: '合计删除的消息条数' })
  deleted_messages: number;
}

/** B-2：关闭原因（logout / device_change 由前端显式传入） */
export type CloseAllReason = 'user' | 'logout' | 'device_change';

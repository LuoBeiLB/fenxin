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

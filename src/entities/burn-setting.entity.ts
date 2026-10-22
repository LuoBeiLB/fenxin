import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  Unique,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 焚毁时长设置的作用域：按对方用户（私聊）/ 按会话（群、频道） */
export type BurnScopeType = 'user' | 'conversation';

/**
 * 焚毁时长设置（V6.1「按人设置」）。
 *
 * 语义：**owner 视角**下，对「某个对象」的默认焚毁时长。
 * - 私聊：scope_type='user'，scope_id=对方 user_id
 *   —— "我给张三设的开多久焚毁"
 * - 群/频道：scope_type='conversation'，scope_id=会话 id
 *   —— "我在这个群里希望开多久焚毁"（每个成员各自一份，互不影响）
 *
 * 关键约束：本表只决定**发送时的默认值**。真正生效的时长会快照进
 * `messages.burn_ttl_seconds`，因此改设置不会影响已发出的消息。
 */
@Entity('burn_settings')
@Unique('uk_burn_owner_scope', ['owner_id', 'scope_type', 'scope_id'])
export class BurnSetting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 设置者（视角）：谁设的，就只影响谁发出的消息 */
  @Index('idx_burn_owner')
  @Column({ length: 36 })
  owner_id: string;

  @Column({ length: 16 })
  scope_type: BurnScopeType;

  /** scope_type='user' 时为对方 user_id；='conversation' 时为 conversation_id */
  @Index('idx_burn_scope')
  @Column({ length: 36 })
  scope_id: string;

  /** 焚毁时长（秒），1 ~ 2592000（30 天） */
  @Column({ type: 'int' })
  ttl_seconds: number;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

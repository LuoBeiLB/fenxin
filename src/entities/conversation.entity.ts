import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type ConversationType = 'private' | 'group' | 'channel';

/** 频道可见性：public=进频道广场可自主订阅；private=不进广场（P1 支持邀请链接订阅） */
export type ChannelVisibility = 'public' | 'private';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_conversations_type')
  @Column({ length: 20 })
  type: ConversationType;

  @Column({ length: 200, nullable: true })
  name: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ length: 500, nullable: true })
  avatar_url: string | null;

  @Column({ length: 36, nullable: true })
  owner_id: string | null;

  @Column({ default: false })
  is_channel: boolean;

  /** 频道可见性（仅 type=channel 有意义）：public=广场可见可自主订阅；private=不进广场 */
  @Column({ length: 20, default: 'public' })
  visibility: ChannelVisibility;

  @Column({ type: 'int', default: 0 })
  member_count: number;

  @Column({ type: 'datetime', nullable: true })
  last_message_at: Date | null;

  /** 软解散标记（仅群聊）：非空表示群已被解散，成员不可再发消息，消息记录保留供审计 */
  @Index('idx_conversations_dissolved_at')
  @Column({ type: 'datetime', nullable: true })
  dissolved_at: Date | null;

  /** 执行解散操作的用户 ID（群主解散或管理员强制解散） */
  @Column({ length: 36, nullable: true })
  dissolved_by: string | null;

  /* ===== 设备配对私密会话（Secret Chat，V6.2）===== */

  /**
   * 0 = 普通会话（云端，所有成员设备可见）
   * 1 = 设备配对私密会话（仅两台绑定设备可见）
   */
  @Index('idx_e2e_state')
  @Column({ type: 'tinyint', default: 0 })
  e2e_mode: number;

  /**
   * 0 = 非私密
   * 1 = pending 待接受（双方所有设备可见，作为"请求"）
   * 2 = active 已激活（仅 e2e_device_a / e2e_device_b 可见）
   *
   * 注意：**终止动作是删除该行**，不存在 closed / rejected / expired 状态。
   */
  @Column({ type: 'tinyint', default: 0 })
  e2e_state: number;

  /** 参与者 1（固定取较小的 user_id，供唯一约束使用） */
  @Column({ length: 36, nullable: true })
  user_a: string | null;

  /** 参与者 2（固定取较大的 user_id） */
  @Column({ length: 36, nullable: true })
  user_b: string | null;

  /** 发起设备 devices.id */
  @Column({ length: 36, nullable: true })
  e2e_device_a: string | null;

  /** 接受设备 devices.id（pending 时为 null） */
  @Column({ length: 36, nullable: true })
  e2e_device_b: string | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

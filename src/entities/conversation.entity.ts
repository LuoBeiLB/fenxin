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

  /** AI 成员开关（P2 预留）：开启后频道主可与 AI 对话，订阅者可围观 */
  @Column({ default: false })
  ai_enabled: boolean;

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

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

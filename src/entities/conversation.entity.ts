import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type ConversationType = 'private' | 'group' | 'channel';

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

  @Column({ type: 'int', default: 0 })
  member_count: number;

  @Column({ type: 'datetime', nullable: true })
  last_message_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

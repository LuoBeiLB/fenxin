import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type MessageType = 'text' | 'image' | 'voice' | 'video' | 'file';

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_messages_conversation_id')
  @Column({ length: 36 })
  conversation_id: string;

  @Index('idx_messages_sender_id')
  @Column({ length: 36 })
  sender_id: string;

  @Column({ length: 20 })
  type: MessageType;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ length: 500, nullable: true })
  file_url: string | null;

  @Column({ length: 200, nullable: true })
  file_name: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: {
    to: (v: number | null) => v,
    from: (v: string | null) => (v === null ? null : Number(v)),
  } })
  file_size: number | null;

  @Column({ length: 36, nullable: true })
  reply_to_id: string | null;

  @Column({ default: false })
  is_edited: boolean;

  @Column({ default: false })
  is_recalled: boolean;

  @Column({ default: false })
  is_destroyed: boolean;

  @Index('idx_messages_destroy_at')
  @Column({ type: 'datetime', nullable: true })
  destroy_at: Date | null;

  @Index('idx_messages_created_at')
  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

@Entity('message_receipts')
@Unique('idx_msg_receipts_unique', ['message_id', 'user_id'])
export class MessageReceipt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_msg_receipts_message_id')
  @Column({ length: 36 })
  message_id: string;

  @Index('idx_msg_receipts_user_id')
  @Column({ length: 36 })
  user_id: string;

  @Column({ default: false })
  is_delivered: boolean;

  @Column({ default: false })
  is_read: boolean;

  @Column({ type: 'datetime', nullable: true })
  read_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}

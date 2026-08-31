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

  /** 点开才焚：该用户点开查看消息内容的时间（NULL = 还没点开，列表只给马赛克占位） */
  @Column({ type: 'datetime', nullable: true })
  revealed_at: Date | null;

  /** 点开才焚：该用户这份内容的焚毁截止时间（revealed_at + messages.burn_ttl_seconds；NULL = 未点开不计时） */
  @Index('idx_msg_receipts_burn_at')
  @Column({ type: 'datetime', nullable: true })
  burn_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}

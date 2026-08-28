import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type FeedbackStatus = 'pending' | 'processed';

@Entity('feedbacks')
export class Feedback {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 提交人用户 ID */
  @Index('idx_feedbacks_user_id')
  @Column({ length: 36 })
  user_id: string;

  /** 意见内容 */
  @Column({ type: 'text' })
  content: string;

  /** 用户自愿留下的联系方式（可选） */
  @Column({ length: 100, nullable: true })
  contact: string | null;

  /** 处理状态：pending=待处理；processed=已处理（管理员回复后置为 processed） */
  @Index('idx_feedbacks_status')
  @Column({ length: 20, default: 'pending' })
  status: FeedbackStatus;

  /** 管理员回复内容 */
  @Column({ type: 'text', nullable: true })
  admin_reply: string | null;

  /** 回复操作人（管理员）用户 ID */
  @Column({ length: 36, nullable: true })
  replied_by: string | null;

  @Column({ type: 'datetime', nullable: true })
  replied_at: Date | null;

  @Index('idx_feedbacks_created_at')
  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

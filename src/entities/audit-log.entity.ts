import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_audit_logs_user_id')
  @Column({ length: 36, nullable: true })
  user_id: string | null;

  @Index('idx_audit_logs_action')
  @Column({ length: 50 })
  action: string;

  @Column({ length: 50, nullable: true })
  target_type: string | null;

  @Column({ length: 36, nullable: true })
  target_id: string | null;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @Column({ length: 45, nullable: true })
  ip_address: string | null;

  @Column({ length: 500, nullable: true })
  user_agent: string | null;

  @Index('idx_audit_logs_created_at')
  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}

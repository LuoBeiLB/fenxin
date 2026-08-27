import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type AnnouncementPriority = 'normal' | 'urgent';
export type AnnouncementTargetType = 'all' | 'department';

@Entity('announcements')
export class Announcement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 200 })
  title: string;

  @Column({ type: 'text' })
  content: string;

  /** 优先级：normal=仅进公告中心；urgent=额外走 WebSocket 实时弹窗推送 */
  @Index('idx_announcements_priority')
  @Column({ length: 20, default: 'normal' })
  priority: AnnouncementPriority;

  /** 目标范围：all=全员；department=按部门（target_departments 存 JSON 数组） */
  @Column({ length: 20, default: 'all' })
  target_type: AnnouncementTargetType;

  /** target_type=department 时的部门名单（JSON 数组字符串，如 ["技术部","市场部"]） */
  @Column({ type: 'text', nullable: true })
  target_departments: string | null;

  @Index('idx_announcements_created_by')
  @Column({ length: 36 })
  created_by: string;

  @Index('idx_announcements_created_at')
  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

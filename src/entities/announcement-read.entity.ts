import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

/** 公告已读记录：一人一公告一条，用于公告中心未读角标与已读状态 */
@Entity('announcement_reads')
@Unique('idx_announcement_reads_unique', ['announcement_id', 'user_id'])
export class AnnouncementRead {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_announcement_reads_announcement_id')
  @Column({ length: 36 })
  announcement_id: string;

  @Index('idx_announcement_reads_user_id')
  @Column({ length: 36 })
  user_id: string;

  @CreateDateColumn({ type: 'datetime' })
  read_at: Date;
}

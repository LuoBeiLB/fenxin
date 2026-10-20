import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

export type MemberRole = 'owner'| 'member';

@Entity('conversation_members')
@Unique('idx_conv_members_unique', ['conversation_id', 'user_id'])
export class ConversationMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_conv_members_conversation_id')
  @Column({ length: 36 })
  conversation_id: string;

  @Index('idx_conv_members_user_id')
  @Column({ length: 36 })
  user_id: string;

  @Column({ length: 20, default: 'member' })
  role: MemberRole;

  @Column({ length: 36, nullable: true })
  last_read_message_id: string | null;

  /** 入群时间（V6.0：此前只写不读，现用于群成员列表与已读统计展示） */
  @CreateDateColumn({ type: 'datetime' })
  joined_at: Date;
}

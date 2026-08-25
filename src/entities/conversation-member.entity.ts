import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

export type MemberRole = 'owner' | 'admin' | 'member';

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

  @Column({ default: false })
  muted: boolean;

  @Column({ length: 36, nullable: true })
  last_read_message_id: string | null;

  @CreateDateColumn({ type: 'datetime' })
  joined_at: Date;
}

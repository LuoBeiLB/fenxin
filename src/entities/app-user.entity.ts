import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('app_users')
export class AppUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_users_phone')
  @Column({ length: 20, unique: true })
  phone: string;

  @Column({ length: 255 })
  password_hash: string;

  @Index('idx_users_display_name')
  @Column({ length: 100 })
  display_name: string;

  @Column({ length: 500, nullable: true })
  avatar_url: string | null;

  @Column({ length: 200, nullable: true })
  signature: string | null;

  @Index('idx_users_department')
  @Column({ length: 100, nullable: true })
  department: string | null;

  @Column({ length: 20, default: 'user' })
  role: 'user' | 'admin';

  @Index('idx_users_status')
  @Column({ length: 20, default: 'active' })
  status: 'active' | 'disabled';

  @Column({ default: true })
  force_change_pwd: boolean;

  @Column({ type: 'int', default: 0 })
  login_fail_count: number;

  @Column({ type: 'datetime', nullable: true })
  locked_until: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

/** 对外返回用户信息的字段白名单（任何接口不得返回 password_hash 等敏感字段） */
export const SAFE_USER_FIELDS: (keyof AppUser)[] = [
  'id',
  'phone',
  'display_name',
  'avatar_url',
  'signature',
  'department',
  'role',
  'status',
  'force_change_pwd',
  'created_at',
  'updated_at',
];

export function sanitizeUser(user: AppUser | null): Partial<AppUser> | null {
  if (!user) return null;
  const out: Partial<AppUser> = {};
  for (const k of SAFE_USER_FIELDS) {
    (out as any)[k] = user[k];
  }
  return out;
}

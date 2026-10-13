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

  /** 用户自选前端主题色标识（如 default / dark / blue 或前端自定义枚举），存服务端换设备同步；值域由前端定义，后端只存取 */
  @Column({ length: 20, default: 'default' })
  topic: string;

  /**
   * 用户默认焚毁时长偏好（秒，V5.9.4 与 topic 同模式的用户偏好字段）。
   * 语义：**该用户下次发消息时前端自动带上的 burn_ttl_seconds 默认值**。
   * - 正整数（如 600 = 10 分钟、86400 = 1 天）：焚毁消息默认时长
   * - NULL = 默认不焚毁（用户选择"关闭"或从未选择过）
   *
   * 与消息级 messages.burn_ttl_seconds 的区别：本字段只是「用户偏好/上次选择」，
   * 服务端只存取不参与任何焚毁判定；真正生效的仍以发送请求体里的 burn_ttl_seconds 为准。
   * 客户端选择后同步到服务端，换设备 / 重启浏览器登录即可恢复，无需重新选择。
   */
  @Column({ type: 'int', nullable: true })
  default_burn_ttl_seconds: number | null;

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

  /** 软删除标记：非空表示账号已删除（不可登录、不出现在通讯录，历史数据保留供审计） */
  @Index('idx_users_deleted_at')
  @Column({ type: 'datetime', nullable: true })
  deleted_at: Date | null;

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
  'deleted_at',
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

/**
 * 个人资料出口专用：SafeUser 基础上附加用户偏好（topic 主题色、default_burn_ttl_seconds 默认焚毁时长）。
 * 仅用于登录响应 / GET|PUT /auth/profile —— 这些都是用户自己的偏好，
 * 通讯录、会话成员、群成员等出口继续用 sanitizeUser，不暴露他人的偏好设置。
 */
export function sanitizeUserWithPrefs(
  user: AppUser | null,
): (Partial<AppUser> & { topic: string; default_burn_ttl_seconds: number | null }) | null {
  if (!user) return null;
  return {
    ...sanitizeUser(user),
    topic: user.topic ?? 'default',
    // 归一化：存量行（迁移前）与异常值一律落到 null = 默认不焚毁，前端无需区分 undefined/null
    default_burn_ttl_seconds:
      typeof user.default_burn_ttl_seconds === 'number' && user.default_burn_ttl_seconds > 0
        ? user.default_burn_ttl_seconds
        : null,
  };
}

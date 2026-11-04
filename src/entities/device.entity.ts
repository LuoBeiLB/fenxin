import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('devices')
// 设备唯一性：(user_id, device_id) 复合唯一 —— 同一账号同一设备只允许一条记录，
// 不同账号可共用同一物理设备（device_id 由客户端生成并持久化）
@Index('idx_devices_user_device', ['user_id', 'device_id'], { unique: true })
export class Device {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_devices_user_id')
  @Column({ length: 36 })
  user_id: string;

  @Column({ length: 100 })
  device_name: string;

  @Column({ length: 20 })
  device_type: string;

  /** 登录时的原始 User-Agent（服务端记录，排查问题用；超长截断到 512） */
  @Column({ length: 512, nullable: true })
  user_agent: string | null;

  /**
   * 服务端从 UA 解析出来的浏览器（V6.2）。
   * 与 device_name 的区别：device_name 是客户端自报的"昵称"，这里是客观识别结果。
   */
  @Column({ length: 40, nullable: true })
  browser: string | null;

  /** 浏览器版本（Chrome 101+ 的 UA 冻结导致只有大版本可靠） */
  @Column({ length: 20, nullable: true })
  browser_version: string | null;

  /** 操作系统：Windows / macOS / iOS / iPadOS / Android / HarmonyOS / Linux / ChromeOS */
  @Column({ length: 40, nullable: true })
  os: string | null;

  /** 系统版本 */
  @Column({ length: 20, nullable: true })
  os_version: string | null;

  @Column({ length: 100 })
  device_id: string;

  /**
   * 是否在线（V6.0 才有真实语义）。
   * 之前登录时置 true 后永不置 false，导致管理端"在线设备数"必然失真。
   * 现在由两条通道共同维护：
   *  - WS 连接/断开：socket_count ±1
   *  - 客户端心跳：last_active_at 刷新
   * 两者都失效（socket_count<=0 且 last_active_at 超过 ONLINE_TTL_SECONDS）才置 false。
   */
  @Column({ default: false })
  is_online: boolean;

  /** 当前该设备的活跃 WS 连接数（同一浏览器多标签页会 >1，不能简单用 0/1 表示在线） */
  @Column({ type: 'int', default: 0 })
  socket_count: number;

  /** 本次上线时间（is_online 由 false→true 时写入） */
  @Column({ type: 'datetime', nullable: true })
  online_at: Date | null;

  /** 最近下线时间（is_online 由 true→false 时写入） */
  @Column({ type: 'datetime', nullable: true })
  offline_at: Date | null;

  @Column({ type: 'datetime', nullable: true })
  last_active_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}

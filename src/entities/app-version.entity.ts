import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * App 版本发布记录（V5.8 App 自更新）。
 *
 * 管理后台通过 POST /app-versions 上传 APK 并登记版本；App 端启动时调
 * GET /app-versions/latest 比对 version_code 决定是否提示更新；管理员发布
 * 新版本时通过 WS 事件 app:update 实时推送给全部在线用户。
 *
 * 版本判定一律用整数 version_code（如 58），不要用 version_name 字符串比较
 * （"5.10" < "5.9" 的字符串比较是错的）。
 */
@Entity('app_versions')
@Index('uk_app_versions_platform_code', ['platform', 'version_code'], { unique: true })
export class AppVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 平台：android / ios（iOS 上线前仅 android；同一 version_code 可在两平台各发一条） */
  @Column({ length: 20, default: 'android' })
  platform: string;

  /** Android versionCode / iOS build number：同 platform 内全局递增整数，客户端据此判断有无新版本 */
  @Column({ type: 'int' })
  version_code: number;

  /** 展示用版本名（如 5.8），仅用于弹窗展示，不参与大小比较 */
  @Column({ length: 20 })
  version_name: string;

  /** APK 下载地址（相对路径 /uploads/app/xxx.apk，客户端自行拼 baseURL） */
  @Column({ length: 500 })
  apk_url: string;

  /** APK 文件大小（字节），客户端用于展示与下载进度估算 */
  @Column({ type: 'int', default: 0 })
  file_size: number;

  /** 是否强制更新：true 时客户端弹窗不给"下次再说" */
  @Column({ type: 'tinyint', width: 1, default: 0 })
  force: boolean;

  /** 更新说明（发版日志，弹窗内展示） */
  @Column({ type: 'text' })
  notes: string;

  /** 发布状态：false=已撤回（App 端 latest 接口不再返回该版本），文件保留 */
  @Column({ type: 'tinyint', width: 1, default: 1 })
  published: boolean;

  /** 发布操作的管理员用户 ID */
  @Index('idx_app_versions_created_by')
  @Column({ length: 36 })
  created_by: string;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

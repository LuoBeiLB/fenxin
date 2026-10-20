import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type MessageType = 'text' | 'image' | 'voice' | 'video' | 'file';

@Entity('messages')
// 焚毁调度扫描索引：规则 A/B 都是 is_destroyed=0 + 时间条件
@Index('idx_messages_burn_scan', ['is_destroyed', 'destroy_at'])
// 真删除（purge）扫描索引：is_destroyed=1 + destroyed_at 窗口
@Index('idx_messages_purge', ['is_destroyed', 'destroyed_at'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_messages_conversation_id')
  @Column({ length: 36 })
  conversation_id: string;

  @Index('idx_messages_sender_id')
  @Column({ length: 36 })
  sender_id: string;

  @Column({ length: 20 })
  type: MessageType;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ length: 500, nullable: true })
  file_url: string | null;

  @Column({ length: 200, nullable: true })
  file_name: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: {
    to: (v: number | null) => v,
    from: (v: string | null) => (v === null ? null : Number(v)),
  } })
  file_size: number | null;

  /**
   * 原图地址（v5.8.7 图片链路优化）：file_url 存前端压缩版（聊天流秒开、省 5Mbps 出带宽），
   * 本字段存发送端原图，供「下载原图」使用。双上传策略见 docs/migration-20260904-image-original.sql。
   * NULL = 无原图（老消息/纯文本/语音/压缩失败直传原图时），前端回退用 file_url 下载。
   * 补传时序：先发消息（file_url=压缩版）→ 后台传原图 → PATCH /messages/:id/original-file 回填本字段。
   */
  @Column({ length: 500, nullable: true })
  file_original_url: string | null;

  /**
   * 音视频时长（秒，v5.8.9 播完才焚）：发送端上报（语音=录音秒数、视频=播放器 metadata duration）。
   * 焚毁消息 reveal 时消费窗口 = max(burn_ttl_seconds, media_duration + BURN_MEDIA_BUFFER_SECONDS)，
   * 保证「10s 焚毁 + 30s 视频」这类组合能播完再焚。NULL = 未上报，reveal 走默认窗口兜底。
   */
  @Column({ type: 'int', nullable: true })
  media_duration: number | null;

  @Column({ length: 36, nullable: true })
  reply_to_id: string | null;

  @Column({ default: false })
  is_edited: boolean;

  @Column({ default: false })
  is_recalled: boolean;

  /**
   * 是否已焚毁（V6.0 软删除标记）。
   * 0 = 正常；1 = 已焚毁 —— 列表 / 搜索 / reveal 全部不可见，但**行与附件仍在**，
   * 等待前端确认（或 ACK_FALLBACK_DAYS 超期）后由 DestroyService.purge() 真删除。
   */
  @Column({ default: false })
  is_destroyed: boolean;

  /** 实际标记焚毁的时刻（软删时间，真删除任务依据） */
  @Column({ type: 'datetime', nullable: true })
  destroyed_at: Date | null;

  /** 焚毁原因：fallback_expired / all_read / owner_dissolve / admin_dissolve / manual */
  @Column({ length: 20, nullable: true })
  destroy_reason: string | null;

  /**
   * 绝对销毁上限（V6.0 语义变更）：
   * - 发送时 = created_at + max(BURN_FALLBACK_TTL_HOURS, burn_ttl_seconds)
   *   —— 兜底时长不得短于用户选择的持续时间，否则"还没等到消息持续时间结束就被删"
   * - 首次点开时 = max(当前值, burn_at)
   *   —— 保证"晚点开"的人也能拿满自己的 ttl
   */
  @Index('idx_messages_destroy_at')
  @Column({ type: 'datetime', nullable: true })
  destroy_at: Date | null;

  /**
   * 消息持续时长（秒，用户选择；NULL = 非焚毁消息）。
   * 点开后才开始计时：message_receipts.burn_at = revealed_at + burn_ttl_seconds。
   */
  @Column({ type: 'int', nullable: true })
  burn_ttl_seconds: number | null;

  // ===== E2E 端到端加密字段（方案 B 简化版，见 docs/E2E_ENCRYPTION.md）=====
  // 三者要么全填（全密文），要么全 null（明文，content 是真明文）。
  // 加密消息的 content 只是占位提示（如 "[加密消息]"），明文在客户端解密 cipher_text 得到。

  /** 是否加密。true → 客户端用 cipher_text + cipher_nonce + sender_ephemeral_pubkey 解密 */
  @Column({ default: false })
  is_encrypted: boolean;

  /** AES-256-GCM nonce，base64 编码（12 字节 → 16 字符）。加密消息必填 */
  @Column({ length: 32, nullable: true })
  cipher_nonce: string | null;

  /** AES-256-GCM 密文 + auth tag，base64 编码。加密消息必填 */
  @Column({ type: 'text', nullable: true })
  cipher_text: string | null;

  /** 发送方临时 X25519 公钥，base64 编码（32 字节 → 44 字符）。加密消息必填 */
  @Column({ length: 100, nullable: true })
  sender_ephemeral_pubkey: string | null;

  /**
   * @提及（V5.8 前端「有人@我」）：本条消息实际@到的成员用户 ID 数组。
   * content 里的「@昵称」纯文本仅供展示（同名/改名会漂移误判），mentions 才是精确身份，
   * 前端用它判定「有人@我」。发送时仅保留会话成员 uid（非成员过滤）；
   * uid 属群成员关系同级元数据（不在加密范围内），不涉消息内容泄露。
   * 类型必须用 'json'，不能用 'simple-json'（2026-09-02 修复启动后查询 500）：
   * mysql2 驱动对 json 列会自动 JSON.parse 成 JS 值，而 TypeORM(0.3.20) 的 simple-json
   * hydrate 分支无 typeof string 保护会二次 parse——JSON.parse([]) 等价于 JSON.parse('')，
   * 抛 "Unexpected end of JSON input" 使历史消息查询 500；json 分支有保护直接透传，安全。
   * 注意：仍不能写 default（数组 default 会被 TypeORM 序列化成空串 DEFAULT，MySQL json 列拒绝）；
   * DB 端默认值只由 migration 用表达式 DEFAULT (JSON_ARRAY()) 提供（生产 DB_SYNC=false 时执行）；
   * 存量/异常值兜底见 applyBurnView 入口的归一化（null → []）。
   */
  @Column({ type: 'json' })
  mentions: string[];

  @Index('idx_messages_created_at')
  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

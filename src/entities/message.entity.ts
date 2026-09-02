import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type MessageType = 'text' | 'image' | 'voice' | 'video' | 'file';

@Entity('messages')
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

  @Column({ length: 36, nullable: true })
  reply_to_id: string | null;

  @Column({ default: false })
  is_edited: boolean;

  @Column({ default: false })
  is_recalled: boolean;

  @Column({ default: false })
  is_destroyed: boolean;

  @Index('idx_messages_destroy_at')
  @Column({ type: 'datetime', nullable: true })
  destroy_at: Date | null;

  /**
   * 点开才焚（阅后即焚 v2）：点开查看后多少秒焚毁（NULL = 非焚毁消息）。
   * 焚毁消息对所有人（含发送方）都是马赛克占位，调 reveal 接口才下发内容；
   * 各成员各自点开、各自倒计时（message_receipts.burn_at），互不影响。
   * destroy_at 在本模式下语义为「兜底强制焚毁时间」（发送时 = created_at + BURN_FALLBACK_TTL_HOURS），
   * 防止有人一直不点开导致消息永久留存。
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
   * 注意：这里不能写 default: '[]'——TypeORM synchronize 会把它生成 DEFAULT '[]'（字面量），
   * MySQL 禁止 JSON 列使用字面量默认值，启动即报
   * "BLOB, TEXT, GEOMETRY or JSON column 'mentions' can't have a default value"。
   * DB 端默认值只由 migration 用表达式 DEFAULT (JSON_ARRAY()) 提供（生产 DB_SYNC=false 时执行）；
   * 应用层兜底见 applyBurnView 入口的归一化。
   */
  @Column({ type: 'simple-json' })
  mentions: string[];

  @Index('idx_messages_created_at')
  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

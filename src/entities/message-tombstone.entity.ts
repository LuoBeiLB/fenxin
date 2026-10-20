import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * 已真删除消息的轻量墓碑（V6.0 两阶段销毁）。
 *
 * 为什么需要：`is_destroyed=1` 只表示"已焚毁"，行与附件仍在；等前端确认
 * （或超期兜底）后由 DestroyService.purge() 物理删除消息行。
 * 行删掉后前端就没有"此消息已焚毁"的占位信息来源了，所以真删除前先写一条墓碑。
 *
 * **墓碑不保存任何消息内容**：没有 content / file_url / cipher_* / mentions，
 * 只有渲染占位必需的元数据（谁发的、什么类型、什么时候发的、为什么焚毁）。
 */
@Entity('message_tombstones')
export class MessageTombstone {
  /** 原消息 ID（沿用 message.id，便于前端按 id 去重/定位） */
  @PrimaryColumn({ length: 36 })
  id: string;

  @Index('idx_tomb_conv')
  @Column({ length: 36 })
  conversation_id: string;

  @Column({ length: 36 })
  sender_id: string;

  /** 原消息类型（text/image/voice/video/file），前端据此显示"焚毁图片/焚毁文件" */
  @Column({ length: 20 })
  type: string;

  /** 原消息发送时间（决定墓碑在聊天流里的位置） */
  @Column({ type: 'datetime' })
  created_at: Date;

  /** 标记焚毁的时间 */
  @Column({ type: 'datetime' })
  destroyed_at: Date;

  /** 焚毁原因：fallback_expired / all_read / owner_dissolve / admin_dissolve / manual */
  @Column({ length: 20 })
  destroy_reason: string;
}

import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, CreateDateColumn } from 'typeorm';

/**
 * 真删除确认记录（V6.0 两阶段销毁的第二阶段）。
 *
 * 语义：某用户在某台设备上、某个时刻，明确告知服务端"这条已焚毁的消息我这边
 * 已经处理完了，可以真删"。服务端收到确认且满足策略后才执行物理删除。
 *
 * 幂等：`(message_id, user_id)` 唯一，重复 ack 走 upsert。
 */
@Entity('message_destroy_acks')
@Unique('uk_ack_msg_user', ['message_id', 'user_id'])
export class MessageDestroyAck {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_ack_msg')
  @Column({ length: 36 })
  message_id: string;

  @Column({ length: 36 })
  user_id: string;

  /** 发起确认的设备记录主键（devices.id），便于审计哪台设备确认的 */
  @Column({ length: 36, nullable: true })
  device_id: string | null;

  @CreateDateColumn({ type: 'datetime' })
  acked_at: Date;
}

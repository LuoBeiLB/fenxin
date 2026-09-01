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

  @Column({ length: 100 })
  device_id: string;

  @Column({ default: false })
  is_online: boolean;

  @Column({ type: 'datetime', nullable: true })
  last_active_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}

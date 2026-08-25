import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('devices')
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

  @Index('idx_devices_unique', { unique: true })
  @Column({ length: 100 })
  device_id: string;

  @Column({ default: false })
  is_online: boolean;

  @Column({ type: 'datetime', nullable: true })
  last_active_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}

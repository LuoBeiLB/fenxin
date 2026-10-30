import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * 设备级 X25519 identity 公钥（V6.2 设备配对私密会话）。
 *
 * 为什么不再用 user_keys：
 *   - 用户级密钥在多设备场景会被后登录设备覆盖，导致只有最后一台能解密；
 *   - 私密会话按「设备对」建立，天然需要每台设备一把独立密钥。
 *
 * 约束：
 *   - `(user_id, device_id)` 唯一：一台设备一行，登录再多也互不覆盖；
 *   - 只存**公钥**：私钥由客户端生成并只保存在本地，服务端零接触；
 *   - 设备下线/被踢时由 `AuthService.removeDevice` 删除对应行，该设备从此无法解密新消息。
 */
@Entity('device_keys')
@Index('uk_device_keys_user_device', ['user_id', 'device_id'], { unique: true })
@Index('idx_device_keys_device', ['device_id'])
export class DeviceKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 36 })
  user_id: string;

  /** 对应 devices.id（JWT payload.deviceId） */
  @Column({ length: 36 })
  device_id: string;

  /** X25519 公钥，base64 编码（32 字节 → 44 字符，保留 '=' 填充） */
  @Column({ length: 100 })
  identity_pubkey: string;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

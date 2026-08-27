import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * 用户 X25519 长期身份公钥（V4.0 §E2E 单聊加密 / 方案 B 简化版）。
 *
 * 设计要点：
 *   - 每个用户 1 行：user_id 唯一索引，多次上传 → 覆盖公钥
 *   - 只存 public key：服务端零接触明文密钥，符合 E2E 核心约束
 *   - private key 由客户端生成、仅存 IndexedDB / Keychain，重装/换设备即丢
 *     （这跟"阅后即焚"语义契合：密钥丢 = 历史消息也没了，预期行为）
 *
 * 协议（详见 docs/E2E_ENCRYPTION.md）：
 *   发送方 Alice 给接收方 Bob 发密文：
 *     1. Alice 从服务端 GET /keys/:bobId 拿 bob.identity_pubkey
 *     2. Alice 生成 ephemeral 密钥对 (epk, esk)
 *     3. shared_secret = ECDH(esk, bob.identity_pubkey) || ECDH(alice.identity_private, bob.identity_pubkey)
 *     4. session_key = HKDF-SHA256(shared_secret, salt=conversation_id, info='msg', 32)
 *     5. ciphertext = AES-256-GCM(plaintext, session_key, nonce=12B random)
 *     6. Alice POST /messages 传 { cipher_text, cipher_nonce, sender_ephemeral_pubkey=epk }
 *   接收方 Bob 收密文：
 *     1. 拿 ciphertext + nonce + sender_ephemeral_pubkey
 *     2. 同样做 ECDH + HKDF → 同样的 session_key
 *     3. AES-256-GCM-decrypt → plaintext
 *
 * 限制（已知 / 留 TODO）：
 *   - 不支持异步首发消息：Bob 不在线时 Alice 拿不到公钥 → 需 fallback "明文 + 提示" 或 "暂存待 Bob 上线"
 *   - 不支持群聊：群成员密钥分发是另一个问题（待 X3DH / sender keys 升级）
 *   - 不防服务端偷换公钥：需后续加签名机制（signing_pubkey + signed_prekey）
 */
@Entity('user_keys')
export class UserKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('uk_user_keys_user_id', { unique: true })
  @Column({ length: 36 })
  user_id: string;

  /**
   * X25519 identity public key，base64 编码（32 字节 → 44 字符）。
   * 服务端只校验长度和 base64 格式，不做曲线点校验（前端在加解密时会失败，错误回流即可）。
   */
  @Column({ length: 100 })
  identity_pubkey: string;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}

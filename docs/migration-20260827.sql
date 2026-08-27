-- =============================================================
-- 焚信 BurnMsg 数据库迁移（2026-08-27）
-- 内容：账号软删除 / 群软解散 / Dashboard 统计 / 系统公告
-- 用法：在后端数据库（默认 burnmsg）执行一次。执行前建议备份。
--   mysql -u root -p burnmsg < docs/migration-20260827.sql
-- 说明：本迁移与 synchronize=false 的生产/本地运行方式配套；
--   若临时以 DB_SYNC=true 启动，TypeORM 会自动建/改这些表，无需本脚本。
-- =============================================================

-- ① 账号软删除：deleted_at 标记（含索引）
ALTER TABLE app_users
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL AFTER locked_until,
  ADD INDEX idx_users_deleted_at (deleted_at);

-- ② 群软解散：dissolved_at 标记（含索引）
ALTER TABLE conversations
  ADD COLUMN dissolved_at DATETIME NULL DEFAULT NULL AFTER last_message_at,
  ADD INDEX idx_conversations_dissolved_at (dissolved_at);

-- ③ 系统公告表
CREATE TABLE IF NOT EXISTS announcements (
  id CHAR(36) NOT NULL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  target_type VARCHAR(20) NOT NULL DEFAULT 'all',
  target_departments TEXT NULL,
  created_by VARCHAR(36) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_announcements_priority (priority),
  INDEX idx_announcements_created_by (created_by),
  INDEX idx_announcements_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ④ 公告已读记录表（一人一公告一条，唯一约束）
CREATE TABLE IF NOT EXISTS announcement_reads (
  id CHAR(36) NOT NULL PRIMARY KEY,
  announcement_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_announcement_reads_unique (announcement_id, user_id),
  INDEX idx_announcement_reads_announcement_id (announcement_id),
  INDEX idx_announcement_reads_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 第二部分：合并 fbs 分支（E2EE + 群主解散）
-- ============================================================

-- ⑤ 消息表：E2E 端到端加密字段（方案 B 简化版，见 docs/E2E_ENCRYPTION.md）
-- 三字段要么全填（全密文）要么全 NULL（明文）；is_encrypted 区分
ALTER TABLE messages
  ADD COLUMN is_encrypted TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN cipher_nonce VARCHAR(32) NULL,
  ADD COLUMN cipher_text TEXT NULL,
  ADD COLUMN sender_ephemeral_pubkey VARCHAR(100) NULL;

-- ⑥ 会话表：记录解散操作人（群主解散 / 管理员强制解散）
ALTER TABLE conversations
  ADD COLUMN dissolved_by VARCHAR(36) NULL;

-- ⑦ 用户 E2E 身份公钥表（X25519，服务端零接触私钥）
CREATE TABLE IF NOT EXISTS user_keys (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  identity_pubkey VARCHAR(100) NOT NULL COMMENT 'X25519 identity public key, base64(32字节)=44字符',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_keys_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

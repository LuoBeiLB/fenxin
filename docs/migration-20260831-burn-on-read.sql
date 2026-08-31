-- migration-20260831-burn-on-read.sql
-- 点开才焚（阅后即焚 v2）：消息不再「发送即倒计时」，改为「点开才开始倒计时」。
--
-- 变更内容：
--   1. messages 新增 burn_ttl_seconds：点开查看后多少秒焚毁（NULL = 非焚毁消息）
--   2. message_receipts 新增 revealed_at / burn_at：每个成员各自的点开时间与焚毁截止时间
--   3. messages.destroy_at 语义变更：焚毁消息下为「兜底强制焚毁时间」
--      （发送时 = created_at + env BURN_FALLBACK_TTL_HOURS，默认 24h）
--
-- 执行方式：
--   mysql -u root -p burnmsg < docs/migration-20260831-burn-on-read.sql
--
-- 说明：
--   - 若 DB_SYNC=true 启动过服务，TypeORM 可能已自动加列，本脚本可安全重复执行（加列前判断）。
--   - 老数据：存量 destroy_at 非 NULL 的消息保持原「发送即焚」语义到期销毁，不受影响。

-- ---------- 1. messages.burn_ttl_seconds ----------
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'burn_ttl_seconds'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE messages ADD COLUMN burn_ttl_seconds INT NULL COMMENT ''点开才焚：点开后多少秒焚毁（NULL=非焚毁消息）'' AFTER destroy_at',
  'SELECT ''messages.burn_ttl_seconds 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 2. message_receipts.revealed_at ----------
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_receipts' AND COLUMN_NAME = 'revealed_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE message_receipts ADD COLUMN revealed_at DATETIME NULL COMMENT ''点开查看时间（NULL=未点开，列表只给马赛克占位）'' AFTER read_at',
  'SELECT ''message_receipts.revealed_at 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 3. message_receipts.burn_at + 索引 ----------
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_receipts' AND COLUMN_NAME = 'burn_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE message_receipts ADD COLUMN burn_at DATETIME NULL COMMENT ''该用户的焚毁截止时间（revealed_at + burn_ttl_seconds）'' AFTER revealed_at',
  'SELECT ''message_receipts.burn_at 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_receipts' AND INDEX_NAME = 'idx_msg_receipts_burn_at'
);
SET @sql := IF(@idx = 0,
  'CREATE INDEX idx_msg_receipts_burn_at ON message_receipts (burn_at)',
  'SELECT ''idx_msg_receipts_burn_at 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 4. 存量老数据处置 ----------
-- 老的「发送即焚」消息（destroy_at 非 NULL 且 burn_ttl_seconds 为 NULL）保持原语义：
-- BurnScheduler 的兜底扫描（destroy_at <= now）会照常销毁它们，无需改动。
-- 无需 UPDATE，此处仅注释说明。

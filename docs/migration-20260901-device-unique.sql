-- migration-20260901-device-unique.sql 设备去重：修复「同一设备重复登录出现重复设备记录」
--
-- 变更内容：
-- 1. devices 索引调整：device_id 全局唯一 → (user_id, device_id) 复合唯一
--    （device_id 改由客户端生成并持久化，同一物理设备跨账号登录不应冲突）
-- 2. 配套代码：LoginDto 新增可选 device_id 字段；登录逻辑改为按 device_id upsert
--
-- 执行方式：
--   mysql -u root -p burnmsg < docs/migration-20260901-device-unique.sql
--
-- 说明：
-- - 存量数据 device_id 均为服务端随机生成，不会出现 (user_id, device_id) 重复，加索引安全
-- - 可安全重复执行（删/建索引前判断）

-- ---------- 1. 删除旧的全局唯一索引 ----------
SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'idx_devices_unique'
);
SET @sql := IF(@idx > 0,
  'ALTER TABLE devices DROP INDEX idx_devices_unique',
  'SELECT ''idx_devices_unique 不存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 2. 新建 (user_id, device_id) 复合唯一索引 ----------
SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'idx_devices_user_device'
);
SET @sql := IF(@idx = 0,
  'ALTER TABLE devices ADD UNIQUE INDEX idx_devices_user_device (user_id, device_id)',
  'SELECT ''idx_devices_user_device 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

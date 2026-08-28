-- =============================================================
-- 焚信 BurnMsg 数据库迁移（2026-08-28）：取消群内管理员角色
-- 背景：群内只保留 owner（群主）/ member（成员）两种角色；
--       「管理员」一律指系统管理员（app_users.role=admin），可跨群管理。
-- 用法：在后端数据库（默认 burnmsg）执行一次。
--   mysql -u root -p burnmsg < docs/migration-20260828-group-role-cleanup.sql
-- 说明：若库中从未写入过 role='admin' 的成员记录，本迁移执行后无影响（0 行变更）。
-- =============================================================

-- 存量群管理员降级为普通成员（其管理能力本就收回，无数据丢失）
UPDATE conversation_members SET role = 'member' WHERE role = 'admin';

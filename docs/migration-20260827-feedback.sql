-- ============================================================
-- 焚信服务端 迁移 SQL（意见反馈，2026-08-27）
-- 前置：已执行过 migration-20260827.sql
-- 说明：本服务 TypeORM synchronize=false，表结构以本文件为准
-- ============================================================

-- 意见反馈表：用户提交意见，管理员在管理后台查看与回复
CREATE TABLE IF NOT EXISTS feedbacks (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL COMMENT '提交人用户 ID',
  content TEXT NOT NULL COMMENT '意见内容（最长 2000 字）',
  contact VARCHAR(100) NULL COMMENT '用户自愿留下的联系方式',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending=待处理；processed=已处理（管理员回复后置位）',
  admin_reply TEXT NULL COMMENT '管理员回复内容',
  replied_by VARCHAR(36) NULL COMMENT '回复操作人（管理员）用户 ID',
  replied_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_feedbacks_user_id (user_id),
  INDEX idx_feedbacks_status (status),
  INDEX idx_feedbacks_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

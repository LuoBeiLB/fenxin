-- v5.8.6 个人频道（个人空间）P0 数据库迁移
-- 幂等说明：重复执行报 Duplicate column name 属正常（说明已加过），可忽略
USE burnmsg;

ALTER TABLE conversations
  ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'public'
    COMMENT '频道可见性：public=广场可见可自主订阅；private=不进广场（P1 邀请链接订阅）',
  ADD COLUMN ai_enabled TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'AI 成员开关（P2 预留）：开启后频道主可与 AI 对话，订阅者可围观';

-- 说明：
-- 1. 频道复用 conversations / conversation_members / messages 三张表，无新表；
--    频道判定 = type='channel'（群聊旧数据 is_channel 布尔标不受影响）
-- 2. 订阅关系即 conversation_members 行：subscribe 插入 / unsubscribe 删除
-- 3. member_count 即订阅数；频道主为 role='owner' 的那一行
-- 4. 频道消息全局搜索无需迁移：v5.8.5 全文索引 (content, file_name) 已覆盖，
--    权限走 INNER JOIN conversation_members，未订阅者天然搜不到

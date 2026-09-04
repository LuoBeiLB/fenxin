-- ============================================================
-- 2026-09-04 v5.8.5：消息全局搜索全文索引
-- 服务接口：GET /api/v1/messages/search（详见 openapi.yaml）
-- 依赖：MySQL 8.0+（内置 ngram 解析器，无需额外安装任何组件）
-- 说明：
--   1. TypeORM 的 synchronize（DB_SYNC=true）不会创建 FULLTEXT 索引，
--      必须手工执行本文件；漏执行时搜索接口会报错：
--      "Can't find FULLTEXT index matching the column list"
--   2. InnoDB ONLINE DDL：INPLACE 方式加 FULLTEXT 索引，允许并发 DML，不锁业务表。
--   3. 幂等性：MySQL 8 不支持 ADD FULLTEXT IF NOT EXISTS；重复执行报
--      "Duplicate key name 'ft_messages_search'" 即说明已建过，忽略该错误即可。
--   4. ngram_token_size 默认 2（中文二元分词），这也是接口要求关键词 >= 2 字符的原因。
--   5. 复合索引列清单 (content, file_name) 与代码中
--      MATCH(m.content, m.file_name) 必须完全一致，否则无法命中索引。
-- ============================================================

ALTER TABLE messages
  ADD FULLTEXT INDEX ft_messages_search (content, file_name) WITH PARSER ngram;

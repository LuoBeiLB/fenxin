# 数据库迁移执行手册（发布必读）

> 适用：`fenxin-server` 部署 / 升级
> 最后更新：2026-10-26
> 结论先行：**这个项目的库从来没有跑过迁移，新版本上线必须跑一次 `migration:run`**（共 10 个，全部幂等）。

---

## 一、怎么判断「要不要跑、从哪跑」

迁移记录表是 **`typeorm_migrations`**（不是 `migrations`）。

```sql
-- ① 迁移记录表在不在？
SELECT COUNT(*) AS cnt FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'typeorm_migrations';

-- ② 如果在，看已执行到哪
SELECT * FROM typeorm_migrations ORDER BY timestamp;
```

| 结果 | 含义 | 怎么办 |
|---|---|---|
| 表不存在 / `cnt = 0` | **一个迁移都没跑过** | 从第一个开始，全部执行 |
| 有记录 | 看差哪几个 | 正常 `migration:run`，它只跑未记录的 |

也可以用命令（在项目目录、用同一份 `.env`）：

```bash
npm run migration:show
```

输出 `[X]` 已执行、`[ ]` 待执行。

---

## 二、生产库的已知现状（2026-10-26 实测）

从服务器 `yy` 库导出的结构看：

```
表数量：12
typeorm_migrations：❌ 不存在 → 迁移一次都没跑过
DB_SYNC=true（.env）→ 表都是 synchronize 自动建的
```

缺失的迁移产物：

| 缺失项 | 属于哪个迁移 |
|---|---|
| `destroy_receipts` 表 | `1709000000000-AddDestroyReceipts` |
| `message_tombstones` 表 | `1767800000000-BurnV6SoftDelete` |
| `message_destroy_acks` 表 | `1767800000000-BurnV6SoftDelete` |
| `burn_settings` 表 | `1768000000000-AddBurnSettings` |
| `app_users.default_burn_ttl_seconds` | `1767700000000-AddUserBurnPreference` |
| `messages.destroyed_at` / `destroy_reason` | `1767800000000-BurnV6SoftDelete` |
| `devices.socket_count` / `online_at` / `offline_at` | `1767900000000-AddDevicePresence` |
| `ft_messages_search` FULLTEXT 索引 | `1768100000000-AddMessagesFulltextIndex` |
| `idx_messages_burn_scan` / `idx_messages_purge` | `1767800000000-BurnV6SoftDelete` |

> 已经存在的（会被幂等跳过）：`app_versions`、`app_users.topic`、`messages.mentions`、
> `messages.media_duration`、`messages.is_destroyed`、`conversation_members.muted`、
> `conversations.ai_enabled`、`message_receipts.is_delivered`。

**所以：全部 10 个迁移都会"从头"执行，但因为每个都带 `hasColumn`/`hasTable` 判断，
已存在的对象会跳过，不会报 `Duplicate column name`。**

---

## 三、执行前 3 项检查（缺一不可）

```bash
# ① 必须关掉 synchronize，否则它和迁移抢着改表
grep DB_SYNC .env          # 必须是 DB_SYNC=false

# ② 备份（迁移失败时唯一的退路）
mysqldump -h 127.0.0.1 -u root -p \
  --single-transaction --quick --no-tablespaces \
  yy | gzip > /backup/yy_before_migrate_$(date +%F_%H%M).sql.gz

# ③ 确认连的是哪个库（防止在错误的库上执行）
grep -E '^DB_(HOST|PORT|DATABASE)' .env
```

---

## 四、执行

```bash
# 项目目录（有 src + node_modules）
npm run migration:show      # 先看一遍
npm run migration:run       # 执行
npm run migration:show      # 确认全部 [X]
```

**只部署了 `dist`（没有 src）的环境**：

```bash
npm run build
npx typeorm -d dist/database/data-source.js migration:show
npx typeorm -d dist/database/data-source.js migration:run
```

**Docker 部署**：

```bash
docker exec -it fenxin-server npm run migration:run
# 或
docker exec -it fenxin-server npx typeorm -d dist/database/data-source.js migration:run
```

> 迁移按 `timestamp` 升序执行；中途失败会停在失败点，修复后重跑会从该点继续
> （已成功的不会重跑，因为记录已写入并提交）。

---

## 五、执行后验证

```sql
-- ① 迁移记录（应有 10 条，最后一条是 AddMessagesFulltextIndex）
SELECT timestamp, name FROM typeorm_migrations ORDER BY timestamp;

-- ② 缺失的表都建出来了吗
SELECT table_name FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN ('destroy_receipts','message_tombstones','message_destroy_acks','burn_settings');

-- ③ 关键字段
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND (table_name || '.' || column_name) IN ('x')  -- MySQL 不支持该写法，见下面逐条
  ;
```

逐条查更稳妥：

```sql
SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema=DATABASE() AND table_name='messages' AND column_name='destroyed_at';
SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema=DATABASE() AND table_name='devices' AND column_name='socket_count';
SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema=DATABASE() AND table_name='app_users' AND column_name='default_burn_ttl_seconds';

-- ④ FULLTEXT 索引（搜索接口依赖）
SELECT index_name, index_type, GROUP_CONCAT(column_name ORDER BY seq_in_index) cols
FROM information_schema.statistics
WHERE table_schema=DATABASE() AND table_name='messages' AND index_type='FULLTEXT'
GROUP BY index_name, index_type;
-- 期望：ft_messages_search  FULLTEXT  content,file_name
```

最后冒烟：

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:9091/api/v1/messages/search?keyword=项目" | head -c 300
# 期望 code=0，不再出现 1191
```

---

## 六、回滚

```bash
npm run migration:revert      # 只回滚最后一个
```

⚠️ **不要在线上靠 revert 回滚多个迁移**：`BurnV6SoftDelete.down()` 会删列删表，
已真删除的消息无法恢复。**首选恢复备份**。

---

## 七、常见错误

| 报错 | 原因 | 处理 |
|---|---|---|
| `Can't find FULLTEXT index matching the column list`（1191） | 漏 `1768100000000` | 跑迁移；新版代码也会自动降级 LIKE |
| `Duplicate column name 'xxx'` | 手工改过表且迁移无保护 | 本仓库迁移都有 `hasColumn` 判断，正常不会出现；出现说明改过迁移文件 |
| `Duplicate key name 'idx_xxx'` | 同上（索引已存在） | 手工 `DROP INDEX` 或给迁移加判断 |
| `Access denied ... PROCESS`（mysqldump） | 缺权限 | 加 `--no-tablespaces` |
| `Table already exists` | 表由 synchronize 建过 | 本仓库迁移都有 `hasTable` 判断 |
| 迁移卡住很久 | `messages` 很大，加 FULLTEXT / 加列在 rebuild | 低峰执行，观察 `SHOW PROCESSLIST` |

---

## 八、应急：只想让搜索先能用（不发布新版本）

```sql
ALTER TABLE messages
  ADD FULLTEXT INDEX ft_messages_search (content, file_name) WITH PARSER ngram;
```

- MySQL 8 的 ONLINE DDL，允许并发读写（大表仍会耗 IO）
- 重复执行报 `Duplicate key name` 即说明已建过
- 做完后**仍然建议补跑迁移**，否则 `typeorm_migrations` 里没有记录，
  下次发布还会把它当成"待执行"（虽然幂等，但会多一次无谓的 DDL 检查）

---

## 九、一句话流程

```
备份 → DB_SYNC=false → migration:run → 验证 FULLTEXT/表/字段 → 重启服务 → 冒烟搜索
```

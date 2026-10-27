# fenxin-backend 发布交接单（V6 版本）

> 交接给：运维
> 交付方：后端开发
> 版本提交：`d11942c`（分支 `master`）
> 仓库：https://github.com/LuoBeiLB/fenxin.git
> 预计耗时：10 分钟以内（数据库仅约 1MB）
> 服务影响：最后一次容器切换会重启，约 10 秒中断

---

## 一、这次发布最关键的一点

**数据库有 10 个迁移从来没执行过，必须先跑迁移，再切新镜像。**

新代码依赖以下新结构，缺了会导致**登录和消息接口直接 500**：

| 缺失对象 | 影响 |
|---|---|
| `devices.socket_count / online_at / offline_at` | 登录接口报 `Unknown column` |
| `messages.destroyed_at / destroy_reason` | 消息列表、搜索报错 |
| `app_users.default_burn_ttl_seconds` | 发消息报错 |
| `burn_settings` / `message_tombstones` / `message_destroy_acks` / `destroy_receipts` | 发消息、历史、焚毁流程报错 |
| `messages` 上的 FULLTEXT 索引 `ft_messages_search` | 全局搜索报 1191 |

迁移本身是**幂等**的（每个都先判断对象是否存在），以后每次发版带上都安全。

---

## 二、前置确认（只读，1 分钟）

```bash
# ① compose 服务名（后面所有命令都要用）
docker inspect fenxin-backend --format '{{index .Config.Labels "com.docker.compose.service"}}'
docker inspect fenxin-backend --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'

# ② 当前环境变量（记录现状，回滚时对照）
docker exec fenxin-backend printenv DB_SYNC DB_DATABASE DB_USERNAME SESSION_POLICY OSS_ENABLED JPUSH_ENABLED

# ③ 当前镜像（记录 ID，便于回滚）
docker images --format '{{.Repository}}:{{.Tag}}  {{.CreatedAt}}  {{.ID}}' | grep fenxin-backend

# ④ 本次上线会影响多少存量消息（预期 0）
docker exec -e MYSQL_PWD='<数据库密码>' fenxin-mysql mysql -ufenxin -N -B yy -e \
  "SELECT COUNT(*) FROM messages WHERE is_destroyed=0 AND destroy_at IS NOT NULL AND destroy_at<=NOW();"
```

> 下文里 `<服务名>` 请替换为第 ① 步查到的值（例如 `app` / `backend` / `fenxin-backend`）。

---

## 三、执行步骤

### 步骤 1：备份数据库（**不能跳过**）

```bash
docker exec -i -e MYSQL_PWD='<数据库密码>' fenxin-mysql \
  mysqldump -ufenxin --no-tablespaces --single-transaction --quick --skip-lock-tables \
    --default-character-set=utf8mb4 --routines --triggers --set-gtid-purged=OFF yy \
| gzip > /tmp/yy_before_v6_$(date +%F_%H%M).sql.gz

ls -lh /tmp/yy_before_v6_*.sql.gz
```

**验证点**：文件存在且大小不为 0。

---

### 步骤 2：把 `DB_SYNC` 改为 `false`

```bash
cd <compose 目录>
grep -n 'DB_SYNC' .env docker-compose.yml 2>/dev/null
```

把 `DB_SYNC=true` 改成 `DB_SYNC=false`。

**为什么必须改**：`synchronize` 会自动改表，与迁移冲突；实测它会**删掉迁移创建的索引**（例如 `idx_devices_online`、FULLTEXT 索引）。

---

### 步骤 3：拉代码并构建新镜像

```bash
cd <仓库目录>
git fetch origin master
git checkout master
git pull
git log -1 --oneline          # 期望显示 d11942c fix(search): 修复 where() 清空过滤条件…
```

```bash
docker compose build <服务名>
```

**验证点**：

```bash
docker run --rm fenxin-backend:latest sh -c 'ls /app/dist/database/migrations/*.js | wc -l'
# 期望 10

docker run --rm fenxin-backend:latest sh -c 'ls -l /app/dist/database/data-source.js'
# 期望文件存在
```

> 说明：本次 `Dockerfile` 从 pnpm 改为 npm（仓库里只有 `package-lock.json`）。
> 若构建流水线里写死了 pnpm 步骤，需要一并调整，否则构建会失败并报
> `ERR_PNPM_NO_LOCKFILE`。

---

### 步骤 4：执行数据库迁移（用新镜像）

使用 `docker compose run`，会自动带上 compose 里已有的数据库账号/网络，**不需要额外提供密码**：

```bash
cd <compose 目录>
docker compose run --rm <服务名> \
  node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
```

**验证点**：输出 10 条

```
Migration AddDestroyReceipts1709000000000 has been executed successfully.
...
Migration AddMessagesFulltextIndex1768100000000 has been executed successfully.
```

> 此时线上仍然是旧版本、旧容器在服务，不受影响。

---

### 步骤 5：验证数据库结构（4 个数字，全对才能继续）

```bash
docker exec -e MYSQL_PWD='<数据库密码>' fenxin-mysql mysql -ufenxin -N -B yy -e "
SELECT 'migrations', COUNT(*) FROM typeorm_migrations
UNION ALL SELECT 'tables', COUNT(*) FROM information_schema.tables
  WHERE table_schema='yy'
    AND table_name IN ('destroy_receipts','message_tombstones','message_destroy_acks','burn_settings')
UNION ALL SELECT 'devices_cols', COUNT(*) FROM information_schema.columns
  WHERE table_schema='yy' AND table_name='devices'
    AND column_name IN ('socket_count','online_at','offline_at')
UNION ALL SELECT 'fulltext', COUNT(*) FROM information_schema.statistics
  WHERE table_schema='yy' AND table_name='messages' AND index_type='FULLTEXT';"
```

**期望输出**：

```
migrations      10
tables           4
devices_cols     3
fulltext         1
```

**任何一项不对 → 停在这里，先反馈，不要切容器**（此时线上仍是旧版，安全）。

---

### 步骤 6：切换到新版本

```bash
cd <compose 目录>
docker compose up -d <服务名>
```

```bash
sleep 8
docker ps --filter name=fenxin-backend --format '{{.Names}} {{.Status}}'
curl -s http://127.0.0.1:9091/api/v1/health
docker logs --tail 40 fenxin-backend
```

**验证点**：

- 健康检查返回 `200`
- 启动日志出现 `Nest application successfully started`
- 日志**不出现**以下任一：
  - `Unknown column '...'`
  - `Can't find FULLTEXT index matching the column list`（1191）
  - `ECONNREFUSED`

```bash
docker logs fenxin-backend 2>&1 | grep -iE 'unknown column|1191|ECONNREFUSED' || echo "✅ 无结构/连接错误"
```

---

### 步骤 7：观察 10 分钟

```bash
docker logs -f --since 5m fenxin-backend 2>&1 | grep -iE 'error|1191|unknown column'
```

正常应能看到：

- `[Push] push enabled/disabled: ...`（推送配置状态）
- `Preserve sweep` / `Purge sweep done`（定时任务在运行）
- 接口访问日志无 5xx

---

## 四、验收标准（请回报这 6 项）

| # | 项目 | 期望 |
|---|---|---|
| 1 | `typeorm_migrations` 记录数 | `10` |
| 2 | 新表数量 | `4` |
| 3 | `devices` 新增字段数 | `3` |
| 4 | `messages` FULLTEXT 索引 | `1` |
| 5 | `GET /api/v1/health` | `HTTP 200` |
| 6 | 日志错误扫描 | 无 `unknown column` / `1191` / `ECONNREFUSED` |

可选的只读冒烟（需要测试账号，由开发提供）：

```bash
cd <仓库目录>
BASE=http://127.0.0.1:9091/api/v1 PHONE='<测试账号>' PASS='<测试密码>' KW='<常用词>' \
MYSQL_CONTAINER=fenxin-mysql MYSQL_PASS='<数据库密码>' DB=yy BACKEND_CONTAINER=fenxin-backend \
sh scripts/test-rehearsal.sh --no-write
```

`--no-write` 表示只读：不会发消息、不改数据。

---

## 五、回滚

| 场景 | 操作 |
|---|---|
| 新容器起不来 / 接口 500 | 切回上一版镜像：`docker compose up -d <服务名>`（使用之前记录的镜像标签），或先 `docker tag <旧镜像ID> fenxin-backend:latest` 再 up |
| 数据异常 | 恢复备份：`gunzip -c /tmp/yy_before_v6_*.sql.gz \| docker exec -i -e MYSQL_PWD='<数据库密码>' fenxin-mysql mysql -ufenxin yy` |
| 迁移执行中断 | 修复原因后**重跑**迁移命令即可（已成功的不会重复执行） |

**重要**：本次迁移只做「加表 / 加列 / 加索引 / 删除 3 个已废弃冗余列」，
旧版本代码可以在新结构上继续运行。因此最坏情况只需**回滚镜像**，不需要回滚数据库。

---

## 六、注意事项（请不要做这些）

| ✗ 不要 | 原因 |
|---|---|
| 不要用 `DB_SYNC=true` 启动新版本 | 会与迁移抢改表、删掉迁移建的索引 |
| 不要在没备份的情况下跑迁移 | 唯一的数据退路 |
| 不要在步骤 5 验证不通过时切容器 | 此时线上仍是旧版，切了才会出问题 |
| 不要重新生成 `JWT_SECRET` / `JWT_REFRESH_SECRET` | 会导致所有用户被强制登出 |
| 不要重新生成 `DESTROY_RECEIPT_SECRET` | 已有销毁回执的签名校验会失效 |
| 不要手工改表结构"修一下" | 结构与实体不一致会导致 500，请先反馈 |
| 不要把生产 OSS / 极光凭证配到测试环境（反之亦然） | 会误删生产附件、给真实用户发推送 |

---

## 七、本次迁移清单（供了解，无需逐条执行）

| # | 迁移 | 作用 |
|---|---|---|
| 1 | `1709000000000-AddDestroyReceipts` | 新建 `destroy_receipts`（销毁审计回执） |
| 2 | `1767300000000-AddAppVersions` | `app_versions` 表（App 自更新，已存在则跳过） |
| 3 | `1767400000000-AddUserTopic` | `app_users.topic`（主题色，已存在则跳过） |
| 4 | `1767500000000-AddMessageMentions` | `messages.mentions`（已存在则跳过） |
| 5 | `1767600000000-AddMediaDuration` | `messages.media_duration`（已存在则跳过） |
| 6 | `1767700000000-AddUserBurnPreference` | `app_users.default_burn_ttl_seconds` |
| 7 | `1767800000000-BurnV6SoftDelete` | 焚毁软删字段 + 墓碑表 + 确认表 + 扫描索引；删除 3 个废弃冗余列 |
| 8 | `1767900000000-AddDevicePresence` | `devices.socket_count / online_at / offline_at` + 索引；历史在线状态复位为离线 |
| 9 | `1768000000000-AddBurnSettings` | 新建 `burn_settings`（按人/按会话的焚毁时长） |
| 10 | `1768100000000-AddMessagesFulltextIndex` | `messages` 上的 FULLTEXT 索引（`WITH PARSER ngram`，中文搜索依赖） |

---

## 八、常见错误对照

| 报错 | 原因 | 处理 |
|---|---|---|
| `Unknown column 'devices.socket_count'` | 迁移没跑就切了新版本 | 步骤 4 跑迁移，步骤 5 验证 |
| `Can't find FULLTEXT index matching the column list`（1191） | FULLTEXT 索引缺失 | 确认迁移 10 已执行；且 `DB_SYNC=false` |
| `ERR_PNPM_NO_LOCKFILE`（构建阶段） | 用的还是旧 Dockerfile（pnpm） | 确认 `git log -1` 是 `d11942c`，`grep -c "npm ci" Dockerfile` 应 ≥1 |
| `Duplicate column name` | 手工改过表且迁移无保护 | 正常不会出现，出现请反馈（不要自行删列） |
| `Access denied; ... PROCESS privilege`（mysqldump） | 缺权限 | 命令里已带 `--no-tablespaces`，仍报错请换更高权限账号 |
| `ER_NO_SUCH_TABLE typeorm_migrations` | 迁移还没开始 | 正常，第一次跑迁移会自动创建 |

---

## 九、联络

- 部署过程中任何一步验证不通过：**先停手**，把该步骤的完整输出发给开发确认
- 回报内容建议直接贴：步骤 5 的 4 个数字 + 步骤 6 的健康检查结果 + 日志错误扫描结果

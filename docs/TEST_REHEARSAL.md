# 测试环境发布演练（一次执行）

> 目标：在**生产库的副本**上验证「新镜像 + 10 个迁移 + 新接口」全部正常，确认无误后再对生产执行。
> 脚本：`scripts/test-rehearsal.sh`（只依赖 `curl` + `docker`，无需 node/jq/python）

---

## 0. 前置条件（都做完再跑）

```bash
# ① MySQL 容器在跑
docker ps --filter name=fenxin-mysql-test --format '{{.Names}} {{.Status}}'

# ② 已导入生产数据副本（12 张表）
docker exec -e MYSQL_PWD='TestRoot@2026' fenxin-mysql-test mysql -uroot -N -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='yy';"   # 期望 12

# ③ 迁移已跑（10 条记录）
docker exec -e MYSQL_PWD='TestRoot@2026' fenxin-mysql-test mysql -uroot -N -e \
  "SELECT COUNT(*) FROM yy.typeorm_migrations;"                                # 期望 10

# ④ 后端容器在跑
docker ps --filter name=fenxin-backend-test --format '{{.Names}} {{.Status}}'
curl -s http://127.0.0.1:19091/api/v1/health
```

---

## 1. 把脚本传到测试服务器

脚本在仓库里（本机路径 `scripts/test-rehearsal.sh`）。

```powershell
# Windows PowerShell（在你本机执行）
scp C:\Users\HS\Desktop\fenxin-server\scripts\test-rehearsal.sh zzzzz@<测试IP>:~/zzz-test/fenxin/scripts/
```

或者测试服务器上的代码是 git 克隆的话：

```bash
cd ~/zzz-test/fenxin && git pull
```

---

## 2. 先做语法检查（1 秒）

```bash
cd ~/zzz-test/fenxin
sh -n scripts/test-rehearsal.sh && echo "语法 OK"
```

---

## 3. 一次执行

```bash
cd ~/zzz-test/fenxin
chmod +x scripts/test-rehearsal.sh

BASE=http://127.0.0.1:19091/api/v1 \
PHONE=13800000000 \
PASS='Test@123456' \
KW='核对' \
MYSQL_CONTAINER=fenxin-mysql-test \
MYSQL_PASS='TestRoot@2026' \
DB=yy \
BACKEND_CONTAINER=fenxin-backend-test \
sh scripts/test-rehearsal.sh
```

**只看不改**（生产冒烟用）：

```bash
... sh scripts/test-rehearsal.sh --no-write
```

**只测接口**（不想连库）：

```bash
... sh scripts/test-rehearsal.sh --skip-db
```

---

## 4. 它检查什么（共 13 项）

| # | 检查 | 期望 |
|---|---|---|
| 1 | `GET /health` | 200 |
| 2 | `POST /auth/login` | 200/201，拿到 token |
| 3 | `GET /auth/devices` | 200（devices 新字段没缺） |
| 4 | `GET /presence/me` | 200 |
| 5 | `GET /conversations` | 200，能取到会话 ID |
| 6 | `GET /messages/:cid` | 200（**不报 Unknown column**） |
| 7 | `GET /messages/:cid?include_destroyed=1` | 200 |
| 8 | `GET /messages/search?keyword=` | 200，`total` 有值 |
| 9 | 后端日志 | 无「降级为 LIKE」/`unknown column`/`1191` |
| 10 | `POST /messages`（普通 + 焚毁） | 200/201 |
| 11 | `POST /messages/:cid/read-messages` | 200/201，`marked` 有值 |
| 12 | `GET /messages/:id/receipt` | 200，含 `is_sender` |
| 13 | `GET /messages/:id/readers` | **404**（已下线） |
| DB-1 | `typeorm_migrations` | 10 条 |
| DB-2 | 新表 | 4 张 |
| DB-3 | `devices` 在线字段 | 3 个 |
| DB-4 | `messages` FULLTEXT | 存在 |
| DB-5 | 焚毁影响面 | 打印 3 个数字，供评估 |

---

## 5. 正常输出长这样

```
发布演练自检
  接口   http://127.0.0.1:19091/api/v1
  账号   13800000000
  关键词 核对
  数据库 root@fenxin-mysql-test/yy
  写操作：开启（会发消息）

== 1. 服务可用性 ==
  ✓ GET /health HTTP 200

== 2. 登录 ==
  ✓ POST /auth/login token 208 字符

== 3. 设备 / 在线状态（devices 新字段） ==
  ✓ GET /auth/devices HTTP 200
  ✓ GET /presence/me HTTP 200

== 4. 会话与历史（messages 新字段） ==
  ✓ GET /conversations 会话 17facebd-...
  ✓ GET /messages/:cid HTTP 200
  ✓ GET /messages/:cid?include_destroyed=1 HTTP 200

== 5. 搜索（FULLTEXT 索引） ==
  ✓ GET /messages/search keyword=核对 total=3
  ✓ FULLTEXT 索引 无降级迹象
  ✓ 后端日志 无结构/连接错误

...

== 9. 焚毁影响面（生产上线后的第一批变化） ==
  焚毁消息总数        12
  已标记焚毁          0
  上线即被焚毁        0  ← 生产上线后 1 分钟内会变化的消息数

✓ 全部通过（16 项）
```

> **`上线即被焚毁` 这个数字要记下来**：它就是生产上线后 1 分钟内会变成「已焚毁」的消息数量，提前告诉产品/客服。

---

## 6. 失败时怎么办

| 失败项 | 原因 | 处理 |
|---|---|---|
| `GET /health` 超时 | 容器没起来/端口不对 | `docker logs --tail 100 fenxin-backend-test` |
| 登录失败 | 密码不对 / 账号被停用 | 见下面「重置密码」 |
| `GET /messages/:cid` 报 Unknown column | 迁移没跑或镜像太旧 | `docker exec fenxin-backend-test sh -c 'ls /app/dist/database/migrations/*.js \| wc -l'` 应为 10 |
| 搜索 200 但日志有「降级为 LIKE」 | FULLTEXT 索引缺失 | 跑迁移 `1768100000000`；确认没开 `DB_SYNC=true` |
| `readers` 返回 200 | 镜像是旧版本 | 重新 `docker build` |
| `receipt` 缺 `is_sender` | 同上 | 重新构建 |
| 迁移记录 ≠ 10 | 迁移未跑完 | 重跑 `migration:run`，看完整输出 |
| 新表 ≠ 4 | 同上 | 同上 |

---

## 7. 重置测试账号密码（明文 `Test@123456`）

```bash
docker exec -i -e MYSQL_PWD='TestRoot@2026' fenxin-mysql-test \
  mysql -uroot --default-character-set=utf8mb4 yy <<'SQL'
UPDATE app_users
   SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$mtrqQn5MpEVlfw4Xo4uTTQ$oH6JnwvKcbDJYg8rlKYhXX/GBhWJPYkJaLckWgFYKoE',
       force_change_pwd = 0, login_fail_count = 0, status = 'active'
 WHERE phone = '13800000000';
SQL
```

> **终端多行粘贴会丢字符时**，改成一行（注意整条用单引号，`$` 不会被 shell 展开）：
>
> ```bash
> docker exec -e MYSQL_PWD='TestRoot@2026' fenxin-mysql-test mysql -uroot --default-character-set=utf8mb4 yy -e 'UPDATE app_users SET password_hash="$argon2id$v=19$m=65536,t=3,p=4$mtrqQn5MpEVlfw4Xo4uTTQ$oH6JnwvKcbDJYg8rlKYhXX/GBhWJPYkJaLckWgFYKoE", force_change_pwd=0, login_fail_count=0, status="active" WHERE phone="13800000000";'
> ```

查账号列表：

```bash
docker exec -e MYSQL_PWD='TestRoot@2026' fenxin-mysql-test \
  mysql -uroot --default-character-set=utf8mb4 -t yy -e \
  "SELECT phone, display_name, role, status FROM app_users LIMIT 10;"
```

---

## 8. 中文显示成问号？

**先判断是显示问题还是数据坏了**（看 HEX，不看字符）：

```bash
docker exec -e MYSQL_PWD='TestRoot@2026' fenxin-mysql-test \
  mysql -uroot --default-character-set=utf8mb4 -t yy -e \
  "SELECT id, LEFT(content,10) AS txt, HEX(LEFT(content,3)) AS hex3 FROM messages WHERE content IS NOT NULL LIMIT 3;"
```

| hex3 | 结论 |
|---|---|
| `E4BDA0...` 之类 | ✅ 数据是好的 → 加上 `--default-character-set=utf8mb4` 和 `-e LANG=C.UTF-8` 就能正常显示 |
| `3F3F3F` | ❌ 数据真的变成问号了 → 重新导入（dump 和 import 两端都要带 `--default-character-set=utf8mb4`） |

---

## 9. 演练通过后，生产照同一套执行

```bash
# ① 备份
docker exec -i -e MYSQL_PWD='生产密码' fenxin-mysql \
  mysqldump -ufenxin --no-tablespaces --single-transaction --quick --skip-lock-tables \
    --default-character-set=utf8mb4 --routines --triggers --set-gtid-purged=OFF yy \
| gzip > /tmp/yy_before_migrate_$(date +%F_%H%M).sql.gz

# ② DB_SYNC 改 false（改 compose environment，然后重建容器）

# ③ 迁移（确认镜像里是 10 个迁移文件）
docker exec fenxin-backend sh -c 'ls /app/dist/database/migrations/*.js | wc -l'
docker exec fenxin-backend node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js

# ④ 用同一个脚本验收生产（只读模式）
BASE=http://127.0.0.1:9091/api/v1 PHONE=<生产测试账号> PASS='***' KW='<常用词>' \
MYSQL_CONTAINER=fenxin-mysql MYSQL_PASS='<生产密码>' DB=yy BACKEND_CONTAINER=fenxin-backend \
sh scripts/test-rehearsal.sh --no-write

# ⑤ 重建后端到新镜像
docker compose up -d --force-recreate fenxin-backend
```

---

## 10. 清理演练环境

```bash
docker rm -f fenxin-backend-test
# 副本库留着也行（1MB），要删：
# docker exec -e MYSQL_PWD='TestRoot@2026' fenxin-mysql-test mysql -uroot -e "DROP DATABASE yy;"
```

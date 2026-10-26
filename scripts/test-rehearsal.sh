#!/bin/sh
# ============================================================
# 测试环境发布演练自检（一次跑完）
#
# 做两件事：
#   ① 接口冒烟：健康 / 登录 / 设备 / 在线 / 会话 / 历史 / 墓碑 /
#               搜索 / 发消息 / 发焚毁消息 / 按 id 已读 / 回执 / readers 应 404
#   ② 数据库核对：迁移记录数、新表、新字段、FULLTEXT 索引、焚毁影响面
#
# 只依赖 curl + docker（POSIX sh，不需要 jq / python / node）
#
# 用法：
#   ./scripts/test-rehearsal.sh                      # 用下面的默认值
#   ./scripts/test-rehearsal.sh --no-write           # 只读，不发消息
#   ./scripts/test-rehearsal.sh --skip-db            # 跳过数据库检查
#
# 也可用环境变量覆盖：
#   BASE=http://127.0.0.1:19091/api/v1
#   PHONE=13800000000  PASS='Test@123456'  KW='核对'
#   MYSQL_CONTAINER=fenxin-mysql-test  MYSQL_PASS='TestRoot@2026'  DB=yy
#   BACKEND_CONTAINER=fenxin-backend-test
#
# 退出码：0 全通过；1 有失败项
# ============================================================
set -u

BASE="${BASE:-http://127.0.0.1:19091/api/v1}"
PHONE="${PHONE:-13800000000}"
PASS="${PASS:-Test@123456}"
KW="${KW:-核对}"

MYSQL_CONTAINER="${MYSQL_CONTAINER:-fenxin-mysql-test}"
MYSQL_PASS="${MYSQL_PASS:-TestRoot@2026}"
MYSQL_USER="${MYSQL_USER:-root}"
DB="${DB:-yy}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-fenxin-backend-test}"

WRITE=1
SKIP_DB=0
for a in "$@"; do
  case "$a" in
    --no-write) WRITE=0 ;;
    --skip-db)  SKIP_DB=1 ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$a"; exit 2 ;;
  esac
done

PASS_CNT=0
FAIL_CNT=0
FAILED_LIST=""

ok()   { PASS_CNT=$((PASS_CNT+1)); printf '  \033[32m✓\033[0m %s %s\n' "$1" "${2:-}"; }
bad()  { FAIL_CNT=$((FAIL_CNT+1)); FAILED_LIST="$FAILED_LIST
   - $1"; printf '  \033[31m✗\033[0m %s %s\n' "$1" "${2:-}"; }
head_() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
dim()  { printf '  \033[2m%s\033[0m\n' "$1"; }

# 从 JSON 里取第一个 "id":"..."
first_id() { grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
num_field() { grep -o "\"$1\":[0-9]*" | head -1 | cut -d: -f2; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# ------------------------------------------------------------
printf '\n\033[1m发布演练自检\033[0m\n'
printf '  接口   %s\n' "$BASE"
printf '  账号   %s\n' "$PHONE"
printf '  关键词 %s\n' "$KW"
printf '  数据库 %s@%s/%s\n' "$MYSQL_USER" "$MYSQL_CONTAINER" "$DB"
[ "$WRITE" = "1" ] && dim '写操作：开启（会发消息）' || dim '写操作：关闭（--no-write）'

# ------------------------------------------------------------
head_ "1. 服务可用性"
CODE=$(http_code "$BASE/health" || echo 000)
[ "$CODE" = "200" ] && ok "GET /health" "HTTP $CODE" || { bad "GET /health" "HTTP $CODE（服务没起来？）"; printf '\n\033[31m服务不可达，终止\033[0m\n'; exit 1; }

# ------------------------------------------------------------
head_ "2. 登录"
LOGIN_JSON=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"password\":\"$PASS\",\"device_name\":\"rehearsal\",\"device_type\":\"web\",\"device_id\":\"fp-rehearsal\"}")
TOKEN=$(printf '%s' "$LOGIN_JSON" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
if [ -n "$TOKEN" ]; then
  ok "POST /auth/login" "token ${#TOKEN} 字符"
else
  bad "POST /auth/login" "$(printf '%s' "$LOGIN_JSON" | head -c 200)"
  printf '\n\033[31m登录失败，后续检查跳过\033[0m\n'
  printf '  提示：确认账号密码；必要时用 SQL 重置密码（见 docs/TEST_REHEARSAL.md）\n'
  exit 1
fi
AUTH="Authorization: Bearer $TOKEN"

# ------------------------------------------------------------
head_ "3. 设备 / 在线状态（devices 新字段）"
CODE=$(http_code -H "$AUTH" "$BASE/auth/devices")
[ "$CODE" = "200" ] && ok "GET /auth/devices" "HTTP $CODE" || bad "GET /auth/devices" "HTTP $CODE"
CODE=$(http_code -H "$AUTH" "$BASE/presence/me")
[ "$CODE" = "200" ] && ok "GET /presence/me" "HTTP $CODE" || bad "GET /presence/me" "HTTP $CODE"

# ------------------------------------------------------------
head_ "4. 会话与历史（messages 新字段）"
CONV_JSON=$(curl -s -H "$AUTH" "$BASE/conversations")
CID=$(printf '%s' "$CONV_JSON" | first_id)
if [ -n "$CID" ]; then
  ok "GET /conversations" "会话 $CID"
else
  bad "GET /conversations" "$(printf '%s' "$CONV_JSON" | head -c 200)"
fi

if [ -n "${CID:-}" ]; then
  HIST=$(curl -s -H "$AUTH" "$BASE/messages/$CID?limit=3")
  if printf '%s' "$HIST" | grep -q '"code":0'; then
    ok "GET /messages/:cid" "HTTP 200"
  else
    bad "GET /messages/:cid" "$(printf '%s' "$HIST" | head -c 200)"
  fi

  TOMB=$(curl -s -H "$AUTH" "$BASE/messages/$CID?limit=3&include_destroyed=1")
  if printf '%s' "$TOMB" | grep -q '"code":0'; then
    ok "GET /messages/:cid?include_destroyed=1" "HTTP 200"
  else
    bad "GET /messages/:cid?include_destroyed=1" "$(printf '%s' "$TOMB" | head -c 200)"
  fi
fi

# ------------------------------------------------------------
head_ "5. 搜索（FULLTEXT 索引）"
SEARCH=$(curl -s -H "$AUTH" "$BASE/messages/search?keyword=$KW")
if printf '%s' "$SEARCH" | grep -q '"code":0'; then
  TOTAL=$(printf '%s' "$SEARCH" | num_field total)
  ok "GET /messages/search" "keyword=$KW total=${TOTAL:-?}"
  [ "${TOTAL:-0}" = "0" ] && dim '（该关键词没命中，换 KW 再试）'
else
  bad "GET /messages/search" "$(printf '%s' "$SEARCH" | head -c 250)"
fi

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$BACKEND_CONTAINER"; then
  if docker logs "$BACKEND_CONTAINER" 2>&1 | grep -q '降级为 LIKE'; then
    bad "FULLTEXT 索引" '日志出现「降级为 LIKE」→ 索引没建，跑迁移 1768100000000'
  else
    ok "FULLTEXT 索引" '无降级迹象'
  fi
  if docker logs "$BACKEND_CONTAINER" 2>&1 | grep -qiE 'unknown column|ER_CANT_FIND_FULLTEXT|ECONNREFUSED'; then
    bad "后端日志" '出现 unknown column / 全文索引 / 连接错误'
  else
    ok "后端日志" '无结构/连接错误'
  fi
else
  dim "（容器 $BACKEND_CONTAINER 不在本机，跳过日志检查）"
fi

# ------------------------------------------------------------
if [ "$WRITE" = "1" ] && [ -n "${CID:-}" ]; then
  head_ "6. 发消息"
  SEND=$(curl -s -X POST "$BASE/messages" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"conversation_id\":\"$CID\",\"type\":\"text\",\"content\":\"[演练] ok\"}")
  if printf '%s' "$SEND" | grep -q '"code":0'; then
    ok "POST /messages（普通）" 'HTTP 200/201'
  else
    bad "POST /messages（普通）" "$(printf '%s' "$SEND" | head -c 250)"
  fi

  BURN=$(curl -s -X POST "$BASE/messages" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"conversation_id\":\"$CID\",\"type\":\"text\",\"content\":\"[演练-焚毁]\",\"burn_ttl_seconds\":60}")
  if printf '%s' "$BURN" | grep -q '"code":0'; then
    ok "POST /messages（焚毁 60s）" 'HTTP 200/201'
  else
    bad "POST /messages（焚毁 60s）" "$(printf '%s' "$BURN" | head -c 250)"
  fi

  # ----------------------------------------------------------
  head_ "7. 已读 / 回执 / 已删接口"
  MID=$(curl -s -H "$AUTH" "$BASE/messages/$CID?limit=1" | first_id)
  if [ -n "$MID" ]; then
    RM=$(curl -s -X POST "$BASE/messages/$CID/read-messages" -H "$AUTH" -H 'Content-Type: application/json' \
      -d "{\"message_ids\":[\"$MID\"]}")
    MARKED=$(printf '%s' "$RM" | num_field marked)
    if printf '%s' "$RM" | grep -q '"code":0'; then
      ok "POST /messages/:cid/read-messages" "marked=${MARKED:-?}"
    else
      bad "POST /messages/:cid/read-messages" "$(printf '%s' "$RM" | head -c 250)"
    fi

    RC=$(curl -s -H "$AUTH" "$BASE/messages/$MID/receipt")
    if printf '%s' "$RC" | grep -q '"is_sender"'; then
      ok "GET /messages/:id/receipt" '含 is_sender 字段'
    elif printf '%s' "$RC" | grep -q '"code":0'; then
      bad "GET /messages/:id/receipt" '缺少 is_sender 字段（镜像太旧？）'
    else
      bad "GET /messages/:id/receipt" "$(printf '%s' "$RC" | head -c 250)"
    fi

    CODE=$(http_code -H "$AUTH" "$BASE/messages/$MID/readers")
    [ "$CODE" = "404" ] && ok "GET /messages/:id/readers 已下线" "HTTP $CODE" \
                        || bad "GET /messages/:id/readers 应 404" "HTTP $CODE（镜像太旧？）"
  fi
else
  head_ "6-7. 写操作已跳过"
  dim '（--no-write 或没有会话）'
fi

# ------------------------------------------------------------
if [ "$SKIP_DB" = "0" ] && command -v docker >/dev/null 2>&1 \
   && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$MYSQL_CONTAINER"; then
  head_ "8. 数据库结构"
  q() { docker exec -e MYSQL_PWD="$MYSQL_PASS" "$MYSQL_CONTAINER" mysql -u"$MYSQL_USER" -N -B -e "$1" 2>/dev/null; }

  MIG=$(q "SELECT COUNT(*) FROM $DB.typeorm_migrations;")
  [ "${MIG:-0}" = "10" ] && ok "迁移记录" "$MIG 条" || bad "迁移记录" "期望 10，实际 ${MIG:-0}"

  NEWT=$(q "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB' AND table_name IN ('destroy_receipts','message_tombstones','message_destroy_acks','burn_settings');")
  [ "${NEWT:-0}" = "4" ] && ok "新表" "4 张" || bad "新表" "期望 4，实际 ${NEWT:-0}"

  NEWC=$(q "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$DB' AND table_name='devices' AND column_name IN ('socket_count','online_at','offline_at');")
  [ "${NEWC:-0}" = "3" ] && ok "devices 在线字段" "3 个" || bad "devices 在线字段" "期望 3，实际 ${NEWC:-0}"

  FT=$(q "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema='$DB' AND table_name='messages' AND index_type='FULLTEXT';")
  [ "${FT:-0}" -ge 1 ] && ok "FULLTEXT 索引" "存在" || bad "FULLTEXT 索引" "缺失（跑迁移 1768100000000）"

  # ----------------------------------------------------------
  head_ "9. 焚毁影响面（生产上线后的第一批变化）"
  STATS=$(q "SELECT
      (SELECT COUNT(*) FROM $DB.messages WHERE burn_ttl_seconds IS NOT NULL),
      (SELECT COUNT(*) FROM $DB.messages WHERE is_destroyed=1),
      (SELECT COUNT(*) FROM $DB.messages WHERE is_destroyed=0 AND destroy_at IS NOT NULL AND destroy_at<=NOW());")
  BURN_TOTAL=$(printf '%s' "$STATS" | awk '{print $1}')
  DESTROYED=$(printf '%s' "$STATS" | awk '{print $2}')
  WILL_BURN=$(printf '%s' "$STATS" | awk '{print $3}')
  printf '  焚毁消息总数        %s\n' "${BURN_TOTAL:-?}"
  printf '  已标记焚毁          %s\n' "${DESTROYED:-?}"
  printf '  \033[33m上线即被焚毁        %s\033[0m  ← 生产上线后 1 分钟内会变化的消息数\n' "${WILL_BURN:-?}"
else
  head_ "8-9. 数据库检查已跳过"
  dim '（--skip-db 或本机没有该 MySQL 容器）'
fi

# ------------------------------------------------------------
printf '\n'
if [ "$FAIL_CNT" = "0" ]; then
  printf '\033[32m✓ 全部通过（%s 项）\033[0m\n\n' "$PASS_CNT"
  exit 0
fi
printf '\033[31m✗ %s 项失败（通过 %s 项）\033[0m%s\n\n' "$FAIL_CNT" "$PASS_CNT" "$FAILED_LIST"
exit 1

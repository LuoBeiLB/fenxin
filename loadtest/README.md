# 压测脚本（k6）

V4.0 §M7 性能与质量 — 验证鉴权缓存、限流、登录路径性能。

## 安装 k6

- macOS: `brew install k6`
- Windows: `winget install k6` 或 `choco install k6`
- Linux: `sudo apt-get install k6`（k6 官方 APT 源）
- Docker: `docker run --rm -i grafana/k6 run - <script.js`

验证：`k6 version`

## 脚本清单

| 脚本 | 用途 | 关键指标 |
|---|---|---|
| `login-burst.js` | 压 `/api/v1/auth/login` | 限流（5/min/IP）边界 + argon2 verify + 2 次 SQL 写路径 |
| `api-mix.js` | 压鉴权缓存命中后的业务读 | p(95) < 200ms（cache 命中 0 SQL） |
| `e2e-send.js` | 压 E2E 加密消息发送 | p(95) < 400ms（密文 3 字段 + 强校验 + 阅后即焚） |
| `burn-encrypted.js` | 端到端：E2E 加密 + 阅后即焚 → 验证 destroyMessages 链路 | checks pass rate 100%（密文字段销毁后必须全清） |

## 跑法

### 0. 启动 NestJS 服务

```bash
# 本地
pnpm run start:dev

# 或 Docker
docker compose up -d
```

确认服务在 9091 端口跑着：
```bash
curl http://localhost:9091/api/v1/health
```

### 1. 压登录

```bash
# 默认（5 VU × 30s 跑 login，间隔 15s 错开 5/min 限流）
k6 run loadtest/login-burst.js

# 自定义
k6 run \
  -e BASE_URL=http://localhost:9091 \
  -e PHONE=13800000000 \
  -e PASSWORD='Test@123456' \
  loadtest/login-burst.js
```

观察：
- `http_req_failed` rate 期望 < 0.1（5/min 限流触发时会出现 429）
- `http_req_duration` p(95) 期望 < 800ms（首次登录含 argon2 verify）
- 关键看服务端 pino 日志里 `AuthCache` 是否在第一次 login 后没有 set（因为 login 路径不走 JwtAuthGuard）

### 2. 压业务读接口（验证 cache 命中）

```bash
# 默认：1 次 setup login + 10 VU × 30s 跑 mix 读
k6 run loadtest/api-mix.js
```

观察：
- `http_req_duration` p(95) 期望 < 200ms（JWT 守卫 0 SQL，cache 命中）
- `http_req_failed` rate 期望 < 0.05
- 对比：把 `.env` 的 `AUTH_CACHE_TTL_MS=0` 重启服务，p(95) 会涨到 300-500ms（每次 2 次 SQL）

### 3. 压 E2E 加密消息发送（验证 §E2E 方案 B 协议通道）

```bash
# 前置：准备 2 个账号（PHONE_B 需要先在超管后台或自助注册创建）
k6 run \
  -e BASE_URL=http://localhost:9091 \
  -e PHONE_A=13800000000 \
  -e PASSWORD_A='Test@123456' \
  -e PHONE_B=13800000001 \
  -e PASSWORD_B='Test@123456' \
  loadtest/e2e-send.js
```

观察：
- `http_req_duration` p(95) 期望 < 400ms（明文基础上 + 密文强校验 + 阅后即焚定时任务轻微干扰）
- `http_req_failed` rate 期望 < 0.2（5 VU 间隔 2s ≈ 150 req/min 略超 60/min 限流，预期少量 429）
- 服务端日志确认密文字段都落库（DB 查 `SELECT is_encrypted, cipher_nonce FROM messages WHERE conversation_id='...'` 验证）
- 响应 body 的 `data.is_encrypted` 必须为 `true`

注意：k6 不做真 X25519 加解密（需要客户端 Web Crypto API），本脚本只压服务端"接收密文 + 落库 + 强校验"通道，密码学正确性靠客户端实现 + E2E 集成测试。

### 4. 端到端：E2E 加密 + 阅后即焚（验证 §E2E 销毁完整性）

```bash
# 前置：服务跑着 + 2 个测试账号已就绪（同 §E2E 加密压测）
k6 run \
  -e BASE_URL=http://localhost:9091 \
  -e PHONE_A=13800000000 \
  -e PASSWORD_A='Test@123456' \
  -e PHONE_B=13800000001 \
  -e PASSWORD_B='Test@123456' \
  loadtest/burn-encrypted.js
```

观察：
- `checks` pass rate 期望 100%
- `http_req_failed` rate 期望 < 0.1
- 每个 VU 完整跑 ~80s（5s destroy_at + 60s burn scheduler tick + 5s 兜底 + setup IO）
- 销毁后消息字段必须：`is_encrypted=true`、`is_destroyed=true`、`cipher_text=null`、`cipher_nonce=null`、`sender_ephemeral_pubkey=null`（V4.0 §E2E 阅后即焚"焚"指消息整体，密文也算）

意义：除了 e2e-send 验证"加密落库"，本脚本验证"销毁链路不残留密文" — 这是服务端零持有密文的关键证明。

## 限流边界速查

| 限流 | 配置 | 单 IP 行为 |
|---|---|---|
| 全局 | ThrottlerModule `limit=300/60s` | 300 req/min |
| 登录 | Throttle `limit=5/60s` | 5 req/min（防手机号遍历） |
| 刷新 token | Throttle `limit=30/60s` | 30 req/min |
| 改密 | Throttle `limit=3/60s` | 3 req/min/用户 |

k6 本机单 IP 跑（127.0.0.1）会被全局 300/min 触发；超过就 429。

## 注意事项

- **不要在生产环境跑**：压测会刷数据库表（device 增长 + heartbeat 写）
- **device 增长**：login-burst 每次创 device → 单用户设备列表会爆。定期清理：
  ```sql
  DELETE FROM device WHERE user_id = '<测试用户id>' AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR);
  ```
- **token 过期**：access token 默认 7 天。api-mix 跑 30s 不会过期；长时间跑需在 setup 里处理 refresh

## 下一步

- 多实例：起 2 个 app 实例（端口 9091/9092），验证 socket.io Redis Adapter（待批次 C-3 部署 Redis 后再做）
- E2E：登录 → 发消息 → 接收方确认 → 阅后即焚 → 删除，全链路剧本（脚本待写）

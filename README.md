# 焚信 BurnMsg 后端

企业内部加密通讯应用后端：阅后即焚 + WebSocket 实时推送 + 端到端加密（E2EE）+ 完整管理后台。

NestJS 10 + TypeORM + MySQL 8，接口文档见 Swagger（`/api-docs`，46 个接口全中文文档）。

## 功能特性

**核心通讯**
- 单聊 / 群聊，消息类型：文本、图片、语音、视频、文件
- 点开才焚（阅后即焚 v2）：焚毁消息全员先收马赛克占位，调 `POST /messages/:id/reveal` 点开才下发内容，各自独立倒计时焚毁；兜底超时（`BURN_FALLBACK_TTL_HOURS`，默认 24h）强制销毁；`BurnScheduler` 每分钟扫描物理删除（全员看完提前删）
- 消息编辑、撤回、已读回执
- WebSocket 实时推送（socket.io v4）：新消息 / 编辑 / 撤回 / 已读回执 / 会话变更 / 设备上下线，详见 [docs/websocket-events.md](docs/websocket-events.md)

**安全**
- 端到端加密（E2EE，单聊）：X25519 密钥协商 + HKDF-SHA256 + AES-256-GCM，服务器只存公钥和密文，协议见 [docs/E2E_ENCRYPTION.md](docs/E2E_ENCRYPTION.md)
- JWT 双密钥认证：access token（2h）+ refresh token（30d，独立密钥）
- Argon2id 密码哈希；登录限流 5 次/分钟/IP；全局 300 次/分钟
- JWT 守卫每请求校验账号状态与设备存在性：停用账号 / 下线设备立即吊销
- 首次登录强制改密（`force_change_pwd` 白名单拦截）
- 全量审计日志（操作人、动作、IP、User-Agent）

**管理后台**
- 数据总览：12 项指标（用户 / 会话 / 消息 / 存储用量）
- 账号管理：开通（仅后台开通，无自助注册）、Excel 批量导入、停用（群不受影响，恢复启用即还原）、**软删除**（注销时级联解散其为群主的全部群，解散即焚）
- 群组管理：全量群组列表（含已解散）、**管理员强制解散（留痕）**
- 系统公告：发布 / 撤回 / 已读统计 / 未读角标，支持 urgent 强提醒
- 意见反馈：用户提交意见，管理后台查看 / 回复（回复即处理）
- 群主解散群 = 解散即焚（消息一并销毁），与管理员强制解散（留痕）语义区分

**工程化**
- pino 结构化日志；auth 30s 缓存
- Jest 单元/集成测试；k6 压测脚本（`loadtest/`）
- TypeORM migration 流程（`migration:*` 脚本）
- Dockerfile + docker-compose 一键部署

## 技术栈

| 项 | 选型 |
|----|------|
| 框架 | NestJS 10 |
| ORM | TypeORM 0.3（`synchronize` 由 `DB_SYNC` 控制，**生产必须 false**） |
| 数据库 | MySQL 8（utf8mb4） |
| 实时 | socket.io v4（path `/api/v1/socket.io`） |
| 密码哈希 | Argon2id |
| 认证 | JWT 双密钥 |
| 日志 | nestjs-pino |
| 测试 | Jest + supertest；k6 压测 |
| 文档 | Swagger（优先加载 `openapi.yaml`，46 接口 / 13 分组） |

## 快速开始

### 全新部署

```bash
cp .env.example .env   # 修改数据库连接与两个 JWT 密钥（必须不同）
npm ci
# 首次部署：.env 设 DB_SYNC=true，启动一次自动建表，然后立即改回 false
npm run build
npm run start:prod     # 开发热更用 npm run start:dev
```

启动后：
- API 前缀：`http://<host>:9091/api/v1`
- Swagger：`http://<host>:9091/api-docs`（`SWAGGER_ENABLED=true` 时）
- 初始管理员按 `INITIAL_ADMIN_PHONE` 创建，密码见启动日志（仅打印一次），首次登录强制改密

### 老库升级（v4 之前 → 当前版本）

`DB_SYNC=false` 下 TypeORM 不会自动改表，需执行增量迁移：

```bash
mysql -u root -p burnmsg < docs/migration-20260827.sql
mysql -u root -p burnmsg < docs/migration-20260827-feedback.sql   # 意见反馈表（v5.3 新增）
mysql -u root -p burnmsg < docs/migration-20260828-group-role-cleanup.sql   # 存量群管理员降级为成员（v5.5，无 admin 记录则无影响）
mysql -u root -p burnmsg < docs/migration-20260831-burn-on-read.sql   # 点开才焚（v5.6：burn_ttl_seconds + 回执 revealed_at/burn_at）
```

内容为：软删除列、群解散列、消息 4 个加密列、公告 / 公告已读 / 用户公钥三张新表；feedback.sql 再补意见反馈表。**重复执行会报"列已存在"，忽略即可。**

也可以用标准 migration 流程：`npm run migration:run`（生成新迁移用 `npm run migration:generate <name>`）。

### Docker

```bash
docker compose up -d --build
```

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 服务端口 | `9091` |
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` | MySQL 连接 | - |
| `DB_SYNC` | 首次建表 `true`，**正式运行必须 `false`** | `true` |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | 两个密钥**必须不同**，生产换随机长串 | - |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | token 有效期（秒） | `7200` / `2592000` |
| `CORS_ORIGINS` | 跨域白名单（逗号分隔；空 = 禁止一切浏览器跨域） | - |
| `UPLOAD_DIR` | 文件上传目录 | `./uploads` |
| `BURN_FALLBACK_TTL_HOURS` | 点开才焚兜底强制焚毁时间（小时）：超期未被全员点开看完的焚毁消息强制物理删除 | `24` |
| `SWAGGER_ENABLED` | 是否开放 `/api-docs`，**生产建议 false** | `true` |
| `INITIAL_ADMIN_PHONE` / `INITIAL_ADMIN_PASSWORD` | 初始管理员（仅无任何 admin 时首次生效；密码留空则随机生成打印日志） | - |

## 接口概览

完整文档见 Swagger `/api-docs` 或仓库根目录 `openapi.yaml`（46 接口 / 13 分组）。

| 分组 | 代表接口 |
|------|---------|
| 认证 | 登录 / 刷新 token / 改密 / 设备列表 / 设备下线 |
| 账号 | 列表（含 `show_deleted`）/ 开通 / 导入 / 停用 / 软删除 |
| 会话 | 单聊创建 / 我的会话 / 会话详情 |
| 群组 | 建群 / 成员管理（仅群主；系统管理员可跨群查看与移除成员，群内无管理员角色）/ 群资料 / 群主解散（即焚）/ 管理员解散（留痕，`DELETE /groups/admin/:id`） |
| 消息 | 发送（支持 E2EE 密文字段 / burn_ttl_seconds 点开才焚）/ 列表（按人马赛克视图）/ **点开 reveal** / 编辑 / 撤回 / 已读 / 回执查询 |
| 密钥 | 上传身份公钥（限 5/min）/ 查询对方公钥（限 60/min，需同会话） |
| 公告 | 发布 / 列表 / 管理列表 / 未读数 / 已读标记 / 撤回 |
| 意见反馈 | 提交 / 我的反馈 / 管理列表（按状态筛选）/ 管理员回复 |
| 统计 | 数据总览（12 指标） |
| 审计 | 审计日志查询 |
| 上传 | `POST /upload`（50MB） |

## WebSocket

连接方式（握手 `auth` 携带 access token）：

```ts
io(SERVER_ORIGIN, {
  path: '/api/v1/socket.io',
  transports: ['websocket', 'polling'],
  auth: { token: accessToken },
});
```

事件：`message:new`、`message:edited`、`message:recalled`、`receipt:read`、`conversation:updated`、`device:added`、`device:removed`。
鉴权失败立即断开；停用账号 / 下线设备在重连时吊销。payload 结构与前端镜像见 [docs/websocket-events.md](docs/websocket-events.md)。

## 测试与压测

```bash
npm test              # Jest 单元/集成测试
npm run test:cov      # 覆盖率
npm run lint          # tsc --noEmit 类型检查
```

压测（k6，脚本在 `loadtest/`）：登录、发消息、会话列表等场景，Windows 可用 `test-groups.ps1` 分组执行。

## 运维工具

| 脚本 | 用途 |
|------|------|
| `reset-admin-password.js` | 重置 admin 密码 |
| `reset-b-password.js` | 重置测试账号 b 密码 |

## 项目结构

```
src/
├── modules/
│   ├── auth/          # 登录、token、设备、强制改密
│   ├── account/       # 账号管理（软删除）
│   ├── contact/       # 通讯录
│   ├── conversation/  # 会话
│   ├── group/         # 群组（双语义解散）
│   ├── message/       # 消息、焚毁、回执（E2EE 密文字段）
│   ├── events/        # WebSocket 网关（全局模块）
│   ├── keys/          # E2EE 公钥分发
│   ├── announcement/  # 系统公告
│   ├── feedback/      # 意见反馈
│   ├── stats/         # 数据总览
│   ├── audit/         # 审计日志
│   └── upload/        # 文件上传
├── common/            # 守卫、装饰器、拦截器
└── database/          # data-source（migration 用）
docs/                  # WS 事件文档、E2EE 协议、迁移 SQL
loadtest/              # k6 压测脚本
test/                  # Jest 测试
```

## 相关仓库

- 移动前端：fenxin-app（React Native 0.75.4，WS 客户端镜像 `src/services/ws.ts`）
- 管理后台：独立前端项目（对接 `/api/v1` 管理接口）

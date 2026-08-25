# 焚信 BurnMsg 后端 v2（NestJS 重构版）

企业内部端到端加密通讯应用后端。由 Express 版（v1, commit b429b3c）重构而来。

## 技术栈

| 项 | 选型 |
|----|------|
| 框架 | NestJS 10 |
| ORM | TypeORM 0.3（synchronize 由 DB_SYNC 环境变量控制，默认关闭） |
| 数据库 | MySQL 8（utf8mb4） |
| 密码哈希 | Argon2id（argon2） |
| 认证 | JWT 双密钥：access（2h）+ refresh（30d，独立密钥） |
| 限流 | @nestjs/throttler（全局 300/min，登录 5/min） |
| 定时任务 | @nestjs/schedule（阅后即焚每分钟扫描） |
| 文档 | @nestjs/swagger（SWAGGER_ENABLED 控制，生产关闭） |

## 相对 v1 的修复（审查报告逐项落地）

**P0 安全**
- 发消息强制会话成员校验（原越权漏洞）
- 所有用户返回字段走白名单 `sanitizeUser` / `SAFE_USER_FIELDS`，password_hash 等不再外泄
- 删除 `POST /auth/register` 自助注册（账号仅由管理后台开通）
- `GET /accounts/departments` 声明先于 `GET /accounts/:id`（原路由抢占 bug）
- JWT 守卫每请求查库校验账号状态 + 设备存在性：停用账号、下线设备立即吊销 token
- refresh token 使用独立密钥 `JWT_REFRESH_SECRET` 并带 type 标记；`/auth/refresh-token` 不再要求 access token 有效
- 群成员列表、消息回执接口补会话成员校验

**P0 功能**
- 阅后即焚落地：`BurnScheduler` 每分钟销毁到期消息（清内容/删回执），`listMessages` 另有到期过滤兜底
- 初始管理员 Seed：首次启动无 admin 时按 `INITIAL_ADMIN_PHONE/PASSWORD` 创建，密码为空则随机生成并打印日志
- 文件上传 `POST /api/v1/upload`（50MB，本地存储 + /uploads 静态访问）
- Excel 批量导入 `POST /api/v1/accounts/import`（xlsx，列：phone/手机号, display_name/姓名, department/部门）

**P1 健壮性**
- CORS 白名单（CORS_ORIGINS），空则禁止跨域
- 登录接口 5 次/分钟/IP 限流
- markAsRead 改单条 UPDATE + 子查询
- 审计日志记录 IP 与 User-Agent
- 私聊会话查找限定 type='private'，不再命中共同群
- 停用账号时删除其设备记录（等于全端强制下线）
- 手机号唯一冲突返回 409 友好提示
- 创建私聊前校验对方账号存在且 active

## 快速开始

```bash
cp .env.example .env   # 按实际修改数据库与两个 JWT 密钥
npm ci
# 首次部署：.env 中 DB_SYNC=true 建表；启动后立即改回 false
npm run build
npm run start:prod      # 或 npm run start:dev 开发热更
```

启动后：
- API 前缀 `http://<host>:9091/api/v1`
- Swagger `http://<host>:9091/api-docs`（SWAGGER_ENABLED=true 时）
- 初始管理员账号见启动日志（仅打印一次），首次登录强制改密

## API 一览（与 v1 路径保持一致）

- `POST /auth/login`、`POST /auth/change-password`、`POST /auth/refresh-token`（body: refresh_token）、`GET|PUT /auth/profile`、`GET /auth/devices`、`POST /auth/devices/:id/offline`
- `POST /accounts`、`POST /accounts/batch`、`POST /accounts/import`（Excel）、`POST /accounts/:id/reset-password`、`POST /accounts/:id/toggle-status`、`GET /accounts`、`GET /accounts/departments`、`GET /accounts/:id`（均 admin）
- `GET /contacts`、`GET /contacts/search`
- `POST /conversations/private`、`GET /conversations`、`GET /conversations/:id`
- `POST /messages`、`GET /messages/:conversationId`、`PUT /messages/:id`、`POST /messages/:id/recall`、`POST /messages/:id/read`、`GET /messages/:id/receipt`
- `POST /groups`、`PUT /groups/:id`、`GET /groups/:id/members`、`POST /groups/:id/members`、`DELETE /groups/:id/members/:userId`、`PUT /groups/:id/members/:userId/role`
- `POST /upload`

统一响应 `{ code: 0, message, data }`；错误 `{ code: <httpStatus>, message }`。

## 数据库迁移注意

v1 的 bcrypt 密码哈希与 Argon2 不兼容：升级后所有账号需由管理员重置密码（或首次登录走重置流程）。表结构保持一致，可直接复用原库。

## 下一批（未含在本版）

- WebSocket 实时通道（socket.io：新消息/回执/销毁事件推送，取代轮询）
- MinIO 对象存储与分片断点续传
- 端到端加密密钥交换接口（X25519/X3DH 公钥托管与预钥包）

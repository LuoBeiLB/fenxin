# 焚信 BurnMsg — 前端对接文档

> 适用版本：后端 v4（NestJS） / WebSocket Socket.IO 4.8
> 本文档是 `README.md` 的补充：README 列了「是什么 / 怎么开」，本文讲「前端怎么接」。

---

## 0. 环境与前置

- REST 基址：`https://<host>:9091/api/v1`（本地默认 `http://localhost:9091/api/v1`）
- WebSocket：`https://<host>:9091/realtime`（Socket.IO，namespace `/realtime`）
- 所有跨域请求必须把前端域名加进后端 `CORS_ORIGINS`，否则一律拒绝（不留 `*` 口子）
- 鉴权方式：access_token（2h）+ refresh_token（30d，独立签名密钥），Bearer header
- 统一响应：`{ code: 0, message, data }`；业务异常：`{ code: <httpStatus>, message, errorCode?, data? }`

> ⚠️ **关键**：所有 `HttpException` 抛出都通过 `HttpExceptionFilter` 统一包装；错误响应里**没有** `code` 业务枚举字符串（那种会被改名为 `errorCode`）。前端请按 `errorCode` 字符串做分支，不要按 HTTP 状态码。

---

## 1. 鉴权流程

```
┌─────────┐  POST /auth/login   ┌──────────┐
│  客户端 │  phone+password     │  后端    │
│         │ ───────────────────▶│          │
│         │ ◀───────────────────│          │
└─────────┘  { access, refresh,  └──────────┘
              user, mustChangePwd? }
              (force_change_pwd=true 时
               业务 errorCode=FORCE_CHANGE_PASSWORD
               仍在 access 内，先临时持有)
```

### 1.1 登录

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "phone": "13800000000",
  "password": "Test@123456",
  "deviceName": "Chrome 120 / macOS",
  "deviceType": "web"
}
```

返回：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "accessToken": "eyJhbGciOi...",
    "refreshToken": "eyJhbGciOi...",
    "user": { "id": "...", "phone": "...", "displayName": "...", "role": "admin", "forceChangePwd": true },
    "deviceId": "uuid-..."
  }
}
```

### 1.2 错误分支

| 场景 | errorCode | 行为 |
|------|-----------|------|
| 首次登录或命中强制改密策略 | `FORCE_CHANGE_PASSWORD` | 跳改密页，**access_token 仍可临时使用**调用 `/auth/change-password` |
| 手机号或密码错 | `INVALID_CREDENTIALS` | 提示用户；连续 5 次错账号锁定 15 分钟 |
| 账号停用 | `ACCOUNT_DISABLED` | 提示用户联系管理员 |
| 设备被吊销 | `DEVICE_REVOKED` | 清本地 token，跳登录页 |

### 1.3 强制改密

```http
POST /api/v1/auth/change-password
Authorization: Bearer <accessToken>
{ "oldPassword": "...", "newPassword": "..." }
```

新密码规则（前端最好做软校验，后端强校验）：
- 8-32 字符
- 至少含字母 + 数字
- 不与最近 3 次密码重复
- 不与账号手机号 / 姓名 / displayName 形似

### 1.4 续 token

```http
POST /api/v1/auth/refresh-token
{ "refresh_token": "<refresh>" }
```

返回新 `accessToken` + 新 `refreshToken`（旋转），**旧 refresh 立即失效**。前端务必在本地用新值覆盖，避免下次续不上。

### 1.5 设备管理

```http
GET    /api/v1/auth/devices                   # 列出当前账号所有设备
POST   /api/v1/auth/devices/:id/offline       # 主动踢指定设备（吊销其 token）
```

WebSocket `device_added` / `device_removed` 事件会实时推同账号其它设备（用于多端互踢提示）。

---

## 2. WebSocket 连接

### 2.1 连接

```ts
import { io, Socket } from 'socket.io-client';

const socket: Socket = io('http://localhost:9091/realtime', {
  transports: ['websocket'],          // 关掉 polling，避免长轮询
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  reconnectionAttempts: Infinity,
  auth: { token: accessToken },        // 关键：握手时带
  extraHeaders: { 'X-Request-Id': uuid() },
});

socket.on('connect', () => {
  console.log('ws connected, sid=', socket.id);
});

socket.on('ready', (p) => {
  // { userId, deviceId }
});

socket.on('error', (p) => {
  // { code: 'UNAUTHORIZED', message } → token 无效，跳登录
});

socket.on('disconnect', (reason) => {
  // 'io server disconnect' → 服务端主动踢，可能 device_revoked
  // 'transport close' / 'ping timeout' → 网络抖动，等重连
});
```

### 2.2 心跳

Socket.IO 自带 PING/PONG（默认 25s 一次），前端无需手动发。心跳超时会触发 `disconnect: ping timeout`，自动重连。

### 2.3 重连策略

```ts
socket.on('reconnect', (attempt) => {
  // 重连成功后 socket.io 会自动重新 join room（user:{userId}）
  // 无需前端重订阅，listenner 也不丢
});
```

⚠️ 重连后**短期内的离线消息怎么办**：
- 阅后即焚消息：不在离线队列，重连后拉列表也拿不到了（设计如此）
- 普通消息：重连后调 `GET /messages/:conversationId?before=<重连时刻>` 拉增量

### 2.4 鉴权失败

```ts
socket.on('error', (p) => {
  if (p.code === 'UNAUTHORIZED') {
    // 尝试 refresh-token 续 access，成功后 socket.disconnect() + 重建
    await refresh();
    socket.disconnect();
    socket.connect();
  }
});
```

---

## 3. 事件订阅清单

| 事件 | 触发时机 | 关键字段 | 前端建议 |
|------|----------|----------|----------|
| `new_message` | 新消息 | `message`, `conversationId` | 收到即插入会话草稿，**若发送方是自己则忽略** |
| `message_edited` | 编辑 | `message`, `conversationId` | 按 `id` 替换本地草稿 |
| `message_recalled` | 撤回 | `messageId`, `conversationId`, `recalledBy` | 替换为「该消息已撤回」占位 |
| `message_destroyed` | 阅后即焚到期 | `messageId`, `conversationId`, `destroyedAt`, `destroyMethod` | 从本地草稿移除；展示销毁提示 |
| `message_read` | 已读 | `messageId`, `conversationId`, `readerId`, `readAt` | 更新消息已读人数 |
| `conversation_created` | 被拉进新会话 | `conversation`, `creatorId` | 插入会话列表头部 |
| `conversation_updated` | pin/unpin/改名 | `conversationId`, `pinned`, `pinnedAt`, `operatorId` | 更新本地会话元数据 |
| `member_joined` | 加群/订阅频道 | `conversationId`, `userId`, `joinedAt` | 更新成员列表 |
| `member_left` | 退群（静默） | `conversationId`, `userId`, `leftAt` | 移除成员 |
| `member_removed` | 被踢 | `conversationId`, `userId`, `removedBy`, `removedAt` | 同上 + 提示 |
| `role_changed` | 角色变更 | `conversationId`, `userId`, `role`, `operatorId` | 更新成员 role 角标 |
| `group_updated` | 群信息变更 | `conversation` | 替换会话元数据 |
| `destroy_receipt` | 销毁回执 | `messageId`, `conversationId`, `destroyedAt`, `signature` | 用于审计展示（可选） |
| `mentioned` | 被 @ | `message`, `conversationId`, `mentionedBy` | 弹通知 + 跳转 |
| `device_offline` | 设备被踢 | `deviceId`, `offlineAt` | 清 token 跳登录 |
| `new_device_login` | 同账号新设备登录 | `device`, `loginAt` | 弹「已在 XXX 登录，是否踢出」 |

---

## 4. 阅后即焚规则

### 4.1 九档

`destroy_after_seconds`：`5` / `10` / `30` / `60` / `300` / `1800` / `3600` / `14400` / `86400`（5 秒 ~ 24 小时）。
不传或传 0 = 不焚。

### 4.2 时序

```
发消息 ── 5s/10s/.../24h ── 自动销毁 ── 推 message_destroyed
       │                              │
       │ 客户端立即开始倒计时           │ 清 content / 删回执
       │ （与服务端到期时间对齐）       │ 保留 record（审计）
       ▼                              ▼
   local render            列表里显示「已焚毁」
```

### 4.3 转发

阅后即焚消息转发时，**档位沿用**（5s 仍 5s，10min 仍 10min），但**重新计时**——从转发时刻开始。
发到目标会话后走正常销毁流程。

### 4.4 已读即焚 / 计时方式

- 当前 v4.0：**「发送即计时」**（默认）。即消息一旦发出去就开始倒计时，不等对方已读。
- 「已读即焚」为后续 v5 路线图项。

---

## 5. 错误码处理

### 5.1 完整 errorCode 表

见 `README.md` 错误码段。**前端应只 switch 在 errorCode 上，不依赖 HTTP 状态**。

### 5.2 推荐封装

```ts
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAccessToken()}`,
      'X-Request-Id': crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.code !== 0) {
    const err = new ApiError(json.message, json.errorCode, res.status);
    throw err;
  }
  return json.data;
}

// 业务侧
try {
  await call('POST', '/messages/123/forward', { target_conversation_id });
} catch (e) {
  if (e instanceof ApiError) {
    switch (e.errorCode) {
      case 'BURN_MESSAGE_EXPIRED':   toast('消息已焚毁，无法转发'); break;
      case 'NOT_CONVERSATION_MEMBER': toast('你已不在该会话'); break;
      case 'RATE_LIMIT_EXCEEDED':    toast('操作太频繁'); break;
      case 'DEVICE_REVOKED':         await logout(); break;
      default:                       toast(e.message);
    }
  }
}
```

### 5.3 限流（429）

`RATE_LIMIT_EXCEEDED`：后端 throttle 命中。各端点上限见 README 限流表。前端建议做指数退避重试（最多 1 次）。

---

## 6. 上传文件

```http
POST /api/v1/upload
Content-Type: multipart/form-data
Authorization: Bearer <accessToken>

(file 字段，最大 50MB)
```

返回：

```json
{ "code": 0, "data": { "url": "/uploads/2026-08-26/xxx.png", "filename": "xxx.png", "size": 12345 } }
```

⚠️ MIME + 扩展名白名单（v4.0 修复 #6）：

| 类型 | 允许的 MIME | 允许的扩展名 |
|------|-------------|---------------|
| 图片 | `image/jpeg`, `image/png`, `image/gif`, `image/webp` | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` |
| 文档 | `application/pdf` | `.pdf` |

> **不在白名单 → 400 `UPLOAD_TYPE_NOT_ALLOWED`**。前端最好在选文件时本地校验一次，避免无效请求。

下载：`GET /uploads/<path>`（静态服务，CORS 已配）。

---

## 7. 批量账号导入（Excel）

```http
POST /api/v1/accounts/import
Content-Type: multipart/form-data
Authorization: Bearer <accessToken>   (admin)

(file 字段，.xlsx，≤1000 行)
```

Excel 列（首行表头，列名二选一）：
- `phone` 或 `手机号`
- `display_name` 或 `姓名`
- `department` 或 `部门`（可选）

⚠️ **超 1000 行 → 400 `BATCH_SIZE_EXCEEDED`**。返回体里 `data` 给出每条行的成功 / 失败明细。

---

## 8. 消息搜索 / 拉增量

```http
GET /api/v1/messages/:conversationId?before=<messageId>&limit=50
```

- 游标分页（用 `before` 而非 `offset`）
- 服务端**自动过滤**已到期阅后即焚（不要在前端过滤）
- 返回 `data.items[]` 升序，**前端 reverse 一下再渲染**

---

## 9. @提及

消息体里写 `@<userId>`（尖括号包裹的 UUID），后端解析后：
- 写入 `message.mentioned_user_ids`
- 给被 @ 的用户推 `mentioned` 事件（除发送方）
- 校验被 @ 的必须是会话成员，否则 `400`

```ts
// 调「@我的消息」列表
GET /api/v1/messages/mentions?before=<msgId>&limit=20
```

---

## 10. 群 / 频道

| 类型 | 谁可建 | 成员进出 | 发消息权限 |
|------|--------|----------|------------|
| 群 | 任何 active | owner/admin 控制 | 群成员即可 |
| 频道 | 任何 active | **任何人可订阅**，owner/admin 可踢 | 频道主（创建者）固定不可退 |

频道创建：

```http
POST /api/v1/groups/channels
{ "name": "公告", "memberIds": ["..."] }   // 初始成员可空
```

订阅/退订：

```http
POST /api/v1/groups/channels/:id/subscribe        # 任何 active 用户
POST /api/v1/groups/channels/:id/unsubscribe      # 频道主禁退（409）
```

---

## 11. 部署差异

### 本地开发
- `pnpm run start:dev`，`SWAGGER_ENABLED=true` 看 `/api-docs`
- `LOG_PRETTY=true`（开发默认）

### Docker 生产
- `LOG_PRETTY=false` 输出 JSON 给采集
- `SWAGGER_ENABLED=false`
- `DB_SYNC=false`，跑 `pnpm migration:run`
- `INITIAL_ADMIN_PASSWORD=` 留空，**看启动日志拿初始密码**

### 跨域
- 前端域名必须出现在 `CORS_ORIGINS`，多个用逗号分隔
- WebSocket 跨域与 REST 同策略

---

## 12. 调试小贴士

- 所有响应带 `X-Request-Id` header（pino 自动注入），问题排查时把 ID 复制给后端
- `/api/v1/health` 是健康检查，**前端不要用**
- Swagger 只在 `SWAGGER_ENABLED=true` 时存在，生产 404 是正常的
- `socket.emit('error', ...)` 只在握手失败时推，连接成功后业务错误走 REST 错误码

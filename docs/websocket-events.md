# 焚信（BurnMsg）WebSocket 实时事件文档

后端基于 `@nestjs/websockets` + `socket.io`（v4）实现实时推送，网关位于
`src/modules/events/`（`EventsGateway` + `EventsModule`，全局模块）。

## 连接与鉴权

| 项 | 值 |
| --- | --- |
| 协议 | socket.io v4（Engine.IO v4） |
| 服务地址 | 与 REST 同源：`SERVER_ORIGIN`（默认 `http://<host>:9091`） |
| 路径 | `/api/v1/socket.io`（与 REST 全局前缀 `/api/v1` 对齐，不与任何 REST 路由冲突） |
| transports | `websocket`（首选）、`polling`（兜底） |
| 房间 | 鉴权通过后 socket 自动加入 `user:{userId}`，同一用户多设备同房间 |

### 握手鉴权方式

客户端在 **handshake `auth`** 中携带 access token：

```ts
io(SERVER_ORIGIN, {
  path: '/api/v1/socket.io',
  transports: ['websocket', 'polling'],
  auth: { token: accessToken }, // 即 REST 使用的 Bearer access token
});
```

同时兼容 `Authorization: Bearer <token>` 请求头（老版本客户端兜底）。

服务端校验逻辑与 REST 的 `JwtAuthGuard`（`src/common/guards/jwt-auth.guard.ts`）完全一致：

1. `TokenService.verifyAccessToken()` JWT 验签（`JWT_SECRET`）；
2. 账号仍存在且 `status = 'active'`；
3. 签发 token 的设备记录（`devices` 表）仍存在。

任一失败 → 服务端立即 `disconnect(true)` 断开连接。
因此**停用账号 / 下线设备**对 WS 同样具有「吊销」语义：已建立的连接靠重连时的握手校验拦截。
token 过期后重连会持续失败，前端应在刷新 token 后先 `disconnect()` 再用新 token `connect()`。

### CORS

浏览器跨域遵循环境变量 `CORS_ORIGINS`（与 `main.ts` 的 REST 白名单同一语义：`*` 通配、白名单、空白名单拒绝跨域浏览器调用）；原生 App（React Native）握手无 Origin 头，直接放行。

## 事件总览

所有事件 payload 均携带 `conversation_id`，前端据此判断是否属于当前打开的聊天页。
推送目标为**会话全体成员**的 `user:{userId}` 房间（含操作者本人——用于其多端同步）。

| 事件 | 触发时机（后端注入点） | payload |
| --- | --- | --- |
| `message:new` | `MessageService.sendMessage()` 发送新消息成功后 | `WsMessagePayload` |
| `message:edited` | `MessageService.editMessage()` 编辑成功后 | `WsMessagePayload` |
| `message:recalled` | `MessageService.recallMessage()` 撤回成功后 | `WsMessageRecalledPayload` |
| `receipt:read` | `MessageService.markAsRead()` 确实把未读翻成已读时 | `WsReceiptReadPayload` |
| `conversation:updated` | 会话创建 / 新消息更新 `last_message_at` / 群成员变动 / 群资料变更 | `WsConversationUpdatedPayload` |

## payload 结构

类型定义见 `src/modules/events/events.types.ts`（前端镜像：`fenxin-app/src/services/ws.ts`）。

### WsMessagePayload（message:new / message:edited）

```jsonc
{
  "conversation_id": "uuid",
  "message": {
    "id": "uuid",
    "conversation_id": "uuid",
    "sender_id": "uuid",
    "type": "text | image | voice | video | file",
    "content": "消息内容（文本）或 null",
    "file_url": "/uploads/xxx 或 null",
    "file_name": "xxx.pdf 或 null",
    "file_size": 12345,
    "reply_to_id": "uuid 或 null",
    "is_edited": false,
    "is_recalled": false,
    "is_destroyed": false,
    "destroy_at": "2026-08-26T12:00:00.000Z 或 null",
    "burn_ttl_seconds": "5 或 null",
    "is_blurred": "true（焚毁消息推送时为马赛克占位，内容字段全 null；普通消息无此字段）",
    "created_at": "2026-08-26T11:00:00.000Z",
    "updated_at": "2026-08-26T11:00:00.000Z"
  }
}
```

> 点开才焚 v2：焚毁消息（`burn_ttl_seconds` 非空）的 `message:new` 推送一律马赛克化——
> `content / file_url / file_name / file_size / cipher_*` 全部为 null，`is_blurred=true`。
> 前端渲染占位卡，用户点击后调 `POST /messages/:id/reveal` 才拿到内容并开始倒计时。

### WsMessageRecalledPayload（message:recalled）

```jsonc
{
  "conversation_id": "uuid",
  "message_id": "uuid",
  "recalled_at": "2026-08-26T12:00:00.000Z"
}
```

前端收到后将对应消息就地置为 `is_recalled = true`（渲染为「消息已撤回」灰条）。

### WsReceiptReadPayload（receipt:read）

```jsonc
{
  "conversation_id": "uuid",
  "user_id": "执行已读标记的用户 uuid",
  "last_read_message_id": "该用户读到的最新消息 uuid（标记时会话内最后一条消息）",
  "read_at": "2026-08-26T12:00:00.000Z"
}
```

注意：仅当本次 `markAsRead` 确实将回执从「未读」翻为「已读」（`affected > 0`）时才广播，
用户每次打开聊天页不会产生噪音事件。

### WsConversationUpdatedPayload（conversation:updated）

```jsonc
{
  "conversation_id": "uuid",
  "reason": "message | created | members | info"
}
```

- `message`：新消息（`last_message_at` 更新）——随 `message:new` 一并发送；
- `created`：私聊/群聊会话刚创建（`ConversationService` / `GroupService.createGroup`）；
- `members`：群成员增减（拉人 / 移出，被移出的用户也会收到，用于列表移除该会话）；
- `info`：群资料变更（群名 / 描述 / 头像）。

这是一个「信号」事件：前端收到后重新拉取会话列表（`GET /api/v1/conversations`）即可，
payload 不携带会话实体本身。

## 服务端注入点一览

| 文件 | 位置 | 事件 |
| --- | --- | --- |
| `src/modules/message/message.service.ts` | `sendMessage` | `message:new` + `conversation:updated(reason=message)` |
| `src/modules/message/message.service.ts` | `editMessage` | `message:edited` |
| `src/modules/message/message.service.ts` | `recallMessage` | `message:recalled` |
| `src/modules/message/message.service.ts` | `markAsRead` | `receipt:read`（仅 affected > 0） |
| `src/modules/conversation/conversation.service.ts` | `getOrCreatePrivateConversation`（新建分支） | `conversation:updated(reason=created)` |
| `src/modules/group/group.service.ts` | `createGroup` | `conversation:updated(reason=created)` |
| `src/modules/group/group.service.ts` | `addMembers` / `removeMember` | `conversation:updated(reason=members)` |
| `src/modules/group/group.service.ts` | `updateGroupInfo` | `conversation:updated(reason=info)` |

推送统一走 `EventsGateway.emitToUsers(event, userIds, payload)`，内部 try/catch：
推送失败只记日志，**绝不影响 REST 业务主流程**。

注：阅后即焚的到期销毁（`BurnScheduler` 每分钟整行 DELETE）不产生事件，
前端靠 `reveal` 返回的 `burn_at` / `remain_seconds` 倒计时本地移除，列表接口另有到期过滤兜底。
另：`receipt:read` 在「点开焚毁消息」时也会广播（点开即已读，发送方实时看到对方已点开）。

## 前端接入示例（fenxin-app）

连接管理（登录成功 / token 刷新 / 退出登录）在 `src/store/auth.ts`：

```ts
// 登录成功（signIn）
wsService.connect(result.access_token);

// token 刷新（setTokens）：旧 token 握手会失败，先断开再重建
wsService.reconnect(accessToken);

// 退出登录（signOut）
wsService.disconnect();
```

页面内订阅（`src/services/ws.ts` 的 `wsService.on` 返回取消订阅函数）：

```ts
useEffect(() => {
  const offNew = wsService.on<WsMessagePayload>(WS_EVENTS.MESSAGE_NEW, p => {
    if (p.conversation_id !== currentConversationId) return; // 其他会话的消息
    appendMessage(p.message);
    if (p.message.sender_id !== myId) {
      messageApi.markRead(currentConversationId); // 回执已读
    }
  });
  const offConv = wsService.on<WsConversationUpdatedPayload>(
    WS_EVENTS.CONVERSATION_UPDATED,
    () => reloadConversationList(),
  );
  return () => {
    offNew(); // 离开页面只取消订阅，不断开全局连接
    offConv();
  };
}, [currentConversationId]);
```

聊天页数据流约定：

1. 进入页面：REST 拉一页历史消息（`GET /api/v1/messages/:conversationId`）；
2. 实时消息：`message:new` 插入列表、`message:edited` 就地覆盖、
   `message:recalled` 置 `is_recalled`、`receipt:read` 更新气泡已读态；
3. 会话列表页：`conversation:updated` 触发重新拉取（建议做 500ms 防抖）；
4. 断线：socket.io 自带 reconnection 自动重连（指数退避，1s 起步，上限 10s）。

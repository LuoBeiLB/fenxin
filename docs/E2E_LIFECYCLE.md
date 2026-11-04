# 加密会话：退出登录 / 换设备 / 僵尸清理 —— 后端实现说明

> 版本：V6.2.1 · 2026-11-04
> 对应需求：[加密会话-退出登录与新设备提示-需求.md]（对端提的 B-1 ~ B-13）
> 代码：`src/modules/e2e/*`、`src/modules/auth/*`、`src/modules/events/*`
> 关联：[E2E_SECRET_CHAT.md](./E2E_SECRET_CHAT.md) · [DEVICE_UA.md](./DEVICE_UA.md) · [websocket-events.md](./websocket-events.md)

---

## 0. 一句话结论

需求里 **B-1 ~ B-12 全部已实现**（B-13 离线信标按 P2 暂缓，理由见 §7）。
核心变化：**"用户换设备"现在等价于"旧设备上的加密会话结束"**，
三条出口（退出登录 / 新设备批量结束 / 7 天僵尸清理）都由服务端兜底，不再依赖前端自觉。

---

## 1. 死锁是怎么解开的

原问题：会话绑定在「电脑A」，用户换到「电脑A2」后——

| 现象 | 原因 |
|---|---|
| 新设备看不到会话 | 可见性按设备过滤（设计如此） |
| 重新发起被 409 | 同一对用户只允许一条 pending/active |
| 无法关闭 | 旧规则：只有绑定设备能关 |

V6.2.1 给了三条出口，任一条命中就解开：

```
① 退出登录（POST /auth/logout）
      → 服务端自动结束该设备的会话（reason=logout）
② 新设备登录后批量结束（POST /conversations/e2e-close-all）
      → 同一用户的任意设备都能结束自己名下的会话（B-2 放宽）
③ 7 天不登录（定时任务 closeGoneDeviceChats）
      → reason=device_gone，双方都收到 e2e:closed
```

---

## 2. 接口对照表（需求 → 实现）

| 需求 | 实现 | 状态 |
|---|---|---|
| **B-1** `GET /conversations/e2e-mine` | 已实现，支持 `?bound_device=all\|this\|other` | ✅ |
| **B-2** 结束接口放宽权限 + 新 `reason` | `close` / `close-all` 允许**同用户任意设备**；reason 支持 `user` / `logout` / `device_change` / `device_gone` / `device_removed` / `admin` | ✅ |
| **B-3** 批量结束 `POST /conversations/e2e-close-all` | 已实现，支持 `only_other_devices` | ✅ |
| **B-4** 退出登录联动 | `POST /auth/logout`：结束本设备会话 + 删除设备记录（token 立即失效）+ 审计 | ✅ |
| **B-5** 登录响应带 `e2e_on_other_devices` | 已加（失败不影响登录，返回 `[]`） | ✅ |
| **B-6** 查询接口带过滤 | 即 B-1 的 `?bound_device=other` | ✅ |
| **B-7** 409 补绑定设备信息 | 返回 `conversation_id / e2e_state / bound_user_id / bound_device_id / bound_device_name / bound_device_online / bound_device_last_seen_at` | ✅ |
| **B-8 / B-10** 僵尸会话清理 | `closeGoneDeviceChats()`，每小时跑；设备不存在或 `last_active_at` 超 `E2E_DEVICE_GONE_DAYS`（默认 7）即结束 | ✅ |
| **B-9** 离线判定 | 复用现有：`ONLINE_TTL_SECONDS` 默认 **150 秒**（需求建议 3 分钟，接近） | ✅ |
| **B-11** 设备下线联动 | `POST /auth/devices/:id/offline` → `removeDevice` 已联动结束 + 删设备公钥 | ✅ |
| **B-12** e2e-mine 带在线态 | `bound_device_online` / `bound_device_last_seen_at` / `as_of` | ✅ |
| **B-13** `POST /auth/beacon-offline` | 暂缓（P2）—— 见 §7 | ⏸ |

---

## 3. 接口契约

### 3.1 跨设备列表（B-1）

```http
GET /api/v1/conversations/e2e-mine?bound_device=other
Authorization: Bearer <token>
```

```json
[
  {
    "conversation_id": "uuid",
    "state": "active",
    "peer_user_id": "uuid",
    "peer_name": "张三",
    "bound_device_id": "uuid",
    "bound_device_name": "电脑A",
    "bound_device_online": false,
    "bound_device_last_seen_at": "2026-11-01T09:00:00.000Z",
    "is_bound_device": false,
    "peer_device_id": "uuid",
    "created_at": "2026-10-20T08:00:00.000Z",
    "expires_at": null,
    "as_of": "2026-11-04T03:00:00.000Z"
  }
]
```

> `as_of` 是服务端时间：前端算「3 天前」请用它，不要用本机时钟（设备时区/时间可能不准）。

### 3.2 批量结束（B-3）

```http
POST /api/v1/conversations/e2e-close-all
{ "reason": "logout", "only_other_devices": false }
```

```json
{ "closed": 2, "conversation_ids": ["uuid1", "uuid2"], "deleted_messages": 42 }
```

- `only_other_devices: true` → 只结束绑在其它设备上的（当前设备正在用的不动）
- 单条失败不阻塞其余，失败项不会出现在 `conversation_ids` 中

### 3.3 退出登录（B-4）

```http
POST /api/v1/auth/logout
```

```json
{ "closed_secret_chats": 2 }
```

行为：结束本设备绑定的会话（通知对方 `e2e:closed`）→ 删除设备记录 → 使 token 立即失效 → 写审计。
**幂等**：设备记录已不存在也返回成功（`closed_secret_chats=0`）。

### 3.4 登录响应新增字段（B-5）

```jsonc
{
  "user": { ... },
  "access_token": "...",
  "device": { ... },
  "e2e_on_other_devices": [
    { "conversation_id": "uuid", "state": "active", "peer_name": "张三",
      "bound_device_name": "电脑A", "bound_device_online": false,
      "bound_device_last_seen_at": "..." }
  ]
}
```

> 该字段查询失败时返回 `[]`，**绝不影响登录**（加密会话治理不能阻塞主链路）。

### 3.5 409 撞车（B-7）

```jsonc
// POST /conversations/e2e-request 的 409
{
  "code": 409,
  "code": "E2E_PAIR_EXISTS",
  "conversation_id": "uuid",
  "e2e_state": 2,
  "bound_user_id": "uuid",
  "bound_device_id": "uuid",
  "bound_device_name": "电脑A",
  "bound_device_online": false,
  "bound_device_last_seen_at": "2026-11-01T09:00:00.000Z"
}
```

前端可据此提示：**「你已在【电脑A】有一条与该用户的加密聊天（3 天未上线）」**，
并给「结束它并重试」按钮（调 `POST /conversations/:id/e2e-close`）。

---

## 4. 会话生命周期（L1 / L2 / L3）

| 层级 | 触发 | 行为 |
|---|---|---|
| **L1 离线** | 关窗口 / 断网 / 心跳超时（150s） | 设备置离线，**会话保留** |
| **L2 用户动作** | 退出登录 / 新设备批量结束 | 结束会话（reason=logout / device_change） |
| **L3 服务端兜底** | 设备记录删除 / 7 天未活跃 | 定时任务结束（reason=device_gone） |

定时任务：`E2eService.closeGoneDeviceChats()`，`@Cron('0 * * * *')`，每小时整点。
每轮最多处理 200 条会话，避免长事务。

判定为"僵尸"的条件（任一）：
1. 绑定设备在 `devices` 表里不存在；
2. 绑定设备 `last_active_at`（无则 `online_at` / `created_at`）早于 `now - E2E_DEVICE_GONE_DAYS`。

---

## 5. 变更的权限语义（重要）

V6.2 原本：**只有绑定设备能关闭**。
V6.2.1 改为：

| 触发方 | 权限 |
|---|---|
| `user` / `logout` / `device_change` | **同一用户的任意设备**都可以结束自己名下的会话（参与者即可） |
| `device_removed` / `device_gone` | 服务端内部清理（按设备维度） |
| `admin` | 不限 |

**为什么敢放宽**：关闭 ≠ 读取。关闭只做物理删除 + 通知对方，不泄露任何密文；
而旧设备可能已丢失/重装，不给用户出口才是真正的死锁。
非参与者（别的用户）调用仍然是 403。

---

## 6. 前端接入要点

| # | 场景 | 调用 |
|---|---|---|
| F-1 | 点「退出登录」 | 先 `GET /conversations/e2e-mine` → 有会话弹二次确认（列 `peer_name` + `state`） |
| F-2 | 确认退出 | `POST /conversations/e2e-close-all {reason:'logout'}` → 清理本地缓存 → `POST /auth/logout` |
| F-3 | 登录成功 | 读 `e2e_on_other_devices`，非空弹「未结束的加密聊天」→「结束全部」调 `e2e-close-all {reason:'device_change'}` |
| F-4 | 锁面板 | `GET /conversations/e2e-mine?bound_device=other`，列表带「结束该设备上的加密聊天」 |
| F-5 | 角标 | `e2e_on_other_devices.length` 或锁面板接口返回数量 |
| F-6 | 409 | 用 `bound_device_name` + `bound_device_last_seen_at` 改写提示 |
| F-7 | 本地清理 | 登出/结束时清 `bm_e2e_id_*`、明文缓存、pin、会话列表里的加密会话 |

> 提示文案必须写清「**对方也无法再查看，且不可恢复**」——服务端确实是物理删除。

---

## 7. 明确没做的（B-13，原因是取舍）

`POST /auth/beacon-offline`（`sendBeacon` 上报离线）：

- `navigator.sendBeacon` **无法携带 Authorization 头**，只能把 token 放 body/query，
  等于把长期凭证暴露在 URL / 日志里；
- 而它能带来的收益仅仅是"离线判定提前 150 秒"，现有 WS 断开 + 心跳超时已经覆盖；
- 且它**不结束会话**（L1），功能性收益很小。

**结论**：暂不实现。如果后续确实需要，建议改成一次性短期 token（签发 5 分钟、只能调这一个接口），
不要复用 access_token。

---

## 8. 已知边界

| 场景 | 行为 |
|---|---|
| 两台设备同时在线，A 用旧设备、B 用新设备各自发起 | 同一对用户只能一条会话；后发起方收到 409（带绑定设备信息） |
| 新设备选「暂不处理」 | 会话仍在旧设备名下；7 天后自动清理；期间可随时从锁面板结束 |
| 定时任务与用户手动关闭并发 | `closeSecretChat` 幂等（会话不存在直接返回），不会报错 |
| 用户手动下线旧设备 | 立即结束该设备会话（B-11），不等 7 天 |
| 关闭瞬间对方正在发消息 | 发消息侧校验会话状态，返回 409 `E2E_STATE_INVALID` |

---

## 9. 验证

```
单测：test/modules/secret-chat/
  e2e.service.spec.ts      33 条（含 listMine 5 条 / closeAll 2 条 / 僵尸清理 3 条 / 409 1 条）
  logout.spec.ts            4 条（B-4：关会话 + 删设备 + 抛错不阻塞 + 空 deviceId）
全量：31 suites / 301 tests 全绿
tsc --noEmit：0 error
```

配置项：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `E2E_DEVICE_GONE_DAYS` | `7` | 绑定设备多久未活跃后自动结束会话 |
| `ONLINE_TTL_SECONDS` | `150` | 心跳超时判定离线（L1 用） |

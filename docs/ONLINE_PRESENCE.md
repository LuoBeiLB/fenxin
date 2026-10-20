# 在线状态与登录冲突 — 设计 + 实施

> 独立于焚毁重构的一次专项（可与 BURN_V2 并行上线）
> 仓库：`fenxin-server` + `fenxin`（Vue/Capacitor）+ 管理后台

---

## 0. 实现状态（2026-10-20）

| 能力 | 实现 | 状态 |
|---|---|---|
| 设备表补字段 | `1767900000000-AddDevicePresence`：`socket_count` / `online_at` / `offline_at` + `idx_devices_online` | ✅ |
| WS 连接数维护 | `events.gateway`：连接 `+1` 并置在线，断开 `GREATEST(-1,0)` | ✅ |
| 心跳接口 | `POST /auth/devices/:deviceId/heartbeat`（60 次/分钟限流） | ✅ |
| 离线兜底清扫 | `PresenceScheduler`（`@Cron` 每分钟）：`socket_count<=0` 且心跳过期 → 置离线 | ✅ |
| 管理端在线监控 | `GET /admin/presence/overview`、`GET /admin/presence/devices` | ✅ |
| 强制下线 | `POST /admin/devices/:deviceId/offline`（管理端，带审计） | ✅ |
| 数据总览修正 | `GET /stats/overview` 的 `online_devices` 现为真实在线数，另加 `online_users` | ✅ |
| 存量脏数据 | 迁移里把 `is_online=1` 全部置 0，由真实连接/心跳重建 | ✅ |

**尚未实现（本专项剩下的部分）**

| 项 | 说明 |
|---|---|
| 登录冲突 `session:conflict` WS 事件 | 策略已定 `notify`（允许多端 + 弹窗提醒），事件与前端弹窗未做 |
| `allow / single` 策略开关 | `SESSION_POLICY` env 未引入；当前行为等价于 `allow`（不拦截、不提醒） |
| 前端心跳循环 | 前端尚未调 heartbeat；**不调的话设备会在 150s 后被判定离线**，管理端在线数会偏低 |
| `device:online` / `device:offline` 事件 | 未广播（管理端靠轮询 overview 即可，前端暂不需要） |

> ⚠️ 上线顺序提醒：后端心跳接口与清扫任务一旦生效，**旧版前端（不调 heartbeat）
> 会表现为"一直离线"**。若要平滑，可先把 `ONLINE_TTL_SECONDS` 调大（如 600）
> 等前端发版后再调回 150；或前端发版与后端同时上线。

---

## 1. 现状审计（全部已核实）

| # | 现状 | 证据 | 后果 |
|---|---|---|---|
| A1 | `devices.is_online` **只在登录时置 `true`，从不置 `false`** | `auth.service.ts:81,91` 写 true；全仓库无 `is_online = false` | 在线设备数是"历史累计"，永远只增不减 |
| A2 | `last_active_at` **只在登录时更新** | `auth.service.ts:82` | 无法用"最近活跃"判断在线 |
| A3 | **没有心跳接口** | `src/` 里 `heartbeat` 零命中；但 `loadtest/api-mix.js:73` 却在调 `POST /auth/devices/:id/heartbeat`（接口从没实现） | 无法探测异常掉线 |
| A4 | WS 网关**不维护在线状态** | `events.gateway.ts:58-90`：只做鉴权 + 加入房间，`handleDisconnect` 只打日志 | 断线后无感知 |
| A5 | **没有单点登录策略**，同一账号可无限多设备并存 | 无任何 session 冲突判定 | 账号共享/被盗用无法感知 |
| A6 | 有新设备登录时**只弹 toast**，不拦截 | `auth.service.ts:96-108` 发 `device:added`；`App.vue:108-112` 仅 `showToast` | 提示容易被忽略，且**同一 device_id 重复登录时根本不触发** |
| A7 | 统计接口的"在线设备数"是错的 | `stats.service.ts:57` 数 `is_online = true` | 管理后台指标失真 |
| A8 | 无法强制下线（除用户自己踢） | 管理员只有 `POST /accounts/:id/toggle-status`（停用整个账号） | 运维手段太粗 |

---

## 2. 目标

1. **设备在线/离线**可判定，且能在管理后台看到
2. **用户在线/离线**（任一设备在线即在线）
3. **登录冲突**：同账号在新设备登录时，已在线设备收到**明确提示**（可配置为"仅提醒"或"强制踢出"）
4. 支持**强制下线**（用户踢自己设备、管理员踢任意设备）
5. 统计口径修正（`online_devices` 真实反映当前在线）

---

## 3. 在线判定方案（推荐：WS 为主 + 心跳兜底）

| 方案 | 实时性 | 准确性 | 复杂度 | 结论 |
|---|---|---|---|---|
| WS 连接状态 | 秒级 | 浏览器/App 被系统杀进程时收不到 disconnect | 低 | **主方案** |
| HTTP 心跳（60s） | 1 分钟 | 准确（超时即判离线） | 低 | **兜底** |
| Redis 共享态 | 秒级 | 准确 | 高（需引入 Redis） | 多实例时再上 |

**组合规则**

```
设备在线 = (WS 已连接) OR (last_active_at 在 ONLINE_TTL_SECONDS 内，默认 150s)
用户在线 = 该用户任一设备在线
```

---

## 4. 数据模型

```sql
-- devices 表：把 is_online 变成"真实状态"，并记录 WS 连接数
ALTER TABLE devices
  MODIFY COLUMN is_online tinyint(1) NOT NULL DEFAULT 0,
  ADD COLUMN socket_count int NOT NULL DEFAULT 0
    COMMENT '当前 WS 连接数（多标签页/多连接），>0 即在线' AFTER is_online,
  ADD COLUMN online_at datetime NULL COMMENT '最近一次上线时刻' AFTER socket_count,
  ADD COLUMN offline_at datetime NULL COMMENT '最近一次离线时刻' AFTER online_at;

CREATE INDEX idx_devices_online ON devices (is_online, last_active_at);
```

> `socket_count` 解决"同一设备开两个标签页，关一个不该判离线"的问题。
> 单实例用 DB 记数即可；将来多实例时改为 Redis 计数（接口不变）。

---

## 5. 接口设计

### 5.1 心跳（兜底，补齐 A3）

```
POST /auth/devices/:deviceId/heartbeat     （限流 30/分钟）
resp: { "server_time": "2026-10-20T10:00:00Z", "online_ttl": 150 }
```

副作用：更新该设备 `last_active_at = NOW()`；若 `is_online=0` 则置 1（说明心跳能到，即在线）。
前端每 60s 调一次（App 在前台才调，后台暂停）。

### 5.2 在线设备列表（用户侧）

```
GET /auth/devices
resp 追加字段：
{
  "id": "...", "device_name": "iPhone 15", "device_type": "mobile",
  "is_online": true,              // 修正为真实状态
  "online_at": "...",
  "last_active_at": "...",
  "is_current": true              // 是否为发起请求的这台设备
}
```

### 5.3 强制下线（已有，增强）

```
POST /auth/devices/:deviceId/offline      // 用户踢自己的设备（已存在）
POST /admin/devices/:deviceId/offline     // 管理员踢任意设备（新增）
```

被踢设备：`devices` 行删除 → JWT 守卫下次请求即 401（现有机制）→ WS 收到 `device:removed` 立即跳登录页。

### 5.4 登录冲突策略（可配）

> **已确认（2026-10-20）**：V1 采用 **`notify`** —— 允许多端并存，只提示不踢人。
> `single` 作为后续可选项保留（同一份代码用 env 切换，无需改结构）。

```
env SESSION_POLICY = allow | notify | single
  allow  : 允许多端并存，不发任何提示（最宽松）
  notify : 允许多端并存，向其他在线设备推 session:conflict（✅ V1 默认，已确认）
  single : 新登录踢掉该账号其他所有设备（单点登录，V1 不启用）
env MAX_DEVICES_PER_USER = 5      // 超过时按最久未活跃踢掉（可选）
```

**`single` 模式的实现**（在 `auth.service.login` 内、签发 token 前）：

```ts
if (SESSION_POLICY === 'single') {
  const others = await deviceRepo.find({ where: { user_id: user.id } });
  for (const d of others) {
    await deviceRepo.delete({ id: d.id });
    this.authCache.invalidate(user.id, d.id);              // 立即失效鉴权缓存
    this.events.emitToUsers(WS_EVENTS.SESSION_CONFLICT, [user.id], {
      device_id: d.id, reason: 'kicked_by_new_login', at: new Date().toISOString(),
    });
  }
} else if (SESSION_POLICY === 'notify') {
  this.events.emitToUsers(WS_EVENTS.SESSION_CONFLICT, [user.id], {
    new_device: { id: device.id, name: device.device_name, ip: meta.ip, at: ... },
    reason: 'new_device_login',
  });
}
```

> 注意：`notify` 也要**推给新设备本身**（前端按 `device_id` 自行忽略，与现有 `device:added` 的处理方式一致）。

### 5.5 在线统计（管理端）

```
GET /admin/presence/overview
resp:
{
  "online_users": 12,
  "online_devices": 18,
  "total_users": 240,
  "by_device_type": { "mobile": 14, "web": 4 },
  "generated_at": "..."
}

GET /admin/presence/devices?online_only=true&page=1&pageSize=20
resp: 设备列表（含 user_id/phone/display_name/is_online/last_active_at/ip）
```

---

## 6. WS 事件（`events.types.ts` 新增）

| 事件 | payload | 触发时机 | 前端动作 |
|---|---|---|---|
| `session:conflict` | `{ reason: 'new_device_login' \| 'kicked_by_new_login', new_device?: {id,name,ip,at}, at }` | 同账号新设备登录 / 被踢 | **弹窗**："账号在另一台设备登录"（`kicked_by_new_login` 时只能点"重新登录"） |
| `device:online` | `{ device_id, online_at }` | 设备 WS 连上 | 设备管理页刷新 |
| `device:offline` | `{ device_id, offline_at }` | 设备 WS 全断开 + 心跳超时 | 同上 |

**在线状态维护点**

```ts
// events.gateway.ts
async handleConnection(client) {
  // ...现有鉴权
  await this.deviceRepo.increment({ id: payload.deviceId }, 'socket_count', 1);
  await this.deviceRepo.update(payload.deviceId, { is_online: true, online_at: new Date() });
  this.events.emitToUsers(WS_EVENTS.DEVICE_ONLINE, [payload.userId], { device_id: payload.deviceId, online_at: ... });
}

async handleDisconnect(client) {
  const { userId, deviceId } = client.data;
  await this.deviceRepo.decrement({ id: deviceId }, 'socket_count', 1);
  const dev = await this.deviceRepo.findOne({ where: { id: deviceId } });
  if (dev && dev.socket_count <= 0) {
    // 不立刻判离线：留给心跳兜底（避免网络抖动误判）
    // 标记 socket 断开时间，由定时任务在 ONLINE_TTL 后置 is_online=0
  }
}
```

**离线收敛任务**（每分钟）：

```ts
// presence.scheduler.ts
@Cron(EVERY_MINUTE)
async sweepOffline() {
  const ttl = parseInt(process.env.ONLINE_TTL_SECONDS || '150', 10);
  const cutoff = new Date(Date.now() - ttl * 1000);
  // socket 已断 且 心跳也过期 → 置离线
  await deviceRepo.createQueryBuilder()
    .update().set({ is_online: false, offline_at: new Date() })
    .where('is_online = 1 AND socket_count <= 0 AND (last_active_at IS NULL OR last_active_at < :cutoff)', { cutoff })
    .execute();
}
```

---

## 7. 前端改造

| 位置 | 改动 |
|---|---|
| `App.vue` | 监听 `session:conflict`：`notify` 弹可关闭弹窗；`kicked_by_new_login` 弹阻断弹窗 → `forceLogout()` |
| `utils/ws.js` | `WS_EVENTS` 增加 `SESSION_CONFLICT / DEVICE_ONLINE / DEVICE_OFFLINE` |
| `store/index.js` | 心跳定时器（60s，仅前台）；`visibilitychange` 回前台立即补一次心跳 + 刷新设备列表 |
| `Me.vue` / 设备管理页 | 显示"在线/离线"标记与最后活跃时间；当前设备标"本机"；每行"下线"按钮 |
| `Chats.vue` / `ChatRoom.vue` | （可选）私聊对方在线状态小绿点（需后端下发对方 presence） |

心跳实现（`store/index.js`）：

```js
setInterval(() => {
  if (document.hidden) return                 // 后台不发
  const id = storage.deviceRowId
  if (id) api.heartbeat(id).catch(() => {})   // 静默
}, 60000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { api.heartbeat(storage.deviceRowId).catch(() => {}) }
})
```

---

## 8. 管理端改造

| 页面 | 内容 |
|---|---|
| **数据总览** | "在线用户/在线设备"改为真实值（修正 A7）；增加"今日活跃设备" |
| **在线监控（新增）** | 在线用户列表（user/phone/设备数/最后活跃/IP）→ 支持"强制下线"；可按设备类型筛选 |
| **账号详情** | 该账号的设备列表 + 在线状态 + 强制下线 |
| **审计日志** | 新增 action：`force_offline_device`、`session_conflict`（记录冲突设备与 IP） |

接口见 §5.5 与 §5.3。

---

## 9. 验收用例

| # | 场景 | 期望 |
|---|---|---|
| 1 | A 手机在线，同账号在 B 电脑登录（`notify`） | A 弹出"账号在另一台设备登录"，B 正常进入 |
| 2 | A 手机在线，同账号在 B 登录（`single`） | A 收到 `kicked_by_new_login` → 跳登录页；B 正常进入 |
| 3 | 关闭 A 的 App（不点退出） | 150 秒内 `is_online=0`（心跳超时 + 无 socket） |
| 4 | A 直接关标签页 | WS 断开 → socket_count=0 → 心跳超时后离线 |
| 5 | A 开两个标签页，关一个 | 仍在线（socket_count=1） |
| 6 | 用户手动"下线本机" | 立即 401 + WS `device:removed` → 跳登录页 |
| 7 | 管理员强制下线某设备 | 同上，且审计日志有记录 |
| 8 | 管理后台在线数 | 与实际在线设备一致（不再累计） |

---

## 10. 风险

| 风险 | 说明 / 缓解 |
|---|---|
| 多实例部署 | `socket_count` 在 DB 里，多实例下计数仍正确（各实例 increment/decrement），但 `emitToUsers` 跨实例失效 → 需要 socket.io Redis Adapter（当前单实例，先不做） |
| 心跳被后台暂停 | Capacitor App 切后台会暂停 JS → 心跳停 → 150s 后判离线。**这是期望行为**，回前台补心跳即可恢复 |
| `single` 模式误踢 | 新设备登录瞬间旧设备被踢，若用户在新设备登录失败会两边都掉线 → 建议 `single` 仅在登录**成功后**执行踢人 |
| 移动端"被踢"体验 | Android/iOS 上 WS 断开可能不立即回调 → 依赖下次 HTTP 请求 401（JWT 守卫）兜底，前端需在全局拦截器里处理 401 → 跳登录页 |

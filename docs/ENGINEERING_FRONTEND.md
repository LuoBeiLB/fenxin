# 前端工程文档 — 焚毁 V6.0 + 在线状态

> 仓库：`fenxin`（Vue 3 + Vite + Capacitor，当前 HEAD `39b80e4 版本117`）
> 配套：[BURN_V2_DESIGN.md](./BURN_V2_DESIGN.md) · [ENGINEERING_BACKEND.md](./ENGINEERING_BACKEND.md) · [ONLINE_PRESENCE.md](./ONLINE_PRESENCE.md)

---

## 1. 改动总览

| 文件 | 改动 |
|---|---|
| `src/store/index.js` | ①焚毁时长持久化 ②倒计时重同步 ③`message:destroyed` 监听 ④`session:conflict` 监听 ⑤心跳定时器 ⑥会话未读数改用后端值 |
| `src/views/ChatRoom.vue` | ①墓碑渲染 ②群聊已读进度 ③倒计时口径 ④已读上报带上界 |
| `src/views/Me.vue`（设备管理） | 在线状态标记、本机标识、下线按钮 |
| `src/utils/ws.js` | 新增 `MESSAGE_DESTROYED` / `SESSION_CONFLICT` / `DEVICE_ONLINE` / `DEVICE_OFFLINE` |
| `src/utils/format.js` | `thumbURLOf` 清理（已死代码）；`BURN_OPTIONS` 与后端上限对齐（≤30 天） |
| `src/api/index.js` | 新增 `heartbeat`、`getReaders`、`getPendingDestroy`、`ackDestroy`；`markRead` 支持 body |
| 新增 `src/views/DeviceManager.vue`（可选） | 设备列表页（若当前在 Me.vue 内嵌则改造 Me.vue） |

---

## 2. 焚毁相关

### 2.1 字段语义（前端只认这几个）

| 字段 | 含义 | 前端用法 |
|---|---|---|
| `burn_ttl_seconds` | 用户选的持续时长，NULL = 非焚毁 | 判断"是否焚毁消息"（`isBurnMsg`） |
| `remain_seconds` | **服务端算好的剩余秒数**（已与 `destroy_at` 对齐） | 唯一倒计时种子 |
| `burn_at` | 本人这份的到期时刻（绝对时间） | 仅兜底/调试展示，**不再用于计算** |
| `is_destroyed` / `is_burned` | 已焚毁 | 渲染墓碑 |
| `destroyed_at` / `destroy_reason` | 焚毁时间/原因 | 墓碑副标题（可选展示原因） |

> 关键变更：**`remain_seconds` 成为唯一倒计时来源**（后端已改为 `min(burn_at, destroy_at)`），前端不要再拿 `burn_at`/`destroy_at` 自己算。

### 2.2 焚毁消息渲染状态机

```
is_destroyed/is_burned = true        → 【已焚毁】墓碑（无内容、无按钮）
is_blurred = true                    → 【焚毁XX · 点击查看】（点击 → reveal）
音视频 + 焚毁                        → 自动 reveal，直接显示播放器 + "播完即焚"
已点开 + remain_seconds > 0          → 正常内容 + 角标「N 后焚毁」
已点开 + remain_seconds = 0          → 【已焚毁】墓碑
非焚毁                               → 正常消息
```

**墓碑渲染（ChatRoom.vue 模板新增分支）**

```html
<template v-else-if="isBurned(m)">
  <div class="burn-tombstone">
    <svg class="tomb-ico" ...>🔥</svg>
    <span>此消息已焚毁</span>
    <span v-if="m.destroyed_at" class="tomb-time">{{ fmtTime(m.destroyed_at) }}</span>
  </div>
</template>
```

> 现有实现是用 localStorage 幽灵（`bm_burned_msgs`）补占位，**只在本机有效**。改为后端下发墓碑后：
> - 保留 localStorage 幽灵作为**兜底**（后端未返回墓碑时）
> - 墓碑优先级：`m.is_destroyed === true` > 本地幽灵

### 2.3 倒计时机制（修 3 个已知问题）

| 问题 | 现状 | 改法 |
|---|---|---|
| 只种一次，永不重同步 | `store:112` `if (state.burnLeft[m.id] != null) return false` | 增加显式重同步入口（回前台/收到 `message:destroyed` 时） |
| 后台冻结导致僵尸显示 | 无 `visibilitychange` 处理 | 回前台立即重拉 + 重种倒计时 |
| 用绝对时间兜底会受时钟偏差影响 | `burnCountdown` 的 `m.burn_at` 分支 | 该分支仅保留给 demo/老数据，正常消息一律走 `remain_seconds` |

```js
// store/index.js
export function resyncBurnCountdown() {
  for (const m of state.messages) {
    if (m.id == null || m.burn_ttl_seconds == null) continue
    delete state.burnLeft[m.id]          // 清掉冻结值
  }
  state.messages.forEach(seedBurnLeft)   // 用最新 remain_seconds 重新种
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (state.chat) { loadMessages(true); resyncBurnCountdown() }
  else loadConvs(true)
  refreshAnnUnread()
  api.heartbeat(storage.deviceRowId).catch(() => {})
})
```

### 2.4 焚毁时长选择持久化（接后端 `default_burn_ttl_seconds`）

```js
// 登录成功后 / bootstrap() 里
const profile = await api.getProfile()
state.burnSeconds = profile.default_burn_ttl_seconds ?? 0   // 0 = 关闭

// setBurn 时回写
export function setBurn(v) {
  state.burnSeconds = v
  state.mediaBurnOn = false
  api.updateProfile({ default_burn_ttl_seconds: v || null }).catch(() => {})  // 静默
  if (v) showToast('阅后即焚：' + labelOf(v))
}
```

> 后端 `PUT /auth/profile` 已支持三态（正整数 = 设置、`null` = 清除、不传 = 不变），无需额外接口。
> `BURN_OPTIONS` 建议裁到后端上限内（当前最大 604800 = 7 天，后端上限 30 天，兼容）。

### 2.5 轮询改进

```js
let msgLoading = false
setInterval(async () => {
  if (msgLoading || document.hidden) return          // 后台不轮询 + 在途不叠加
  if (!state.chat || state.demoMode) return
  msgLoading = true
  try { await loadMessages(true) } finally { msgLoading = false }
}, 4000)
```

### 2.6 新增 WS 监听

```js
// utils/ws.js
MESSAGE_DESTROYED: 'message:destroyed',
SESSION_CONFLICT: 'session:conflict',
DEVICE_ONLINE: 'device:online',
DEVICE_OFFLINE: 'device:offline',

// store/index.js
onWs(WS_EVENTS.MESSAGE_DESTROYED, p => {
  const set = new Set((p.message_ids || []).map(String))
  for (const m of state.messages) {
    if (set.has(String(m.id))) { m.is_destroyed = true; m.is_burned = true; delete state.burnLeft[m.id] }
  }
})
```

> 有了这个事件，"焚毁后多久从界面消失"不再依赖 4 秒轮询，变成**实时**。

### 2.7 进入会话时的"真删除确认"（两阶段销毁的第二阶段）

后端只负责标记焚毁（`is_destroyed=1`），**真删除要前端进入会话时确认**：

```js
// 打开会话 openChat() → 拉完消息后执行
async function confirmDestroyed(cid) {
  try {
    const { pending } = await api.getPendingDestroy(cid)      // GET /messages/:cid/pending-destroy
    if (!pending || !pending.length) return
    const r = await api.ackDestroy(cid, {                     // POST /messages/:cid/destroy-ack
      message_ids: pending.map(p => p.message_id),
    })
    // r = { acked, purged, purged_ids }
    // 把已被真删的消息从本地列表移除（改用墓碑渲染）
    const purged = new Set((r.purged_ids || []).map(String))
    for (const m of state.messages) {
      if (purged.has(String(m.id))) { m.is_destroyed = true; m.is_burned = true; m.purged = true }
    }
  } catch (e) { /* 静默：失败不影响主流程，下次进会话再试 */ }
}
```

**交互设计（建议静默）**

| 方案 | 说明 | 建议 |
|---|---|---|
| 静默 ack | 进会话自动确认，用户无感；墓碑本来就已显示"已焚毁" | ✅ **推荐**（默认） |
| 弹窗确认 | "有 3 条消息已焚毁，是否立即清理？" | 仅在合规要求"用户知情"时启用，用 env/灰度开关控制 |

> 为什么静默是安全的：用户此时看到的已经是墓碑（`is_destroyed=1`），内容早已不可见；确认只是让服务端释放存储，不改变可见性。

**调用时机（三处）**

1. `openChat()` 拉完首屏消息后
2. 从后台回到前台且当前在会话页（`visibilitychange`）
3. 收到 WS `message:destroyed` 后（说明刚有新墓碑，顺带确认上一批）

---

## 3. 已读 / 未读

### 3.1 私聊"对方已读"（现有，保留）

`state.readWatermark` 机制不动：
- 打开会话：`loadReadWatermark()` 取本人最后一条消息的回执
- WS `receipt:read` 推进水位线
- 本人消息 `created_at <= readWatermark` 显示"已读"

### 3.2 群聊已读进度（新增）

```js
// 打开消息操作菜单/长按消息时拉一次
const r = await api.getReaders(m.id)
// { total: 4, revealed: 3, burned: 2, readers: [...] }
```

UI 两种形态（二选一，建议都做）：

1. **消息气泡下方小字**：`3/4 已读`（仅自己发的消息显示）
2. **详情弹层**：列出每个成员的头像 + 状态（已读/已点开/未读）

```html
<div v-if="!isMine(m) === false && m.type !== 'text' || true" class="read-progress">
  {{ readersOf(m).revealed }}/{{ readersOf(m).total }} 已读
</div>
```

### 3.3 会话未读数改用后端值

```js
// loadConvs()
state.convs = list.map(c => ({ ...c, unread: c.unread_count ?? 0 }))   // 后端新字段
```

保留本地自增（WS 新消息时 `c.unread++`）作为即时反馈，但**每次拉列表以服务端为准**（解决换设备未读丢失）。

### 3.4 已读上报带上界

```js
// 打开会话时只标到"当前可见的最后一条"
const lastVisible = state.messages[state.messages.length - 1]
api.markRead(c.id, { up_to_message_id: lastVisible?.id }).catch(() => {})
```

> 避免"刚进会话就把后面没看过的也标成已读"。

---

## 4. 在线状态与登录冲突

### 4.1 心跳

```js
// store/index.js startTimers()
timers.push(setInterval(() => {
  if (document.hidden) return
  const id = storage.deviceRowId
  if (id) api.heartbeat(id).catch(() => {})
}, 60000))
```

### 4.2 登录冲突弹窗

```js
// App.vue
onWs(WS_EVENTS.SESSION_CONFLICT, p => {
  if (p.reason === 'kicked_by_new_login') {
    showBlockingDialog({
      title: '账号已在其他设备登录',
      text: '当前设备已被下线，请重新登录。',
      confirmText: '重新登录',
      onConfirm: () => forceLogout(),
      closable: false,
    })
    return
  }
  // notify：仅提醒，可关闭
  showDialog({
    title: '账号在另一台设备登录',
    text: `${p.new_device?.name || '未知设备'}${p.new_device?.ip ? ' · ' + p.new_device.ip : ''}`,
    confirmText: '我知道了',
  })
})
```

### 4.3 设备管理页

| 列 | 展示 |
|---|---|
| 设备名 / 类型 | `device_name` / `device_type` |
| 状态 | 🟢 在线 / ⚪ 离线（`is_online`）+ 最后活跃时间 |
| 本机标识 | 与 `storage.deviceRowId` 相同 → "本机" |
| 操作 | 非本机 → "下线"（`POST /auth/devices/:id/offline`） |

---

## 5. 兼容性

| 场景 | 处理 |
|---|---|
| 后端未升级（无 `is_destroyed` 墓碑） | 回退到现有 localStorage 幽灵逻辑 |
| 后端未升级（无 `unread_count`） | 回退到本地计数 |
| 老版本 App（无心跳） | 后端按"WS 在线"兜底，不影响 |
| `default_burn_ttl_seconds` 为 null | `state.burnSeconds = 0`（关闭） |

---

## 6. 验收清单

| # | 场景 | 期望 |
|---|---|---|
| 1 | 选 7 天焚毁发消息 | 角标显示"7d 后焚毁"；刷新 App 后档位仍是 7 天 |
| 2 | 对方点开 7 天消息 | 双方角标一致；7 天后同时切墓碑（WS 实时，无需等轮询） |
| 3 | App 切后台 10 分钟再回来 | 消息列表立即刷新、倒计时与后端一致（不出现"僵尸消息"） |
| 4 | 群聊 4 人已读 3 人 | 气泡显示"3/4 已读"；第 4 人点开后变"4/4 已读" |
| 5 | 换设备登录 | 未读数与旧设备一致（来自后端 `unread_count`） |
| 6 | 同账号另一台设备登录 | 本机弹"账号在另一台设备登录"；`single` 模式下本机被踢到登录页 |
| 7 | 关闭 App 3 分钟 | 管理端该设备显示离线 |
| 8 | 设备管理页 | 本机标"本机"、在线状态正确、可下线其他设备 |
| 9 | 消息被标记焚毁后再次进入会话 | 先看到墓碑 → 前端自动 ack → 服务端真删 → 再次进入仍是墓碑（来自 `message_tombstones`） |
| 10 | 前端 ack 失败（断网） | 静默重试，不阻塞聊天；下次进会话再 ack |

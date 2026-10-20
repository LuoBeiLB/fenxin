# 管理端工程文档 — 焚毁 V6.0 + 已读 + 在线监控

> 管理后台是独立前端项目，对接 `http://<host>:9091/api/v1` 管理接口
> 配套：[BURN_V2_DESIGN.md](./BURN_V2_DESIGN.md) · [ENGINEERING_BACKEND.md](./ENGINEERING_BACKEND.md) · [ENGINEERING_FRONTEND.md](./ENGINEERING_FRONTEND.md) · [ONLINE_PRESENCE.md](./ONLINE_PRESENCE.md)

---

## 1. 现有管理端能力盘点（已核实）

| 模块 | 接口 | 状态 |
|---|---|---|
| 数据总览 | `GET /stats/overview` | ✅ 12 项指标，但**"在线设备数"是错的**（`is_online` 从不置 false） |
| 账号管理 | `GET/POST /accounts`、`batch`、`import`、`:id/reset-password`、`:id/toggle-status`、`DELETE :id`、`departments` | ✅ 完整 |
| 群组管理 | `GET /groups/admin/all`、`DELETE /groups/admin/:id` | ✅ 列表 + 强制解散 |
| 系统公告 | `POST /announcements`、`GET /announcements/manage`、`DELETE /:id` | ✅ |
| 意见反馈 | `GET /feedback/admin/all`、`PUT /feedback/admin/:id/reply` | ✅ |
| App 版本 | `GET /app-versions/manage`、`POST`、`PATCH /:id`、`DELETE /:id` | ✅ |
| 审计日志 | `GET /audit-logs` | ✅ |
| **消息管理** | — | ❌ **完全没有** |
| **焚毁记录** | — | ❌ 无（`destroy_receipts` 表存在但从未写入） |
| **已读/未读统计** | — | ❌ 无 |
| **在线监控** | — | ❌ 无（只有失真的 `online_devices` 计数） |
| **数据保留策略配置** | — | ❌ 无（靠 env） |

---

## 2. 新增页面结构

```
数据总览（改造）
├─ 原有 12 指标
├─ 修正：在线用户 / 在线设备（真实值）
└─ 新增焚毁指标：今日焚毁数、焚毁原因分布、平均存活时长

消息管理（新）
├─ 消息检索（会话/发送人/类型/是否焚毁/时间范围）
├─ 消息详情（内容、回执、焚毁状态、附件）
└─ 手动焚毁（留痕）

焚毁记录（新）
├─ 销毁流水列表（时间 / 消息 / 会话 / 原因 / 操作人）
└─ 按原因筛选、导出

已读统计（新）
├─ 会话维度：已读率、未读数分布、最久未读
└─ 消息维度：谁已读 / 谁未读 / 谁已点开（焚毁消息）

在线监控（新）
├─ 在线用户列表（设备数 / 最后活跃 / IP）
├─ 在线设备列表（按类型筛选）
└─ 强制下线

系统设置（新）
└─ 数据保留策略（PURGE_RETENTION_DAYS 等）
```

---

## 3. 新增接口契约

> 统一响应 `{ code: 0, message, data }`；全部 `@Roles('admin')`；写操作全部落 `audit_logs`。

### 3.1 消息管理

```
GET /admin/messages
  ?conversation_id&sender_id&type&is_destroyed&burn_only
  &start_time&end_time&keyword&page&pageSize
resp:
{
  "data": [{
    "id", "conversation_id", "conversation_name", "conversation_type",
    "sender_id", "sender_name", "type",
    "content_snippet",              // 焚毁/加密消息返回占位，不回真内容
    "is_encrypted", "is_recalled", "is_destroyed",
    "burn_ttl_seconds", "destroy_at", "destroyed_at", "destroy_reason",
    "created_at"
  }],
  "total"
}
```

```
GET /admin/messages/:id
resp:
{
  "message": { ...完整字段（加密消息不回 cipher_text 以外的明文） },
  "receipts": { "total": 5, "read": 3, "revealed": 2, "burned": 1 },
  "destroy_record": { "destroyed_at", "destroy_reason", "operator" } | null
}
```

```
POST /admin/messages/:id/destroy    { "reason": "admin_manual" }
resp: { "success": true }
副作用：is_destroyed=1, destroyed_at=now, destroy_reason='admin_manual'
       写 audit_logs(action='admin_destroy_message')
       推 WS message:destroyed 给会话成员
```

### 3.2 焚毁记录

```
GET /admin/destroy-records
  ?reason&start_time&end_time&conversation_id&page&pageSize
resp:
{
  "data": [{
    "message_id", "conversation_id", "conversation_name",
    "sender_name", "type", "burn_ttl_seconds",
    "created_at", "destroyed_at",
    "alive_seconds",                 // destroyed_at - created_at
    "destroy_reason",                // fallback_expired / all_read / admin_manual / owner_dissolve
    "operator_id", "operator_name"   // 仅手动/解散类有
  }],
  "total"
}
```

> 数据来源二选一：①直接查 `messages`（`is_destroyed=1`）；②落地 `destroy_receipts` 审计表（推荐，物理清理后仍可查）。

### 3.3 已读统计

```
GET /admin/read-stats/conversations/:id
resp:
{
  "member_count": 5,
  "members": [{
    "user_id", "display_name",
    "read_count": 120,        // 已读数（is_read=1）
    "unread_count": 3,        // 未读数
    "last_read_at": "...",
    "last_read_message_id": "..."
  }],
  "message_read_rate": [      // 近 20 条消息的已读率
    { "message_id", "created_at", "read": 3, "total": 4 }
  ]
}
```

```
GET /admin/read-stats/messages/:id
resp:
{
  "total": 4, "read": 3, "revealed": 2, "burned": 1,
  "readers": [{ "user_id", "display_name", "is_read", "read_at", "revealed_at", "burn_at" }]
}
```

### 3.4 在线监控（详见 ONLINE_PRESENCE.md §5.5）

```
GET  /admin/presence/overview
GET  /admin/presence/devices?online_only=true&device_type&page&pageSize
POST /admin/devices/:deviceId/offline        // 强制下线，写审计
```

### 3.5 数据保留策略

```
GET /admin/settings/retention
resp: {
  "ack_fallback_days": 7,        // 超期未确认 → 强制真删
  "purge_ack_threshold": 1,      // 群聊确认人数阈值（1=任一成员确认即可）
  "burn_fallback_hours": 24,     // 兜底时长
  "online_ttl_seconds": 150
}

PUT /admin/settings/retention  { "ack_fallback_days": 30 }
resp: { "success": true }     // 落库（新增 settings 表）或写 env 需重启
```

### 3.6 待真删队列（新增，运维视角）

```
GET /admin/destroy-records?stage=pending_purge
```

用于观察"已标记但还没被客户端确认"的消息积压：

```jsonc
{
  "data": [{
    "message_id", "conversation_type", "conversation_name",
    "destroyed_at", "destroy_reason",
    "acked_count": 0,            // 已确认的人数
    "members_need": 4,           // 需要确认的人数（群聊 n-1）
    "will_purge_at": "2026-10-27T10:00:00Z"   // destroyed_at + ack_fallback_days
  }],
  "total": 3
}
```

> 这是排查"消息明明已焚毁、为什么磁盘/库里还有"的关键视图。

---

## 4. 数据总览指标改造

`GET /stats/overview` 新增：

```jsonc
{
  "online_users": 12,               // 修正：真实在线
  "online_devices": 18,             // 修正
  "today_destroyed": 47,            // 新增：今日焚毁消息数
  "destroy_reason_today": {         // 新增：焚毁原因分布
    "all_read": 31, "fallback_expired": 14, "admin_manual": 2
  },
  "avg_alive_seconds": 812,         // 新增：平均存活时长
  "burn_messages_active": 23        // 新增：当前未焚毁的焚毁消息数
}
```

> `today_destroyed` 查 `messages WHERE is_destroyed=1 AND destroyed_at >= 今日零点`。

---

## 5. 字段清理对管理端的影响

| 字段 | 影响 | 处理 |
|---|---|---|
| `conversation_members.muted` | 若管理端群成员表格展示了"免打扰"列 | 删除该列 |
| `conversations.ai_enabled` | 频道详情可能展示"AI 开关" | 删除 |
| `conversations.is_channel` | 若列表用 `is_channel` 判断类型 | 改为 `type === 'channel'` |
| `messages.is_destroyed` | 原表格可能展示为"已删除" | 改为"已焚毁"语义 + 原因列 |
| `destroy_receipts` 表 | 未落地 | 若采用 §3.2 方案②，需提供查询页 |

---

## 6. 权限与审计

| 操作 | 审计 action | 说明 |
|---|---|---|
| 手动焚毁消息 | `admin_destroy_message` | 记录 operator、message_id、reason |
| 强制下线设备 | `force_offline_device` | 记录 operator、device_id、user_id |
| 修改保留策略 | `update_retention_settings` | 记录旧值/新值 |
| 强制解散群 | `dissolve_group`（已有） | — |

> 所有 `/admin/*` 写操作必须 `@Roles('admin')`；建议再加一层"二次确认"（前端输入群名/消息 id 确认），参照现有 `DELETE /accounts/:id` 的做法。

---

## 7. 验收用例

| # | 场景 | 期望 |
|---|---|---|
| 1 | 数据总览 | 在线用户/设备与"在线监控"页一致；今日焚毁数 = 焚毁记录今日条数 |
| 2 | 消息检索：勾选"仅焚毁消息" | 只返回 `burn_ttl_seconds IS NOT NULL` 的消息 |
| 3 | 查看一条已焚毁消息 | 显示焚毁时间/原因；内容为占位（不泄露） |
| 4 | 手动焚毁一条消息 | 状态变已焚毁、写审计、用户端实时收到 `message:destroyed` |
| 5 | 焚毁记录按 `all_read` 筛选 | 只返回阅读完成导致的焚毁 |
| 6 | **待真删队列** | 已标记但未被确认的消息全部出现在此；`will_purge_at = destroyed_at + ack_fallback_days` |
| 7 | 会话已读统计 | 各成员已读数之和 + 未读数 = 消息总数（排除已焚毁） |
| 8 | 在线监控 → 强制下线 | 被踢设备立即 401，审计有记录 |
| 9 | 修改保留策略为 30 天 | 保存成功；`purge` 任务按新值执行（重启生效时需提示） |

---

## 8. 实施优先级

| 优先级 | 内容 | 理由 |
|---|---|---|
| **P0** | 数据总览修正在线数 + 焚毁指标 | 现有指标失真，管理决策会被误导 |
| **P0** | 焚毁记录列表 + **待真删队列** | 解决"消息怎么突然没了 / 为什么还有残留"的排查刚需 |
| **P1** | 消息检索 + 详情 + 手动焚毁 | 合规/审计基础能力 |
| **P1** | 在线监控 + 强制下线 | 账号共用/被盗用的处置手段 |
| **P2** | 已读统计 | 运营分析用 |
| **P2** | 保留策略配置页 | 可先用 env 顶着 |

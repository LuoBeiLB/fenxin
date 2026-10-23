# 后端工程文档 — 焚毁机制 V6.0 实施

> 配套设计：[BURN_V2_DESIGN.md](./BURN_V2_DESIGN.md)
> 仓库：`fenxin-server`（NestJS 10 + TypeORM 0.3 + MySQL 8）

---

## 0. 实现状态（2026-10-20 已完成）

| 项 | 状态 | 说明 |
|---|---|---|
| 实体/表结构 | ✅ | `is_destroyed` 启用 + `destroyed_at`/`destroy_reason`；新增 `message_tombstones`、`message_destroy_acks`；删除 `muted`/`ai_enabled`/`is_delivered` |
| 迁移 | ✅ | `1767800000000-BurnV6SoftDelete.ts`，本地 `yy` 已执行成功（幂等） |
| 发送时 `destroy_at` | ✅ | `now + max(兜底, ttl)`；旧客户端 `destroy_at` 反算 ttl |
| reveal 延长 `destroy_at` | ✅ | 首次点开推到 `≥ burn_at`；`remain_seconds = min(burn_at, destroy_at)` |
| 调度器阶段①（标记） | ✅ | 只 UPDATE 标记 + 广播 WS `message:destroyed`，**不再删除** |
| 调度器阶段②（真删） | ✅ | `DestroyService`：确认即删 / `ACK_FALLBACK_DAYS` 超期兜底 |
| 新接口 | ✅ | `GET /messages/:cid/pending-destroy`、`POST /messages/:cid/destroy-ack`、`POST /:cid/read {up_to_message_id}`；`GET /:id/readers` 已于 V6.9 并入 `GET /:id/receipt` |
| 会话未读数 | ✅ | `GET /conversations` 返回 `unread_count` |
| 墓碑返回 | ✅ | `listMessages` 合并 `messages.is_destroyed=1` 与 `message_tombstones`；会话无消息时也能返回墓碑 |
| 旧 `destroyMessage()` | ✅ | 已删除，物理删除统一走 `DestroyService.purge()` |
| 单测 | ✅ | 19 suites / 173 tests 全绿（含新增 `destroy.service.spec.ts`、重写 `burn.scheduler.spec.ts`） |

**与设计的差异（有意为之）**

1. **缩略图不清理**：`purge()` 只删 `file_url` + `file_original_url`。缩略图残留按团队决定保留（见 §9）。
2. **`PURGE_RETENTION_DAYS` 未使用**：真删除的兜底时长改由 `ACK_FALLBACK_DAYS` 控制（语义更贴切：等确认，而不是等保留期）。
3. **群聊阈值**：`PURGE_ACK_THRESHOLD=1`（任一成员确认即删）；设为 `0` 时要求 n-1 全部确认。
4. **`/readers` 已删除（V6.9）**：其聚合能力并入 `GET /:id/receipt`（每条回执加 `is_sender`，前端自行算「3/4 已读」），同时修掉按人查姓名的 N+1。

---

## 1. 改动总览

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/entities/message.entity.ts` | 改 | 启用 `is_destroyed`；新增 `destroyed_at`、`destroy_reason`；补 `idx_messages_burn_scan / idx_messages_purge` |
| `src/entities/conversation-member.entity.ts` | 改 | 删 `muted`；`joined_at` 保留并在成员列表暴露 |
| `src/entities/conversation.entity.ts` | 改 | 删 `ai_enabled`（`is_channel` 暂留） |
| `src/entities/message-receipt.entity.ts` | 改 | `is_delivered` 删除（或补齐语义，见决策点 4） |
| `src/modules/message/dto/index.ts` | 改 | `SendMessageDto` 加兼容字段 `destroy_at`；新增 `MarkReadDto`（`up_to_message_id`） |
| `src/modules/message/message.service.ts` | 改 | `sendMessage` 新公式 + 旧字段兼容；`revealMessage` 延长 `destroy_at`；`applyBurnView` 对齐口径；`edit/recall/receipt` 加 `is_destroyed` 守卫；`markAsRead` 支持上界 |
| `src/modules/message/burn.scheduler.ts` | **重写** | 阶段①只标记（不删除）；阶段②由前端确认驱动真删除，超期兜底 |
| `src/modules/message/destroy.service.ts` | **新增** | 真删除核心：校验 → 事务删行/回执 → 写墓碑 → 删附件（本地 + OSS） |
| `src/entities/message-tombstone.entity.ts` | **新增** | 墓碑表实体（真删后前端仍有"已焚毁"占位） |
| `src/entities/message-destroy-ack.entity.ts` | **新增** | 确认记录实体 |
| `src/modules/message/message.controller.ts` | 改 | 新增 `GET /messages/:cid/pending-destroy`、`POST /messages/:cid/destroy-ack`；`POST /:id/read` 接受 body；`GET /:id/readers` 已并入 `GET /:id/receipt` |
| `src/modules/conversation/conversation.service.ts` | 改 | 会话列表返回 `unread_count` |
| `src/modules/events/events.types.ts` | 改 | 新增 `message:destroyed` 事件 |
| `src/database/migrations/*` | 新增 | 见 §6 |

---

## 2. 实体变更

```ts
// message.entity.ts
@Column({ default: false })
@Index('idx_messages_burn_scan')
is_destroyed: boolean;

/** 实际标记焚毁的时刻（软删时间，物理清理任务依据） */
@Column({ type: 'datetime', nullable: true })
destroyed_at: Date | null;

/** 焚毁原因：fallback_expired / all_read / owner_dissolve / admin_dissolve / manual */
@Column({ length: 20, nullable: true })
destroy_reason: string | null;
```

> `burn_ttl_seconds`、`destroy_at` 语义调整（不改列定义）：
> - `burn_ttl_seconds`：**用户选择的"消息持续时长"**，NULL = 非焚毁
> - `destroy_at`：**绝对销毁上限** = `created_at + max(兜底, ttl)`，点开时按需延长

---

## 3. 接口契约变更

### 3.1 `POST /messages`（发送）

```jsonc
{
  "conversation_id": "uuid",
  "type": "text",
  "burn_ttl_seconds": 604800,   // 新客户端
  "destroy_at": "2026-10-27T10:00:00Z"  // 旧客户端（deprecated，兼容用）
}
```

**兼容逻辑**：`burn_ttl_seconds` 优先；缺失但有 `destroy_at` → 反算 ttl（`clamp(ceil((destroy_at-now)/1000), 1, MAX_TTL)`）。

**新公式**：

```ts
const MAX_TTL = 30 * 24 * 3600;           // 与用户偏好字段保持一致（30 天）
let ttl = params.burnTtlSeconds ?? null;
if (ttl == null && params.destroyAt) {    // 兼容旧客户端
  const ms = new Date(params.destroyAt).getTime() - Date.now();
  if (Number.isFinite(ms) && ms > 0) ttl = Math.min(Math.ceil(ms / 1000), MAX_TTL);
}
const fallbackMs = burnFallbackTtlMs();   // env BURN_FALLBACK_TTL_HOURS，默认 24h
const destroyAt = ttl ? new Date(Date.now() + Math.max(fallbackMs, ttl * 1000)) : null;
```

### 3.2 `POST /messages/:id/reveal`（点开）

响应追加/修正：

```jsonc
{
  "remain_seconds": 604800,          // 与 destroy_at 对齐后的剩余秒数
  "burn_at": "2026-10-27T10:00:00Z",
  "media_burn_pending": false,
  "consume_deadline": null
}
```

**首次点开必须延长 `destroy_at`**：

```ts
if (!receipt.revealed_at) {
  const burnMs = burnAt.getTime();
  const curMs = msg.destroy_at ? new Date(msg.destroy_at).getTime() : 0;
  if (burnMs > curMs) await msgRepo.update(msg.id, { destroy_at: new Date(burnMs) });
  // ...原有 receipt 更新与 WS 广播
}
```

### 3.3 `GET /messages/:conversationId`（列表）

- **保持** 排除 `is_destroyed=1` 的普通内容
- **新增** 焚毁消息墓碑（仅 `burn_ttl_seconds IS NOT NULL` 且 `destroyed_at` 在保留期内）：
  ```jsonc
  { "id": "...", "is_destroyed": true, "is_burned": true,
    "content": null, "file_url": null, "destroyed_at": "...", "destroy_reason": "all_read" }
  ```
  目的：跨设备一致的"已焚毁"占位，替代 localStorage 幽灵

### 3.4 `GET /conversations`（会话列表）

```jsonc
{
  "id": "...", "type": "group", "name": "...",
  "unread_count": 12,          // 新增
  "last_message_at": "..."
}
```

聚合 SQL（一次查询避免 N+1）：

```sql
SELECT m.conversation_id, COUNT(*) AS unread_count
FROM messages m
JOIN message_receipts r ON r.message_id = m.id AND r.user_id = :me
WHERE r.is_read = 0 AND m.is_destroyed = 0
  AND m.conversation_id IN (:...ids)
GROUP BY m.conversation_id
```

### 3.5 `GET /messages/:id/receipt`（回执明细；**已合并原 `/readers` 能力**）

> V6.9 变更：原 `GET /messages/:id/readers` 与 `/receipt` 返回的是同一份
> `message_receipts` 数据，功能重复；且前端三处都在用 `/receipt`、`/readers` 零调用，
> 因此**删除 `/readers`**，把它的能力并入 `/receipt`。

```jsonc
// GET /messages/:id/receipt → 仍是数组（前端 asArray 不用改）
[
  {
    "id": "receipt-id",
    "message_id": "uuid",
    "user_id": "uuid",
    "user_display_name": "张三",
    "is_sender": true,          // ← V6.9 新增：哪条是发送者本人那份
    "is_read": true,
    "read_at": "...",
    "revealed_at": "...",
    "burn_at": "..."
  }
]
```

前端聚合「3/4 已读」：

```js
const others = items.filter(r => !r.is_sender)
const readCount = others.filter(r => r.is_read).length   // 已读
const total = others.length                              // 总人数（n-1）
```

实现要点：**一次 LEFT JOIN 取回姓名**，修掉原先「每个回执查一次 users」的 N+1
（100 人群聊从 101 次 SQL 降到 2 次）。

### 3.6 `POST /messages/:conversationId/read`（已读上报）

```jsonc
{ "up_to_message_id": "uuid" }   // 可选；不传 = 整会话（保持旧行为）
```

```sql
UPDATE message_receipts SET is_read=1, read_at=NOW()
WHERE user_id=:me AND is_read=0
  AND message_id IN (
    SELECT id FROM messages
     WHERE conversation_id=:cid
       AND (:upTo IS NULL OR created_at <= (SELECT created_at FROM messages WHERE id=:upTo))
  )
```

### 3.7 `GET /messages/:conversationId/pending-destroy`（前端进入会话时调用）

返回"已标记焚毁、等待确认真删"的消息列表（**只给 id 和元数据，不含任何内容**）：

```jsonc
{
  "conversation_id": "...",
  "pending": [
    { "message_id": "...", "destroy_reason": "all_read",
      "destroyed_at": "2026-10-20T10:00:00Z", "has_attachment": true }
  ],
  "total": 1
}
```

实现：查 `messages WHERE conversation_id=? AND is_destroyed=1 AND NOT EXISTS(ack by 本用户)`。
> 该接口本身**不删任何东西**，只负责让前端知道"哪些该确认了"。

### 3.8 `POST /messages/:conversationId/destroy-ack`（确认真删）

```jsonc
{
  "message_ids": ["uuid1", "uuid2"]   // 显式确认；也可传 "all": true 表示该会话全部待删
}
```

响应：

```jsonc
{
  "acked": 2,          // 本次写入的确认条数
  "purged": 1,         // 因满足策略而真正删除的消息数
  "purged_ids": ["uuid1"]
}
```

**后端处理流程（必须严格按序）**

```ts
for (const id of dto.message_ids) {
  const msg = await msgRepo.findOne({ where: { id, conversation_id: cid } });
  if (!msg) continue;
  await assertMember(cid, userId);                    // ① 成员校验（否则 403）
  if (!msg.is_destroyed) throw new BadRequestException('只能确认已焚毁的消息'); // ② 状态校验
  await ackRepo.upsert({ message_id: id, user_id: userId, device_id, acked_at: now }); // ③ 幂等写确认

  // ④ 策略判定：满足才真删
  const shouldPurge =
    conv.type === 'private' ? true                     // 私聊：发起人确认即删
    : ackCount(id) >= 1;                               // 群聊：任一成员确认即删（可配置为 n-1）
  if (shouldPurge) await this.destroyService.purge(id, 'ack_by_user');
}
```

**`DestroyService.purge(messageId, trigger)`**（新增，唯一真删除入口）

```ts
async purge(messageId: string, trigger: 'ack_by_user' | 'ack_timeout' | 'admin') {
  const msg = await msgRepo.findOne({ where: { id: messageId } });
  if (!msg || !msg.is_destroyed) return false;         // 已删/未标记 → 幂等跳过

  await this.dataSource.transaction(async (em) => {
    // 写墓碑（保留 id/会话/发送者/时间/原因，不含内容）
    await em.getRepository(MessageTombstone).upsert({ id: msg.id, ... }, ['id']);
    await em.getRepository(MessageDestroyAck).delete({ message_id: msg.id });
    await em.getRepository(MessageReceipt).delete({ message_id: msg.id });
    await em.getRepository(Message).update({ reply_to_id: msg.id }, { reply_to_id: null });
    await em.getRepository(Message).delete({ id: msg.id });     // ← 真删除
  });

  // 附件物理删除（事务外，失败只告警）：本地 + OSS，含原图与缩略图
  await this.deleteAttachments(msg);
  return true;
}
```

> **这是系统里唯一的物理删除入口**。现有 `MessageService.destroyMessage()`（生产环境零调用）应删除，避免两条路径。

---

## 4. 服务层关键改动

| 方法 | 改动 |
|---|---|
| `sendMessage` | 新 `destroy_at` 公式；兼容 `destroy_at` 入参；`burn_ttl_seconds` 上限 `MAX_TTL` |
| `revealMessage` | ①首次点开延长 `destroy_at`；②`remain_seconds` 用 `min(burn_at, destroy_at)` 计算；③`is_destroyed` 消息 404（已有） |
| `consumeMessage` | 同样按 `consume` 后 `remain_seconds=0`；不必改 `destroy_at` |
| `applyBurnView` | `remain_seconds` 改为 `ceil((min(burnAt, destroyAt) - now)/1000)`，杜绝"显示 7 天实际 1 天" |
| `listMessages` | 增加墓碑返回（§3.3） |
| `editMessage` / `recallMessage` | **新增** `if (message.is_destroyed) throw BadRequest('消息已焚毁')` |
| `getMessageReceipts` | **新增** `if (message.is_destroyed) throw NotFound()` |
| `markAsRead` | 支持 `up_to_message_id` 上界 |
| `updateOriginalFile` | 已有 `is_destroyed` 守卫，保留 |
| `destroyMessage`（现有） | **删除该方法**，统一走 `DestroyService.purge()`（避免两条物理删除路径） |
| `listMessages` | 已焚毁消息返回墓碑；墓碑来源优先 `message_tombstones`（真删后），其次 `messages` 行（标记未删） |

---

## 5. 调度器重写

```ts
// burn.scheduler.ts
@Cron(CronExpression.EVERY_MINUTE)
async markDestroyed() {
  const now = new Date();
  let total = 0;

  // R1 兜底
  total += await this.markBatch('fallback_expired', `
    m.is_destroyed = 0 AND m.destroy_at IS NOT NULL AND m.destroy_at <= :now`, { now });

  // R2 阅读完成（私聊/群聊同一条 SQL，n-1 自动适配）
  total += await this.markBatch('all_read', `
    m.is_destroyed = 0
    AND m.burn_ttl_seconds IS NOT NULL
    AND EXISTS (SELECT 1 FROM message_receipts r
                 WHERE r.message_id = m.id AND r.user_id <> m.sender_id)
    AND NOT EXISTS (SELECT 1 FROM message_receipts r
                     WHERE r.message_id = m.id AND r.user_id <> m.sender_id
                       AND (r.revealed_at IS NULL OR r.burn_at IS NULL OR r.burn_at > :now))`, { now });

  if (total) this.logger.log(`Marked ${total} message(s) as destroyed`);
}

// 阶段② 真删除：两来源 —— ①前端已确认 ②超期兜底；每小时跑一次
@Cron('0 * * * *')
async purgeConfirmedOrExpired() {
  const ackDays = parseInt(process.env.ACK_FALLBACK_DAYS || '7', 10);
  const cutoff = new Date(Date.now() - ackDays * 86400_000);

  // A. 已被确认的（满足策略）→ 立即真删
  //    私聊：任一确认；群聊：≥ PURGE_ACK_THRESHOLD（默认 1）人确认
  const acked = await this.findConfirmedPending(process.env.PURGE_ACK_THRESHOLD || '1');
  for (const m of acked) await this.destroyService.purge(m.id, 'ack_by_user');

  // B. 超期未确认 → 兜底真删（防止用户永不打开会话导致堆积）
  const expired = await this.findAckTimeoutPending(cutoff);
  for (const m of expired) await this.destroyService.purge(m.id, 'ack_timeout');

  if (acked.length + expired.length) {
    this.logger.log(`Purged ${acked.length} acked + ${expired.length} timeout message(s)`);
  }
}
```

> **注意**：阶段① 只写 `is_destroyed`，**不碰附件**；附件只在阶段② `purge()` 里删除。
> `PURGE_ACK_THRESHOLD=1` 表示任一成员确认即可真删；设为 `0` 表示必须 n-1 全部确认。

**WS 事件（新增）**

```ts
MESSAGE_DESTROYED: 'message:destroyed'
payload: { conversation_id, message_ids: string[], reason: 'fallback_expired'|'all_read' }
```

推给会话全体成员 → 前端就地切"已焚毁"，不再依赖 4 秒轮询。

---

## 6. 迁移（新文件 `1767800000000-BurnV6SoftDelete.ts`）

```sql
-- ① 列语义确认
ALTER TABLE messages MODIFY COLUMN is_destroyed tinyint(1) NOT NULL DEFAULT 0;

-- ② 审计列
ALTER TABLE messages
  ADD COLUMN destroyed_at datetime NULL AFTER is_destroyed,
  ADD COLUMN destroy_reason varchar(20) NULL AFTER destroyed_at;

-- ②b 墓碑表（真删除后仍能渲染"已焚毁"）
CREATE TABLE IF NOT EXISTS message_tombstones (
  id              varchar(36) NOT NULL PRIMARY KEY,
  conversation_id varchar(36) NOT NULL,
  sender_id       varchar(36) NOT NULL,
  type            varchar(20) NOT NULL,
  created_at      datetime    NOT NULL,
  destroyed_at    datetime    NOT NULL,
  destroy_reason  varchar(20) NOT NULL,
  KEY idx_tomb_conv (conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT '已真删除消息的轻量墓碑（不含任何内容）';

-- ②c 确认记录表
CREATE TABLE IF NOT EXISTS message_destroy_acks (
  id         varchar(36) NOT NULL PRIMARY KEY,
  message_id varchar(36) NOT NULL,
  user_id    varchar(36) NOT NULL,
  device_id  varchar(36) NULL,
  acked_at   datetime    NOT NULL,
  UNIQUE KEY uk_ack_msg_user (message_id, user_id),
  KEY idx_ack_msg (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT '真删除确认记录';

-- ③ 索引
CREATE INDEX idx_messages_burn_scan ON messages (is_destroyed, destroy_at);
CREATE INDEX idx_messages_purge ON messages (is_destroyed, destroyed_at);

-- ④ 存量修正（被截断的 destroy_at）
UPDATE messages
   SET destroy_at = DATE_ADD(created_at, INTERVAL burn_ttl_seconds SECOND)
 WHERE burn_ttl_seconds IS NOT NULL
   AND (destroy_at IS NULL OR destroy_at < DATE_ADD(created_at, INTERVAL burn_ttl_seconds SECOND));

-- ⑤ 冗余列（决策点 4 确认后）
ALTER TABLE conversation_members DROP COLUMN muted;
ALTER TABLE conversations DROP COLUMN ai_enabled;
```

**回滚**：`down()` 逆序（删索引/列、`is_destroyed` 归 0 不还原已删数据）。
**幂等**：全部用 `information_schema` 判断（对齐现有 6 个迁移的写法）。

---

## 7. 单元测试清单

| 文件 | 用例 |
|---|---|
| `message.service.spec.ts` | ①7 天档 `destroy_at = created+7d`（不再 24h）②旧客户端 `destroy_at` 反算 ttl ③`reveal` 延长 `destroy_at` ④`remain_seconds = min(burn_at, destroy_at)` ⑤已焚毁消息不可编辑/撤回/查回执 |
| `burn.scheduler.spec.ts` | ①R1/R2 只标记不删行 ②R2 私聊（1 人到期即标记）③R2 群聊（n-1 全到期才标记，缺 1 人不标记）④幂等（重复执行不重复写 `destroyed_at`）⑤阶段②只处理"已确认 或 超期"⑥`ACK_FALLBACK_DAYS` 边界 |
| `destroy.service.spec.ts`（新） | ①`purge` 只接受 `is_destroyed=1` ②事务内写墓碑 + 删回执 + 断引用 + 删行 ③附件删除（本地 + OSS）④重复 purge 幂等（墓碑不重复、不报错）⑤未标记消息 purge 直接返回 false |
| `message.controller.spec.ts` | ①`pending-destroy` 只返回本会话未确认的 ②`destroy-ack` 成员校验 403 ③对未焚毁消息 ack → 400 ④`receipt` 带 `is_sender` 且只发一次 JOIN 查询 |
| `conversation.service.spec.ts` | 会话列表 `unread_count` 聚合正确（排除已焚毁） |

> 注：现有 `test/modules/message/{encrypted-send,mentions}.spec.ts` 仍传 2 参构造 `MessageService`，本次改动前需先修（`OssService` 已是第 3 参）。

---

## 8. 上线验收 SQL

```sql
-- ① 7 天档的新消息：destroy_at 应为 created+7d
SELECT id, burn_ttl_seconds, TIMESTAMPDIFF(HOUR, created_at, destroy_at) AS span_h
FROM messages WHERE burn_ttl_seconds > 86400 ORDER BY created_at DESC LIMIT 5;

-- ② 焚毁标记是否生效（应只有 0/1，且 1 的有 destroyed_at）
SELECT is_destroyed, destroy_reason, COUNT(*) FROM messages GROUP BY 1,2;

-- ③ 是否存在"该焚毁但没焚"的（超期未标记）
SELECT COUNT(*) FROM messages
WHERE is_destroyed = 0 AND destroy_at IS NOT NULL AND destroy_at < NOW();

-- ④ 是否存在"被提前焚毁"的（标记时间早于个人到期）
SELECT COUNT(*) FROM messages m
JOIN message_receipts r ON r.message_id = m.id AND r.user_id <> m.sender_id
WHERE m.is_destroyed = 1 AND r.burn_at IS NOT NULL AND m.destroyed_at < r.burn_at;

-- ⑤ 阶段①/② 分离是否正常：标记未删（行还在）+ 待确认
SELECT COUNT(*) AS marked_not_purged
FROM messages m
WHERE m.is_destroyed = 1
  AND NOT EXISTS (SELECT 1 FROM message_tombstones t WHERE t.id = m.id);

-- ⑥ 已真删除的（应为 0 行 messages + 有墓碑）
SELECT COUNT(*) AS purged_with_tombstone FROM message_tombstones;
SELECT COUNT(*) AS leaked_rows FROM messages m
JOIN message_tombstones t ON t.id = m.id;    -- 期望 0：真删后不应再有消息行

-- ⑦ 确认记录与待确认分布
SELECT COUNT(*) FROM message_destroy_acks;
```

---

## 9. 风险与注意事项

| 风险 | 缓解 |
|---|---|
| 存量数据量大时 `④` UPDATE 锁表 | 分批 `LIMIT 1000` 循环执行，或低峰期执行 |
| 软删后表膨胀 | 启用 purge（§5），并给 `is_destroyed, destroyed_at` 建索引 |
| 老 APK 兼容 | §3.1 反算逻辑；上线前用 `destroy_at` 造一条消息验证 |
| 墓碑返回可能被老前端当成空消息 | 灰度：先只对新消息返回墓碑；或加接口参数 `include_tombstone=1` |
| 调度器每分钟两次 `LIMIT 500` | 加复合索引 `(is_destroyed, destroy_at)`，避免全表扫 |

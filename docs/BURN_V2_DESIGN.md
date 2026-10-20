# 焚信 BurnMsg — 焚毁机制重构设计（V6.0）

> 状态：**待确认**（第 8 节有 6 个决策点需要你拍板）
> 范围：后端 `fenxin-server`、移动端 `fenxin`（Vue + Capacitor）、管理后台
> 作者：基于 2026-10 代码库审计

**配套文档**

| 文档 | 内容 |
|---|---|
| [ENGINEERING_BACKEND.md](./ENGINEERING_BACKEND.md) | 后端改动清单、接口契约、迁移、单测、验收 SQL |
| [ENGINEERING_FRONTEND.md](./ENGINEERING_FRONTEND.md) | 前端渲染状态机、倒计时、已读 UI、在线/冲突弹窗 |
| [ENGINEERING_ADMIN.md](./ENGINEERING_ADMIN.md) | 管理端新增页面、接口、优先级 |
| [ONLINE_PRESENCE.md](./ONLINE_PRESENCE.md) | 在线状态与登录冲突（独立专项，可与本重构并行） |

---

## 1. 背景与目标

### 1.1 现状问题（均已核实）

| # | 问题 | 证据 |
|---|---|---|
| P1 | **`destroy_at` 与 `burn_ttl_seconds` 无关联，ttl > 兜底时长时被截断** | `message.service.ts:185` `destroy_at = now + 24h`（与 ttl 无关）。实测：7 天档消息在 24 小时被删 |
| P2 | **`remain_seconds` 与 `destroy_at` 语义分裂** | `applyBurnView:285`、`revealMessage:396` 只按 `burn_at` 算倒计时；删除只看 `destroy_at` → 前端显示"还有 7 天"，实际 24 小时就删 |
| P3 | **物理删除**，销毁不可审计 | `burn.scheduler.ts:70-77` 直接 `DELETE FROM messages` |
| P4 | 私聊/群聊焚毁条件**没有显式区分** | 靠回执数量隐式实现（`NOT EXISTS (receipt with burn_at > now)`） |
| P5 | 表字段冗余/未使用 | 见 §2.2 |
| P6 | 已读未读**只有半套** | 无会话未读数接口；群聊无"已读进度"UI；`is_delivered` 只写不读 |

### 1.2 目标

1. **显式区分**私聊与群聊的焚毁条件
2. **软删除为主**（`is_destroyed=1`），物理清理为辅且可配置
3. **`destroy_at` 重定义**为"绝对销毁上限"，且**不得早于 `发送 + burn_ttl_seconds`**
4. `remain_seconds` / `destroy_at` / `is_destroyed` **单一真相**，前后端不再各自算
5. 清理冗余字段，补齐已读未读

---

## 2. 现状审计

### 2.1 现有焚毁状态机

```
发送 → burn_ttl_seconds=ttl, destroy_at=now+24h, is_destroyed=0
       → 给全体成员建 message_receipts（is_read=false, revealed_at=null, burn_at=null）
       → WS message:new 下发【马赛克版】

点开(POST /reveal) → receipt.revealed_at=now, burn_at=now+ttl
                   → 广播 receipt:read

每分钟 BurnScheduler：
  规则A  destroy_at <= now                              → DELETE（物理）
  规则B  burn_ttl_seconds NOT NULL
         AND (destroy_at IS NULL OR destroy_at > now)
         AND 所有非发送方 receipt.burn_at <= now         → DELETE（物理）
```

**关键缺陷**：规则 A 与 ttl 完全脱钩；规则 B 被规则 A 抢先（24h 后 `destroy_at` 已过期，规则 B 的 `destroy_at > now` 条件永不成立）。

### 2.2 未使用 / 冗余字段清单

| 表 | 字段 | 后端引用 | 前端引用 | 结论 |
|---|---|---|---|---|
| `conversation_members` | `muted` | **0** | 0（`ChatRoom.vue:90` 是 HTML 属性，误匹配） | **可直接删**（或实现免打扰） |
| `conversation_members` | `joined_at` | 0 读（`@CreateDateColumn` 自动写入） | 0 | **保留但暴露**（群成员列表展示加入时间） |
| `conversations` | `ai_enabled` | 1（仅 `channel.service.ts:192` 返回，无逻辑） | **0** | P2 预留，**建议删** |
| `conversations` | `is_channel` | 4（与 `type='channel'` 重复） | 21 | **重复语义**：建议以 `type` 为唯一真相，前端改造后删列 |
| `message_receipts` | `is_delivered` | 2（均为写：`:205`、`:351`） | 0（3 处为误匹配） | **只写不读**，删除或补齐"已送达"逻辑 |
| `conversation_members` | `last_read_message_id` | 只写（`message.service.ts:562`） | 仅用 WS payload | 保留（作为未读数计算依据） |
| `messages` | `is_destroyed` | 11（**只读不写**，永远是 0） | 0 | **本次重构启用** |
| `messages` | `is_edited` | 1（只写） | 5（显示"已编辑"） | 保留 |
| `destroy_receipts`（表） | 整表 | **0 引用**（无实体） | 0 | 孤儿表：**落地为审计表**或删除 |
| `devices` | `is_online` | 写 `true`（登录）、**从不置 `false`** | 0 | 统计指标失真：删除或补心跳 |

### 2.3 已读 / 未读现状

**已实现（数据层完整）**

| 能力 | 位置 | 说明 |
|---|---|---|
| 每消息 × 每成员回执 | `message_receipts` | 发送时全量创建，`is_read=false` |
| 已读上报 | `POST /messages/:conversationId/read` → `markAsRead:539` | **整会话批量** UPDATE + 更新 `last_read_message_id` |
| 已读回执查询 | `GET /messages/:id/receipt` | 返回全部成员的 `is_read/read_at` + `user_display_name` |
| 实时已读推送 | WS `receipt:read` | 仅在 `affected > 0` 时广播 |
| 点开时刻 | `receipt.revealed_at` | 焚毁专用，语义 = "看到了内容" |

**未实现 / 缺口**

| 缺口 | 影响 |
|---|---|
| ❌ **会话未读数无后端接口** | 前端靠本地 `c.unread++` 维护，换设备/重装即丢失 |
| ❌ 群聊"已读 X/Y"无 UI | `getReceipt` 只在私聊水位线用到（`store:548`） |
| ⚠️ 已读是"整会话批量"，**无法逐条已读** | 滚动到一半也会把后续消息标记已读 |
| ⚠️ `last_read_message_id` 只写不读 | 无法反查"读到哪条" |

---

## 3. 新语义定义

### 3.1 名词

| 名词 | 字段 | 定义 |
|---|---|---|
| 发送时刻 | `messages.created_at` | — |
| 消息持续时长 | `messages.burn_ttl_seconds` | 用户选择；**NULL = 非焚毁消息**（永不自动销毁） |
| 兜底时长 | env `BURN_FALLBACK_TTL_HOURS` | 默认 24h，防"无人阅读永不销毁" |
| 点开时刻 | `message_receipts.revealed_at` | 每人一份 |
| 个人到期 | `message_receipts.burn_at` | `revealed_at + burn_ttl_seconds` |
| 绝对销毁上限 | `messages.destroy_at` | 见 §3.2 |
| 已焚毁标记 | `messages.is_destroyed` | 0/1（本次启用） |

### 3.2 `destroy_at` 新定义（核心）

**约束**：`destroy_at` 不得早于任何可能的个人到期时刻，否则会出现"消息持续时间还没结束就被删"。

```
发送时： destroy_at = created_at + max(fallback, burn_ttl_seconds)
点开时： destroy_at = max(destroy_at, burn_at)            ← 必须，见下方反例
```

**为什么点开时还要延长**（反例）：

```
ttl = 7 天，fallback = 24h
发送时      destroy_at = send + 7d
对方在 send+23h 点开 → burn_at = send + 7d 23h
若不延长    → 第 7 天整被 R1 删掉，对方少了 23 小时  ❌
延长后      → destroy_at = send + 7d 23h，正常到期    ✅
```

### 3.3 焚毁判定（每分钟扫描）

| 规则 | 条件 | 结果 |
|---|---|---|
| **R1 兜底** | `now >= destroy_at` | `is_destroyed=1`, `destroy_reason='fallback_expired'` |
| **R2 私聊** | 唯一非发送方 `revealed_at IS NOT NULL` 且 `burn_at <= now` | `is_destroyed=1`, `destroy_reason='all_read'` |
| **R2 群聊** | **所有**非发送方 `revealed_at IS NOT NULL` 且 `burn_at <= now` | 同上 |

> R2 私聊是 `n-1 = 1` 的特例，SQL 可复用；但**代码里显式分两支**，便于埋点与后续差异化（如私聊可做"点开立即焚"，见 §8 决策点 1）。

**实现约束**
- 只扫描 `is_destroyed = 0` 的焚毁消息，每批 `LIMIT 500`，可重复执行（幂等）
- "没到期就保持 0"：**不回写 0**（避免每分钟全表 UPDATE）
- 标记后**不删除行、不删除附件**

### 3.4 两阶段销毁：标记 ≠ 真删除

**确认过（2026-10-20）：必须保留真删除，但真删除要由前端进入页面时发起确认、后端校验后才执行。**

```
阶段①  标记（服务端自动，每分钟）
       到期 → is_destroyed=1, destroyed_at=now, destroy_reason=...
       内容与附件【原样保留】，只是对用户不可见（墓碑可见）

阶段②  真删除（前端确认驱动）
       前端进入会话 → GET  /messages/:cid/pending-destroy   拿到待真删列表
                    → POST /messages/:cid/destroy-ack       确认（可静默）
       后端校验：成员身份 + 消息确实 is_destroyed=1
       校验通过 → 物理删除（行 + 回执 + 附件），写入 message_tombstones

兜底   超过 ACK_FALLBACK_DAYS（默认 7 天）仍未被确认 → 调度器强制真删
```

**为什么需要兜底**：如果用户永不打开该会话，确认永远不来，行与附件会无限堆积。

**为什么要有墓碑表**：真删除后消息行没了，前端就无法渲染"此消息已焚毁"占位。新增极简表 `message_tombstones` 承载占位信息：

```sql
CREATE TABLE message_tombstones (
  id            varchar(36)  NOT NULL PRIMARY KEY,   -- 原 message id
  conversation_id varchar(36) NOT NULL,
  sender_id     varchar(36)  NOT NULL,
  type          varchar(20)  NOT NULL,
  created_at    datetime     NOT NULL,               -- 原消息发送时间
  destroyed_at  datetime     NOT NULL,
  destroy_reason varchar(20) NOT NULL,
  KEY idx_tomb_conv (conversation_id, created_at)
) COMMENT '已真删除消息的轻量墓碑，仅用于前端渲染「已焚毁」占位';
```

> 这样"真删除"的含义明确：**消息正文、附件文件、回执全部物理删除**，只留下不含任何内容的墓碑元数据。

### 3.5 可见性

- `is_destroyed=1` → 列表 / 搜索 / `reveal` **全部不可见**
- 现有代码里所有读取路径**已经是** `is_destroyed = false` 过滤（`message.service.ts:304/673/779/331`），**天然兼容**
- **建议**：列表接口对焚毁消息返回**墓碑**（`is_destroyed=true`，`content/file_url` 置 null），让"已焚毁"占位在所有设备一致，替代现在只存在本机 localStorage 的幽灵方案

---

## 4. 数据模型变更

```sql
-- ① 启用 is_destroyed 语义（列已存在，确认类型）
ALTER TABLE messages
  MODIFY COLUMN is_destroyed tinyint(1) NOT NULL DEFAULT 0
  COMMENT '0=正常 1=已焚毁（软删，列表/搜索/reveal 均不可见）';

-- ② 新增审计列
ALTER TABLE messages
  ADD COLUMN destroyed_at datetime NULL COMMENT '实际标记焚毁的时刻' AFTER is_destroyed,
  ADD COLUMN destroy_reason varchar(20) NULL
    COMMENT 'fallback_expired / all_read / owner_dissolve / admin_dissolve / manual' AFTER destroyed_at;

-- ②b 墓碑表（真删除后仍能渲染"已焚毁"）
CREATE TABLE message_tombstones (
  id             varchar(36) NOT NULL PRIMARY KEY,
  conversation_id varchar(36) NOT NULL,
  sender_id      varchar(36) NOT NULL,
  type           varchar(20) NOT NULL,
  created_at     datetime    NOT NULL,
  destroyed_at   datetime    NOT NULL,
  destroy_reason varchar(20) NOT NULL,
  KEY idx_tomb_conv (conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT '已真删除消息的轻量墓碑（不含任何内容）';

-- ②c 确认记录（哪台设备/哪个用户何时确认真删）
CREATE TABLE message_destroy_acks (
  id         varchar(36) NOT NULL PRIMARY KEY,
  message_id varchar(36) NOT NULL,
  user_id    varchar(36) NOT NULL,
  device_id  varchar(36) NULL,
  acked_at   datetime    NOT NULL,
  UNIQUE KEY uk_ack_msg_user (message_id, user_id),
  KEY idx_ack_msg (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT '真删除确认记录';

-- ③ 调度器扫描索引
CREATE INDEX idx_messages_burn_scan ON messages (is_destroyed, destroy_at);
CREATE INDEX idx_messages_purge ON messages (is_destroyed, destroyed_at);

-- ④ 存量数据修正：把被截断的 destroy_at 抬到 created_at + ttl
UPDATE messages
   SET destroy_at = DATE_ADD(created_at, INTERVAL burn_ttl_seconds SECOND)
 WHERE burn_ttl_seconds IS NOT NULL
   AND (destroy_at IS NULL OR destroy_at < DATE_ADD(created_at, INTERVAL burn_ttl_seconds SECOND));

-- ⑤ 清理冗余列（按 §8 决策点 4 确认后执行）
ALTER TABLE conversation_members DROP COLUMN muted;
ALTER TABLE conversations DROP COLUMN ai_enabled;
-- is_channel 需前端改造完成后才能删
-- DROP TABLE destroy_receipts;   ← 若决定不落地审计表
```

---

## 5. 调度器改造（伪代码）

```ts
@Cron(CronExpression.EVERY_MINUTE)
async markDestroyed() {
  const now = new Date();

  // R1 兜底到期
  await this.markAndLog({ now, reason: 'fallback_expired', where: 'm.destroy_at IS NOT NULL AND m.destroy_at <= :now' });

  // R2 阅读完成：私聊 / 群聊显式分两支
  await this.markAndLog({ now, reason: 'all_read', where: `
    m.burn_ttl_seconds IS NOT NULL
    AND EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id=m.id AND r.user_id<>m.sender_id)
    AND NOT EXISTS (SELECT 1 FROM message_receipts r
                     WHERE r.message_id=m.id AND r.user_id<>m.sender_id
                       AND (r.revealed_at IS NULL OR r.burn_at IS NULL OR r.burn_at > :now))
  ` });

  // 墓碑推送（可选）：把本批 id 广播给会话成员，前端就地切"已焚毁"
}

// 阶段② 真删除：由前端确认触发（见 §3.4），调度器只做兜底
@Cron('0 * * * *')   // 每小时
async purgeConfirmedOrExpired() {
  const ackDays = parseInt(process.env.ACK_FALLBACK_DAYS || '7', 10);
  const cutoff  = new Date(Date.now() - ackDays * 86400_000);

  // 条件A：被确认过的（ack 记录存在且满足策略）→ 立即真删
  // 条件B：超过 ACK_FALLBACK_DAYS 仍未确认 → 兜底真删
  // 两者都：删除行 + 回执 + 附件，写入 message_tombstones
}
```

---

## 6. 兼容与灰度

| 场景 | 处理 |
|---|---|
| **存量焚毁消息**（destroy_at 已被截断） | 执行 §4 ④ 的 UPDATE 修正 |
| **老 APK 仍发 `destroy_at`** | `SendMessageDto` 增加兼容字段：无 `burn_ttl_seconds` 但有 `destroy_at` → 反算 ttl 并落库（见后端文档 §3.3） |
| **前端读墓碑** | 列表返回墓碑（来自 `message_tombstones`）；老前端不识别 → 按普通消息显示空内容，需确认可接受 |
| **老版本 App 不会发确认** | 走兜底：`ACK_FALLBACK_DAYS` 到期后服务端强制真删，不会永久堆积 |
| **管理后台** | 需新增"焚毁记录/已读统计/在线监控"页（见管理端文档） |

**灰度建议**：先上线"阶段①标记"（R1/R2 只写 `is_destroyed`，确认接口与真删除都关掉），观察 1 周后再开阶段②。

---

## 7. 验收用例

| # | 场景 | 期望 |
|---|---|---|
| 1 | 私聊发 7 天焚毁，对方不点开 | 第 7 天（created+7d）`is_destroyed=1`，原因 `fallback_expired` |
| 2 | 私聊发 7 天焚毁，对方 1 小时后点开 | 第 7 天 + 1 小时标记焚毁（`destroy_at` 被 reveal 延长） |
| 3 | 私聊发 7 天焚毁，对方第 6 天点开 | 第 13 天标记焚毁 |
| 4 | 群聊 5 人，4 人都点开但未到期 | 不焚毁（R2 不满足） |
| 5 | 群聊 5 人，4 人都点开且都到期 | 下一分钟 `is_destroyed=1`，原因 `all_read` |
| 6 | 群聊 5 人，其中 1 人始终未点开 | 到 `destroy_at` 由 R1 焚毁 |
| 7 | 非焚毁消息 | 永不被 R1/R2 命中 |
| 8 | 标记后、确认前 | 列表只返回墓碑；`reveal`/搜索不可见；**行与附件仍在库中** |
| 9 | 前端进入会话并发确认 | 后端校验通过 → 行 + 回执 + 附件全部物理删除，写入 `message_tombstones` |
| 10 | 确认后再次进入会话 | 墓碑来自 `message_tombstones`，仍显示"此消息已焚毁" |
| 11 | 无人确认 | `ACK_FALLBACK_DAYS`（默认 7 天）后强制真删 |
| 12 | 重复执行调度器 | 幂等，不重复写 `destroyed_at`、不重复写墓碑 |
| 13 | 非会话成员调确认接口 | 403 |
| 14 | 对未标记的消息调确认接口 | 400（只能确认真删已标记的） |

---

## 8. 决策点

### 8.1 已确认（2026-10-20）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 私聊"点开就焚"是字面意思还是 ttl 到期？ | ✅ **点开后 `burn_ttl_seconds` 到期才焚**。即私聊 = 唯一接收方 `revealed_at` 非空 且 `burn_at <= now`；`burn_ttl_seconds` 在私聊同样生效 |
| 2 | n-1 是否含发送方？ | ✅ **不含**（发送方不参与、不阻塞焚毁，保持现状） |
| 3 | 登录冲突策略 | ✅ **`notify`**：允许多端并存，向其他在线设备弹窗提醒（不做强制单点登录）。详见 [ONLINE_PRESENCE.md](./ONLINE_PRESENCE.md) §5.4 |
| 4 | 是否保留真删除？ | ✅ **保留**，但改为**两阶段**：服务端只标记 → 前端进入会话确认 → 后端校验后才真删（行 + 回执 + 附件），并写入墓碑表。详见 §3.4 |
| 5 | 焚毁后是否保留"已焚毁"墓碑？ | ✅ **保留**（新增 `message_tombstones` 轻量表，跨设备一致） |

### 8.2 仍待确认

| # | 问题 | 我的建议 |
|---|---|---|
| 6 | **确认策略：谁确认才算数？** | 私聊 = 对方确认即可；群聊 = 任一在线成员确认即可（快），其余成员靠墓碑 |
| 7 | **确认是静默还是弹窗？** | **静默**（进入页面即自动 ack，用户无感）；只有在"真删前需要用户知情"的合规要求下才弹窗 |
| 8 | `muted` / `ai_enabled` / `is_channel` / `destroy_receipts` 是否删除？ | `muted`、`ai_enabled` 删；`is_channel` 等前端改造后再删；`destroy_receipts` 与 `message_tombstones` 职责重叠，建议直接用墓碑表 |
| 9 | 真删除兜底天数 `ACK_FALLBACK_DAYS` | 7 天 |
| 10 | 是否补会话未读数接口？ | 补（`GET /conversations` 返回 `unread_count`），否则换设备未读会丢 |

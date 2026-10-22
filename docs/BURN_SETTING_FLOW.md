# 焚毁时长「按人设置」流程（V6.1）

> 配套：[BURN_V2_DESIGN.md](./BURN_V2_DESIGN.md)（焚毁机制本身）
> 实现：`src/modules/burn-setting/` · 表 `burn_settings` · 迁移 `1768000000000-AddBurnSettings.ts`

---

## 1. 方向变更：从「每条消息选」到「按人设一次」

| | V6.0（旧） | V6.1（新） |
|---|---|---|
| 时长从哪来 | 每条消息发送时由客户端传 `burn_ttl_seconds` | **按人/按会话的默认设置**，发消息自动套用 |
| 用户操作 | 每次发消息都要选一次（或依赖全局默认预填） | 进会话查一次，改一次长期生效 |
| 查询接口 | 无 | `GET /burn-settings/conversations/:cid` |
| 发送参数 | 必传 | **可选**（不传则走设置解析） |

---

## 2. 归属规则：**看谁发的消息**（发送方生效）

这是本设计最容易被误解的一点，先讲清楚。

焚毁时长是「发送方给接收方」的**单向**设置，作用在**发送方发出的消息**上：

```
A 给 B 设 5 秒   →  只约束 A → B 的消息：B 点开后 5 秒焚毁
B 给 A 设 1 小时 →  只约束 B → A 的消息：A 点开后 1 小时焚毁
```

**两个方向互不干扰**，所以：

- ❌ 不需要「取较短」
- ❌ 不存在「谁优先」
- ❌ 对方的设置不会影响我发出的消息

真实的计时仍然落在 `message_receipts.burn_at`：每个接收方各自从**自己点开的时刻**起算，
所以同一条消息对不同人可以是不同的到期时间（这一点 V6.0 已经实现，未改动）。

### 解析优先级

```
① 私聊：burn_settings(owner=我, scope=user, scope_id=对方) 
② 群/频道：burn_settings(owner=我, scope=conversation, scope_id=会话)
③ 我的全局默认：app_users.default_burn_ttl_seconds
④ 都没有 → 不焚毁（null）
```

消息级显式传 `burn_ttl_seconds` 仍然**最优先**（保留"这一条特别敏感、临时改短"的能力）。

---

## 3. 时序

```
① 登录
   POST /auth/login → user.default_burn_ttl_seconds（全局默认，仍保留）

② 点开对话框
   GET /burn-settings/conversations/:cid
   ← { effective_ttl_seconds, source, counterpart, my_setting, global_default_seconds }
   → 前端在输入框上方显示「焚毁 · 1 小时」

③ 修改
   PUT /burn-settings/users/:targetUserId { ttl_seconds: 1800 }
   → 立即生效，只影响之后发出的消息

④ 发送
   POST /messages { conversation_id, type, content }      ← 不再传 burn_ttl_seconds
   → 后端 resolveTtlForSend(我, 会话) → 快照进 messages.burn_ttl_seconds

⑤ 对方点开 → reveal → receipt.burn_at = 点开时刻 + ttl（每人各自起算，不变）
⑥ 到期 → 标记焚毁 → 前端确认 → 真删（V6.0 两阶段，不变）
```

---

## 4. 数据模型

```sql
CREATE TABLE burn_settings (
  id          varchar(36) PRIMARY KEY,
  owner_id    varchar(36) NOT NULL,   -- 设置者（视角），只影响其本人发出的消息
  scope_type  varchar(16) NOT NULL,   -- 'user' | 'conversation'
  scope_id    varchar(36) NOT NULL,   -- 对方 user_id 或 conversation_id
  ttl_seconds int NOT NULL,           -- 1 ~ 2592000
  created_at  datetime NOT NULL,
  updated_at  datetime NOT NULL,
  UNIQUE KEY uk_burn_owner_scope (owner_id, scope_type, scope_id)
);
```

- 一张表覆盖两种作用域，避免"按人"和"按会话"两套逻辑分叉
- `owner_id` 保证群聊里每个成员的设置互不影响

---

## 5. 接口清单

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/burn-settings/conversations/:cid` | 进会话查询生效时长（含 `source`） |
| PUT | `/burn-settings/users/:targetUserId` | 设置「我发给这个人的消息」的时长 |
| DELETE | `/burn-settings/users/:targetUserId` | 清除（回落全局默认） |
| PUT | `/burn-settings/conversations/:cid` | 设置「我在这个群」的时长（私聊返回 400） |
| DELETE | `/burn-settings/conversations/:cid` | 清除 |
| GET | `/burn-settings/users` | 我的按人设置列表（设置页） |

`source` 取值：`contact_setting` / `conversation_setting` / `global_default` / `none`。

### 响应示例

```jsonc
// GET /burn-settings/conversations/:cid
{
  "conversation_id": "uuid",
  "conversation_type": "private",
  "counterpart": { "user_id": "uuid", "display_name": "张三" },
  "effective_ttl_seconds": 3600,
  "source": "contact_setting",
  "my_setting": { "ttl_seconds": 3600, "updated_at": "2026-10-21T06:00:00Z" },
  "global_default_seconds": 300
}
```

---

## 6. 客户端（Web / APK）

- **Web**：每次刷新都是最新代码，不涉及版本兼容
- **APK**：走强制更新，因此**不需要**按客户端版本分支

前端只做三件事：

1. 进会话调 `GET /burn-settings/conversations/:cid`，渲染焚毁标签
2. 点标签弹时长选择（沿用 `BURN_OPTIONS`），调 `PUT`
3. 发消息**不再传** `burn_ttl_seconds`

---

## 7. 边界与约束

| 场景 | 行为 |
|---|---|
| 给自己设置 | 400 |
| 目标用户不存在 / 已注销 | 404 |
| `ttl_seconds` 越界（<1 或 >2592000） | 400 |
| 私聊用「会话级」设置 | 400（提示改用按人设置） |
| 非会话成员查群设置 | 403 |
| 清除后无全局默认 | 回落为 `none`，消息不焚毁 |
| 已发出的消息 | **不受影响**（时长已快照） |
| 聊天对象注销后 | 设置保留但无实际作用；查询降级为全局默认 |

### 性能

`resolveTtlForSend` 每次发消息会多 2~3 条查询（会话、成员、设置、全局默认）。
当前量级可接受；若要优化，加一层 60s 的进程内缓存，`PUT` 时失效即可。

---

## 8. 验收用例（已实测，20/20 通过）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 谁都没设，发消息 | `burn_ttl_seconds=null`（不焚毁） |
| 2 | A 给 B 设 3600，A 发消息 | 3600 |
| 3 | B 没设过，B 查询 | `none`（不受 A 设置影响） |
| 4 | B 发消息 | `null`（B→A 方向不焚毁） |
| 5 | B 给 A 设 5，A 查询 | 仍 3600（不取较短） |
| 6 | B 给 A 设 5，B 发消息 | 5（B→A 按 B 的设置） |
| 7 | A 显式传 ttl=60 | 60（消息级覆盖优先） |
| 8 | A 清除设置且无全局默认 | `none` |
| 9 | A 设全局默认 900 | `global_default` → 发消息 900 |
| 10 | A 在群里设 1800 | `conversation_setting` → 群发 1800 |
| 11 | B 在同一群查询 | `none`（各人独立） |
| 12 | 给自己设置 / ttl=0 / 私聊用会话级 | 400 |

单测：`test/modules/burn-setting/burn-setting.service.spec.ts`（14 例）。

---

## 9. 与既有机制的关系

| 机制 | 是否受影响 |
|---|---|
| `destroy_at = 发送 + max(兜底, ttl)` | 不变（ttl 来源变了，公式没变） |
| 首次点开延长 `destroy_at` | 不变 |
| `remain_seconds = min(burn_at, destroy_at)` | 不变 |
| 两阶段销毁（标记 → 确认 → 真删） | 不变 |
| 音视频"播完才焚"消费窗口 | 不变 |
| E2E 加密消息 | 不变（时长与加密无关） |

> 一句话：**V6.1 只改了"时长从哪来"，焚毁本身的判定、计时、销毁链路一行没动。**

# 设备配对私密会话（Secret Chat）— 后端实现方案

> 版本：v1（待评审）
> 状态：设计稿，未实现
> 关联文档：[E2E_ENCRYPTION.md](./E2E_ENCRYPTION.md) · [TOFU_FRONTEND.md](./TOFU_FRONTEND.md) · [websocket-events.md](./websocket-events.md)
> 参考模型：Telegram Secret Chat

---

## 1. 背景与目标

### 1.1 现状问题

当前 E2E 密钥按 **user** 存储（`user_keys` 一用户一行，重复上传即覆盖），导致：

| 问题 | 后果 |
|---|---|
| 手机登录后再电脑登录，公钥被覆盖 | 只有最后登录的设备能解密 |
| 用户不知道哪台设备能解密 | 消息显示"无法解密"，无法自查 |
| 一方清浏览器缓存即生成新钥并静默覆盖 | 历史加密消息永久丢失 |
| 发送方自己也解不开自己发的消息 | 换设备后自己的历史消息全部不可读 |

### 1.2 本次目标

引入 **设备配对私密会话**：

```
一条私密会话 = 发起设备 A1  ↔  接受设备 B2
· 只有这两台设备能看到会话、能收发、能解密
· 双方的其他设备：会话列表里不存在这条
· 关闭后双方都无法再查看内容，且该用户对可立即重新发起
```

### 1.3 非目标（本版不做）

| 不做 | 原因 |
|---|---|
| 群聊/频道的 E2E | 需要 sender keys / X3DH，另开需求 |
| 多设备同时查看同一条私密会话 | 与 Telegram 模型一致，冲突 |
| 附件加密 | 需客户端加密上传 + 密文下载，独立需求 |
| 私密会话的离线推送 | 避免向未绑定设备泄露"存在加密消息"这一元数据 |
| 安全码人工比对（safety number） | 可后续在 TOFU 之上叠加 |

---

## 2. 模型定义

| 概念 | 定义 |
|---|---|
| 私密会话 | `conversations.e2e_mode = 1` 的会话，`type = 'private'` |
| 绑定设备 | `e2e_device_a`（发起）+ `e2e_device_b`（接受） |
| 可见性 | 未激活时双方所有设备可见（作为请求）；激活后**仅两台绑定设备**可见 |
| 与普通私聊的关系 | **并存**：云端私聊不受影响，同一对用户可同时拥有普通私聊 + 私密会话 |

设备标识使用 `devices.id`（JWT `payload.deviceId` 已携带，服务端不信任客户端传参）。

---

## 3. 状态机

> **设计原则：关闭 = 物理删除，不留状态、不留标记、不留记录。**
> 因此只有「存在」和「不存在」两种持久化状态，没有 closed/expired/rejected 这类"墓碑状态"。

```
                      ┌───────────────────────────────┐
                      │ 无（库里没有这一行）           │
                      └───────────────┬───────────────┘
                                      │ A(设备A1) 发起 → 插入一行
                                      ▼
                      ┌───────────────────────────────┐
        B 拒绝 ──────►│ 1 pending（待接受，7 天过期）  │◄──── 发起方可撤回
        （删除该行）   └───────────────┬───────────────┘
                           （删除该行） │ B 接受
                                      ▼
                      ┌───────────────────────────────┐
                      │ 2 active（A1 ↔ B2）           │
                      └───────────────┬───────────────┘
                                      │ 任一方关闭 / 绑定设备被移除 / 管理员强制
                                      ▼
                      ┌───────────────────────────────┐
                      │ 无（该行被物理删除）           │
                      └───────────────────────────────┘
```

**`conversations.e2e_state` 只保留 3 个值**

| 值 | 含义 | 是否占用唯一约束 |
|---|---|---|
| 0 | 非私密会话 | — |
| 1 | pending 待接受 | ✅ 占用 |
| 2 | active 进行中 | ✅ 占用 |

**终止动作一律是"删除行"，而不是"改状态"**

| 动作 | 持久化结果 | 对方如何得知 |
|---|---|---|
| 拒绝 | `DELETE` 该行 | WS `e2e:rejected`；离线则无感知（可重新发起）|
| 撤回（发起方取消 pending） | `DELETE` 该行 | WS `e2e:request_gone` |
| pending 7 天过期 | 定时任务 `DELETE` 该行 | WS `e2e:request_gone`；离线则列表里自然消失 |
| 关闭 active | `DELETE` 该行 + 消息/回执/附件/成员全部删除 | WS `e2e:closed`；离线则下次拉列表时消失 |

> **没有 closed / expired / rejected 这些值**，也就没有"某天 A 和 B 开过私密会话"的元数据残留。
> 唯一约束在行被删除后自动释放，所以"关闭后可立即重新发起"是天然成立的。

---

## 4. 数据模型

### 4.1 迁移 ①：`conversations` 扩展

> 只加"**会话存活期间**需要的字段"。
> **不加** `e2e_closed_at` / `e2e_closed_by` / `e2e_close_reason` —— 关闭即删行，这些字段没有意义，
> 而且保留它们就等于留下"曾经有过私密会话"的痕迹。

```sql
ALTER TABLE `conversations`
  ADD COLUMN `e2e_mode`     tinyint     NOT NULL DEFAULT 0
      COMMENT '0=普通会话 1=设备配对私密会话',
  ADD COLUMN `e2e_state`    tinyint     NOT NULL DEFAULT 0
      COMMENT '0=非私密 1=待接受 2=已激活（终止即删行，无 closed/rejected 状态）',
  ADD COLUMN `user_a`       varchar(36) NULL COMMENT '参与者1（固定取较小 user_id）',
  ADD COLUMN `user_b`       varchar(36) NULL COMMENT '参与者2（固定取较大 user_id）',
  ADD COLUMN `e2e_device_a` varchar(36) NULL COMMENT '发起设备 devices.id',
  ADD COLUMN `e2e_device_b` varchar(36) NULL COMMENT '接受设备 devices.id',
  ADD COLUMN `e2e_pair_key` varchar(80)
      GENERATED ALWAYS AS (
        CASE WHEN `e2e_mode` = 1 AND `e2e_state` IN (1, 2)
             THEN CONCAT(LEAST(`user_a`, `user_b`), ':', GREATEST(`user_a`, `user_b`))
             ELSE NULL END
      ) STORED COMMENT '同一对用户仅允许一个进行中的私密会话（NULL 不参与唯一性）',
  ADD UNIQUE KEY `uk_e2e_pair` (`e2e_pair_key`),
  ADD KEY `idx_e2e_state` (`e2e_mode`, `e2e_state`),
  ADD KEY `idx_e2e_devices` (`e2e_device_a`, `e2e_device_b`);

-- 普通会话无需回填：e2e_mode=0, e2e_state=0
```

**注意**：`idx_e2e_devices` / `idx_e2e_state` 都是普通索引，不包含任何"历史"语义；
行被删除后索引项一并消失，不会留下痕迹。

### 4.2 迁移 ②：`device_keys`（设备级公钥）

```sql
CREATE TABLE `device_keys` (
  `id`              varchar(36)  NOT NULL,
  `user_id`         varchar(36)  NOT NULL,
  `device_id`       varchar(36)  NOT NULL COMMENT 'devices.id',
  `identity_pubkey` varchar(100) NOT NULL COMMENT 'X25519 公钥 base64（44 字符）',
  `created_at`      datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_device_keys_user_device` (`user_id`, `device_id`),
  KEY `idx_device_keys_device` (`device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='每台设备一把 X25519 identity 公钥（替代 user_keys 的单用户单钥）';
```

> `device_keys` 只存**公钥**，不含任何会话关系，无法从它推断谁和谁开过私密会话。

> `user_keys` **保留不删**（历史消息兼容用，见 §10）。

### 4.3 为什么**没有**迁移 ③

原方案里曾有一条"给 `messages.destroy_reason` 增加 `e2e_closed` 取值"的迁移，**已删除**。

| 原因 | 说明 |
|---|---|
| 它会留下痕迹 | 哪怕行 24 小时后被物理删除，期间任何能读库的人都能从 `destroy_reason='e2e_closed'` 推断出"这里曾有一条私密消息" |
| 关闭改成了物理删除 | 既然不存在"软删 24 小时"阶段，就不需要区分销毁原因 |
| 普通销毁原因已够用 | 若将来确实需要走软删，复用现有的 `manual` 即可，**不要新增能指向私密会话的取值** |

**结论：本次只有 2 个迁移** —— `conversations` 扩展 + `device_keys` 建表。

### 4.4 幂等要求

两个迁移都使用 `information_schema` 判断（沿用现有迁移风格），可重复执行。

---

## 5. 接口契约

统一响应封装：`{ code: 0, message, data }`。所有接口需登录，`deviceId` 取自 JWT。

### 5.1 发起私密会话

```http
POST /api/v1/conversations/e2e-request
Content-Type: application/json

{ "target_user_id": "uuid" }
```

**成功 200**

```json
{
  "code": 0,
  "message": "私密聊天请求已发送",
  "data": {
    "conversation_id": "uuid",
    "e2e_state": 1,
    "expires_at": "2026-11-03T10:00:00.000Z"
  }
}
```

**业务规则**

- 必须有 `conversations` 之外的"业务关系"校验：与目标用户存在会话或联系人关系（复用 `keys.service.getPeerUserIds` 的判定），否则 403
- 不能对自己发起（400）
- 同一对用户已有 `pending/active` → 409 `E2E_PAIR_EXISTS`，返回已有 `conversation_id`
- 创建内容：新建 `conversations` 行（`type='private'`, `e2e_mode=1`, `e2e_state=1`, `user_a/user_b`, `e2e_device_a=当前设备`）+ 两条 `conversation_members`
- 广播：向目标用户**全部设备**推 `e2e:requested`（含 `conversation_id`、发起人昵称、`expires_at`）
- 不推送（见 §9）

### 5.2 接受

```http
POST /api/v1/conversations/:id/e2e-accept
```

**成功 200**

```json
{ "code": 0, "message": "私密聊天已开启", "data": { "conversation_id": "uuid", "e2e_state": 2, "bound_device_id": "<本设备>" } }
```

**规则**

- 调用者必须是 `user_a` 或 `user_b`（非成员 403）
- 会话 `e2e_mode=1` 且 `e2e_state=1`，否则 409 `E2E_STATE_INVALID`
- 已 `expired`（`expires_at < now`）→ 先置 5 再返回 410 `E2E_EXPIRED`
- 若接受方已有另一条同对用户的进行中会话（并发场景）→ 409 `E2E_PAIR_EXISTS`
- 事务内：`e2e_state=2, e2e_device_b=当前设备`
- 广播：向 `e2e_device_a` 与 `e2e_device_b` 各发 `e2e:accepted`；向该用户**其他设备**发 `e2e:request_gone`（从请求列表移除）

### 5.3 拒绝

```http
POST /api/v1/conversations/:id/e2e-reject
```

**成功 200**：`{ "code": 0, "message": "已拒绝", "data": { "deleted": true } }`

- 目标用户任一设备可拒绝；发起方不能拒绝自己的请求（应改用 close/撤回）
- **直接删除该会话行**（物理删除，不留 rejected 状态）：唯一约束随行删除自动释放 → **可立即重新发起**
- 广播：向发起设备发 `e2e:rejected`；向拒绝方其他设备发 `e2e:request_gone`

### 5.4 关闭 / 撤回

```http
POST /api/v1/conversations/:id/e2e-close
Content-Type: application/json

{ "reason": "user" }        // 可选：user（默认）| lost_device
```

**成功 200**

```json
{
  "code": 0,
  "message": "私密聊天已结束",
  "data": { "conversation_id": "uuid", "deleted": true, "deleted_messages": 42 }
}
```

**权限**

| 当前状态 | 允许操作的设备 | 语义 |
|---|---|---|
| 1 pending | `e2e_device_a` | 撤回请求 |
| 2 active | `e2e_device_a` 或 `e2e_device_b` | 结束会话 |
| 3/4/5 | — | 幂等返回 200（`already_closed`），或 409 |

**幂等**：重复调用返回同一结果，不报错。

### 5.5 上传本设备公钥

```http
POST /api/v1/keys/device
{ "identity_pubkey": "<base64 44 字符>" }
```

- `user_id` + `device_id` 均取自 JWT，**不接受 body 传参**
- upsert（同一设备重复上传 = 更新；不同设备互不覆盖）
- 首建或变更时向该用户的**共同会话用户**广播 `slot:key:changed`（见 §8）
- 响应：`{ "updated": true|false }`

### 5.6 查询对方设备公钥

```http
GET /api/v1/keys/device/:userId/:deviceId
```

- 关系校验：与目标用户存在共同会话（沿用现有 `keys.service.getIdentityKey` 规则）
- 未上传 → 404 `E2E_KEY_MISSING`
- 响应：`{ user_id, device_id, identity_pubkey, updated_at }`

> **可选优化**：合并到 `GET /conversations/:id/e2e-key`，服务端直接返回"绑定设备的公钥"，减少前端两次请求。

---

## 6. 可见性规则与改造点

### 6.1 可见性判定（单一出口）

```ts
/**
 * 会话对当前设备是否可见。
 * 所有"按用户列会话/取消息"的查询都必须先过这里。
 */
function isVisibleToDevice(conv: Conversation, userId: string, deviceId: string): boolean {
  if (conv.e2e_mode === 0) return true;                       // 普通会话：成员可见
  if (conv.e2e_state === 1) {                                 // pending：双方所有设备可见（作为请求）
    return conv.user_a === userId || conv.user_b === userId;
  }
  if (conv.e2e_state === 2) {                                 // active：仅绑定设备
    return conv.e2e_device_a === deviceId || conv.e2e_device_b === deviceId;
  }
  return false;                                                       // 其余（不该出现）：不可见
}
```

对应 SQL 过滤（会话列表）：

```sql
AND (
  c.e2e_mode = 0
  OR (c.e2e_mode = 1 AND c.e2e_state = 1 AND :userId IN (c.user_a, c.user_b))
  OR (c.e2e_mode = 1 AND c.e2e_state = 2 AND :deviceId IN (c.e2e_device_a, c.e2e_device_b))
  -- 没有 rejected/closed/expired 行：终止即删除，因此不需要额外分支
)
```

### 6.2 改造点清单（10 处，逐条核对）

| # | 文件 | 位置 | 改动 |
|---|---|---|---|
| 1 | `conversation.service.ts` | `listMyConversations` | 加 §6.1 的 SQL 过滤；返回体增加 `e2e_mode` / `e2e_state` / `e2e_expires_at` / `is_bound_device` |
| 2 | `conversation.service.ts` | `getConversation` | 加 `assertVisibleToDevice` |
| 3 | `message.service.ts` | `assertMember` | 新增 `assertDeviceVisible(conversationId, userId, deviceId)`，在 `assertMember` 之后调用 |
| 4 | `message.service.ts` | `listMessages` / `searchInConversation` | 调用 §3 的新守卫 |
| 5 | `message.service.ts` | `sendMessage` | 守卫 + `e2e_mode=1` 时**强制** `is_encrypted=true`（拒绝明文）；`e2e_state≠2` → 409 |
| 6 | `message.service.ts` | `searchGlobal` | JOIN 之后追加 `AND m.conversation_id NOT IN (SELECT id FROM conversations WHERE e2e_mode=1)`（密文不可搜，且不向其他设备泄露存在性）|
| 7 | `conversation.service.ts` | 未读数聚合 | 仅统计可见会话（先取可见 id 集合再聚） |
| 8 | `events.gateway.ts` | `message:new` 等广播 | 私密会话必须 `emitToDevices([a,b])`，**禁止** `emitToUsers` |
| 9 | `push.service.ts` | `notifyNewMessage` | `e2e_mode=1` 时**跳过推送**（v1） |
| 10 | `auth.service.ts` | `removeDevice`（设备下线/踢人） | 联动关闭该设备绑定的所有私密会话（§7.3） |

> 另需覆盖：`burn-setting.service.ts`（私密会话的焚毁设置）、`admin-message.service.ts`（管理端只显示元数据，不返回 `cipher_text`）、`channel/group` 服务（私密会话不应出现在其列表）。

### 6.3 需要返回给前端的字段

```jsonc
// GET /conversations 单项（私密会话）
{
  "id": "uuid",
  "type": "private",
  "e2e_mode": 1,
  "e2e_state": 2,                    // 1=pending 2=active
  "e2e_expires_at": "2026-11-03T10:00:00Z",   // 仅 pending
  "is_bound_device": true,           // 当前设备是否为绑定设备
  "other_user": { "id": "...", "display_name": "..." },
  "peer_device_id": "uuid",          // 对方绑定的设备（active 时才有）
  "unread_count": 3
}
```

---

## 7. 关闭流程（关闭 = 物理删除）

### 7.1 设计原则

| 原则 | 说明 |
|---|---|
| **关闭即删** | 不设 `closed` 状态、不写 `destroy_reason`、不保留软删行 |
| **删干净** | 消息（含密文）、回执、墓碑、成员、会话行、OSS 附件全部删除 |
| **不留可推断的痕迹** | 删除后数据库里没有任何行能指向"这里曾经有过私密会话" |
| **幂等** | 重复关闭返回成功（第二次时行已不存在，直接返回 `already_closed`） |
| **先删对象再删行** | 附件 URL 存在消息行里，必须先把 OSS 对象删掉，再删行 |

> 会话在**存续期间**必然有数据（消息密文、会话行）——这是投递所必需的；
> 我们保证的是**关闭之后一行都不剩**。

### 7.2 关闭事务伪代码

```ts
/**
 * 关闭（或撤回）私密会话：物理删除，不留任何痕迹。
 * @param trigger 'user' | 'device_removed' | 'admin'
 */
async closeSecretChat(
  conversationId: string,
  operatorUserId: string,
  operatorDeviceId: string,
  trigger: 'user' | 'device_removed' | 'admin' = 'user',
) {
  /** 事务外先用它收集需要通知的设备（提交后再发 WS，避免回滚后误通知） */
  let notifyDevices: string[] = [];
  let deletedMessages = 0;

  await this.dataSource.transaction(async (m) => {
    const conv = await m.getRepository(Conversation)
      .createQueryBuilder('c')
      .setLock('pessimistic_write')                    // 防双方同时关闭
      .where('c.id = :id', { id: conversationId })
      .getOne();

    if (!conv) return;                                 // 已关闭过：幂等，什么都不做
    if (conv.e2e_mode !== 1) throw new BadRequestException('不是私密会话');

    // 权限：pending 仅发起设备可撤回；active 两台绑定设备都可关闭；admin 不限
    if (trigger !== 'admin') {
      const allowed = conv.e2e_state === 1
        ? conv.e2e_device_a === operatorDeviceId
        : conv.e2e_device_a === operatorDeviceId || conv.e2e_device_b === operatorDeviceId;
      if (!allowed) throw new ForbiddenException('本设备无权操作该私密会话');
    }

    notifyDevices = [conv.e2e_device_a, conv.e2e_device_b].filter(Boolean) as string[];

    // ① 附件：必须先删 OSS 对象（URL 存在消息行上，删行后就拿不到了）
    const msgs = await m.createQueryBuilder()
      .select(['m.id', 'm.file_url', 'm.file_original_url'])
      .from(Message, 'm')
      .where('m.conversation_id = :cid', { cid: conversationId })
      .getRawMany();
    for (const msg of msgs) {
      await this.oss.deleteByUrl(msg.file_url);                // 内部已 try-catch
      await this.oss.deleteByUrl(msg.file_original_url);
    }

    // ② 回执 / 墓碑
    await m.createQueryBuilder().delete().from(MessageReceipt)
      .where('message_id IN (SELECT id FROM messages WHERE conversation_id = :cid)', { cid: conversationId })
      .execute();
    await m.delete(MessageTombstone, { conversation_id: conversationId });

    // ③ 消息（密文随之物理消失）
    const del = await m.delete(Message, { conversation_id: conversationId });
    deletedMessages = del.affected ?? 0;

    // ④ 会话级配置 / 成员
    await m.createQueryBuilder().delete().from(BurnSetting)
      .where("scope_type = 'conversation' AND scope_id = :cid", { cid: conversationId })
      .execute();
    await m.delete(ConversationMember, { conversation_id: conversationId });

    // ⑤ 会话行本身（唯一约束随行删除自动释放）
    await m.delete(Conversation, { id: conversationId });
  });

  // ⑥ 提交后再广播（device room，不是 user room）
  if (notifyDevices.length > 0) {
    this.events.emitToDevices(notifyDevices, WS_EVENTS.E2E_CLOSED, {
      conversation_id: conversationId,
      trigger,
    });
  }

  return { deleted_messages: deletedMessages };
}
```

**要点说明**

| 点 | 原因 |
|---|---|
| 先取 `notifyDevices`，提交后再广播 | 事务回滚时不能已经把"已结束"事件发出去 |
| 附件先删 | 删行后 `file_url` 就丢了，OSS 对象会变成永久垃圾 |
| 用 `m.delete(...)` 而不是 `update(... is_destroyed=1)` | 软删会留下带 `destroyed_at` 的行，等于留了痕迹 |
| 不写 `audit_logs` | 审计表同样能反推"某天有人开过私密会话"，本方案**刻意不写** |
| 应用日志也别打会话/用户 id | `logger.log('e2e closed conv=...')` 会留痕，只允许打"关闭成功"这种无标识日志 |

### 7.3 设备被移除时联动关闭

```ts
// auth.service.removeDevice(userId, deviceId) 末尾追加
async closeSecretChatsBoundTo(deviceId: string, reason: 'device_removed' = 'device_removed') {
  const rows = await this.dataSource.getRepository(Conversation)
    .createQueryBuilder('c')
    .where('c.e2e_mode = 1 AND c.e2e_state IN (1,2)')
    .andWhere('(c.e2e_device_a = :d OR c.e2e_device_b = :d)', { d: deviceId })
    .getMany();

  for (const c of rows) {
    await this.closeSecretChat(c.id, c.user_a, deviceId, reason);   // 同样是物理删除
  }
}
```

- 触发点：`POST /auth/devices/:deviceId/offline`、会话策略 `single`/`notify` 踢人、管理员强制下线
- 通知：向对方绑定设备发 `e2e:closed`（`trigger='device_removed'`），前端提示"对方设备已下线，私密聊天已结束"
- **注意**：设备被移除后，该设备上的私钥也就失效了（`device_keys` 行同时删除），即使客户端还留着本地缓存也无法再解密新消息

### 7.4 pending 过期（同样是删行）

```ts
// 每 10 分钟扫一次
@Cron('*/10 * * * *')
async expireE2E() {
  const rows = await this.dataSource.getRepository(Conversation)
    .createQueryBuilder('c')
    .where('c.e2e_mode = 1 AND c.e2e_state = 1')
    .andWhere('c.created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)')
    .getMany();

  for (const c of rows) {
    await this.closeSecretChat(c.id, c.user_a, c.e2e_device_a!, 'admin');   // 物理删除
  }
  if (rows.length > 0) this.logger.log(`Expired ${rows.length} e2e request(s)`);
}
```

> 不写 `expired` 状态、不写 `close_reason`：过期就是"这行不存在了"。

### 7.5 关闭后服务端还剩什么（逐项核对）

| 数据 | 关闭后 |
|---|---|
| `messages`（含 `cipher_text` / `content` / `file_url`） | ✅ 全部物理删除 |
| `message_receipts` | ✅ 全部物理删除 |
| `message_tombstones` | ✅ 全部物理删除 |
| `conversation_members` | ✅ 全部物理删除 |
| `conversations`（含 `user_a/user_b`、`e2e_device_a/b`） | ✅ **整行删除** |
| `burn_settings`（会话级焚毁设置） | ✅ 删除 |
| OSS 附件对象 | ✅ 立即删除 |
| `audit_logs` | ✅ **刻意不写** |
| `device_keys` | ⚠️ 保留（这是设备公钥，与具体会话无关，无法反推"和谁聊过"） |

**结论：数据库里没有任何行/字段能指向"这两个人曾经有过一段私密会话"。**

### 7.6 必须如实告知的"残余痕迹"（数据库之外）

即使我们把表清干净，以下位置仍可能残留，属于**基础设施层面**，需要在运维策略上处理：

| 位置 | 残留内容 | 保留期 | 缓解 |
|---|---|---|---|
| **MySQL binlog** | 删除前的 INSERT/UPDATE（含密文） | 默认 `expire_logs_days`/`binlog_expire_logs_seconds`（常见 7~30 天） | 缩短 binlog 保留期；开启加密 |
| **数据库备份** | 备份文件里包含当期的会话与密文 | 取决于备份策略 | 备份加密；按合规要求定期销毁 |
| **InnoDB 物理块 / undo log** | 已删行的页内残留 | 直到页被覆盖 | 对高敏感场景可评估 `innodb_undo` 与磁盘加密 |
| **Nginx / 应用访问日志** | `POST /conversations/<uuid>/e2e-close` 之类的 URL | 日志保留期 | 关闭 access log 中的 query/param，或缩短保留 |
| **客户端本地缓存** | 明文缓存（`bm_e2e_pt`）、本地会话快照 | 直到客户端清理 | 收到 `e2e:closed` 立即清空对应缓存 |
| **对方设备** | 对方本地的历史消息（自己那份） | 直到对方清理 | 收到 `e2e:closed` 双方都清空本地缓存 |

> 一句话：**服务端业务表可以做到零残留，但"物理世界"的痕迹需要配套的运维策略**（binlog、备份、日志）。
> 这一条必须写进对客户/合规的说明里，不能承诺"绝对无痕"。

### 7.7 一个容易误解的点：E2E ≠ 服务端不暂存

对方离线时，密文必须先在服务端排队，否则无法投递 —— **Telegram 的 secret chat 同样如此**（服务器在消息送达前也会暂存密文）。

我们能控制的是"关闭后多久清空 → 本方案是立即清空"，而不是"消息完全不经过服务端"。

---


## 8. WebSocket 事件（新增 4 个 + 1 个改造）

```ts
// events.types.ts
E2E_REQUESTED:   'e2e:requested',     // 收到私密聊天请求（推给目标用户全部设备）
E2E_ACCEPTED:    'e2e:accepted',      // 已开启（推给两台绑定设备）
E2E_REJECTED:    'e2e:rejected',      // 被拒绝（推给发起设备）
E2E_REQUEST_GONE:'e2e:request_gone',  // 请求失效/已处理（推给其他设备）
E2E_CLOSED:      'e2e:closed',        // 会话结束（推给两台绑定设备）
```

| 事件 | 接收方 | room |
|---|---|---|
| `e2e:requested` | 目标用户的**所有设备** | `user:{targetUserId}` |
| `e2e:accepted` | `e2e_device_a` + `e2e_device_b` | `device:{id}` |
| `e2e:rejected` | `e2e_device_a` | `device:{id}` |
| `e2e:request_gone` | 该用户其余设备 | `device:{id}` 逐个 |
| `e2e:closed` | 两台绑定设备 | `device:{id}` |

**私密会话内的既有事件必须改走 device room**：

| 事件 | 现在 | 改为 |
|---|---|---|
| `message:new` | `emitToUsers(memberIds)` | 私密会话：`emitToDevices([a,b])` |
| `receipt:read` | `emitToUsers` | 同上 |
| `message:destroyed` | `emitToUsers` | 同上 |
| `conversation:updated` | `emitToUsers` | 同上 |

> 实现建议：把广播统一收敛到一个 `emitConversationEvent(conv, event, payload)`：
> 内部判断 `e2e_mode`，普通会话走 user room、私密会话走 device room，避免各处遗漏。

---

## 9. 推送策略（v1：私密会话不推送）

| 会话类型 | 推送 |
|---|---|
| 普通会话 | 现状不变（alias=userId） |
| 私密会话（pending 请求 / active 消息） | **不推送** |

原因：当前推送按 alias=userId 分发，会给该用户的**所有设备**推送，等于告诉未绑定设备"存在一条加密消息"——违反"其他设备无痕"的目标。

v2 可选方案：为设备单独注册 alias（`{userId}_{deviceIdHash}`），推送时只发绑定设备（需 APK 配合）。

---

## 10. 兼容与灰度

| 关注点 | 方案 |
|---|---|
| 存量数据 | `e2e_mode` 默认 0，所有既有会话行为完全不变 |
| 存量 `user_keys` | 保留；旧加密消息（`e2e_version` 缺失）仍按原逻辑解密，能解则解，否则显示"旧版加密消息" |
| 新消息 | 私密会话走 `device_keys` + 设备级 ECDH，**不复用** `user_keys` |
| 前端未上线 | 后端改动对非私密会话无影响，可先发布 |
| 前端灰度 | 私密聊天入口用配置开关控制（`E2E_SECRET_CHAT_ENABLED`），后端同样读取该开关做 404 |
| 回滚 | 关闭开关即可；已建的私密会话建议一并 `e2e-close` 清空 |

---

## 11. 错误码

| HTTP | code | 触发 |
|---|---|---|
| 400 | `E2E_SELF_REQUEST` | 对自己发起 |
| 400 | `E2E_NOT_SECRET` | 对非私密会话调用 e2e 接口 |
| 403 | `E2E_NOT_MEMBER` | 非会话成员 |
| 403 | `E2E_NOT_BOUND_DEVICE` | 当前设备不是绑定设备 |
| 404 | `E2E_KEY_MISSING` | 目标设备未上传公钥 |
| 409 | `E2E_PAIR_EXISTS` | 同对用户已有 pending/active（返回已有 conversation_id）|
| 409 | `E2E_STATE_INVALID` | 状态不允许该操作（如对 active 调 accept）|
| 410 | `E2E_EXPIRED` | pending 已过期 |
| 410 | `E2E_SESSION_GONE` | 会话已被对方关闭/设备移除 |

---

## 12. 测试用例矩阵

### 12.1 可见性（核心）

| # | 场景 | 期望 |
|---|---|---|
| 1 | A电脑发起，B电脑在线 | B电脑收到 `e2e:requested`，会话列表出现"请求" |
| 2 | B手机接受 | A电脑与 B手机可见；**B电脑列表里该会话消失** |
| 3 | A手机登录 | 列表里没有这条私密会话 |
| 4 | B手机拉历史 | 返回密文；解密成功 |
| 5 | B电脑直接构造 `GET /messages/:id` | 403 `E2E_NOT_BOUND_DEVICE` |
| 6 | A手机直接构造该会话的 `POST /messages` | 403 |
| 7 | 全局搜索关键词（含私密会话内容） | 不返回私密会话消息 |
| 8 | 未读数 | B电脑看不到该会话，未读数为 0 |

### 12.2 唯一约束

| # | 场景 | 期望 |
|---|---|---|
| 9 | A 已有 pending，再发起 | 409 `E2E_PAIR_EXISTS` + 已有 id |
| 10 | 已有 active，B 反向发起 | 409 |
| 11 | 被拒绝后立即重新发起 | ✅ 允许（不限频） |
| 12 | 关闭后立即重新发起 | ✅ 允许 |
| 13 | 两条 pending 并发（同一对用户） | 唯一索引兜底，仅一条成功 |

### 12.3 关闭（物理删除）

| # | 场景 | 期望 |
|---|---|---|
| 14 | A关闭 → B 在线 | 双方收到 `e2e:closed`，列表移除，本地缓存清空 |
| 15 | A关闭 → B 离线 | B 下次登录列表无此会话，客户端对比后清理 |
| 16 | 双方同时关闭 | 一次成功一次幂等（200） |
| 17 | 绑定设备被踢 | 自动关闭，对方收到 `e2e:closed trigger=device_removed` |
| 18 | pending 7 天未处理 | 定时任务**删除该行**，双方设备收事件后移除 |
| 19 | 关闭后查库 | `conversations` / `messages` / `message_receipts` / `message_tombstones` / `conversation_members` 中**均查不到任何相关行** |
| 20 | 关闭后查 `audit_logs` | 没有对应记录 |
| 21 | 关闭后扫 `destroy_reason` | 不存在任何能指向私密会话的取值 |
| 22 | 关闭后再次发起 | 新会话、新密钥，与旧会话无关联 |

### 12.4 安全

| # | 场景 | 期望 |
|---|---|---|
| 23 | 私密会话用明文发送 | 400（强制加密） |
| 24 | 伪造 `device_id` 调 accept | 用 JWT 的 deviceId，body 传参被忽略 |
| 25 | 管理端查询私密会话 | 只有元数据，不返回 `cipher_text` |
| 26 | 其他设备的 WS | 收不到该私密会话任何事件 |

---

## 13. 工作量与排期

| 阶段 | 内容 | 估时 |
|---|---|---|
| 后端 P1 | 2 个迁移 + 状态机 + 6 个接口（不含可见性改造） | 2.5 天 |
| 后端 P2 | 10 处可见性改造 + WS device room 分流 + 推送跳过 | 2 天 |
| 后端 P3 | 关闭(物理删除)/联动/过期 + 单测（≈26 例） | 2 天 |
| 后端 P4 | 联调修复 + 管理端适配 | 1 天 |
| **后端合计** | | **约 7.5 天** |
| 前端 | 设备密钥、请求/接受/关闭 UI、列表分区、解密分支 | 5~7 天 |
| 测试 | 26 条用例 × 多设备矩阵 | 3~4 天 |

**建议排期**：后端先做 P1+P2（4.5 天）产出一个可联调的版本，前端并行开发；P3 在前端联调期间完成。

---

## 14. 待确认事项

| # | 问题 | 备选 | 建议 |
|---|---|---|---|
| 1 | pending 有效期 | 3 / 7 / 30 天 | **7 天** |
| 2 | 关闭后服务端留存 | 留元数据 / **零留存** | **零留存**（关闭即物理删除，见 §7） |
| 3 | 是否需要"管理端强制关闭" | 是/否 | **是**（设备丢失场景必备；注意：该操作也不写审计）|
| 4 | 私密会话是否也支持焚毁时长 | 是/否 | 否（v1 简化，整会话关闭即销毁）|
| 5 | 同一对用户是否允许多条 active | 是/否 | **否**（已被唯一约束约束）|
| 6 | 私密会话入口开关 | 环境变量 / 数据库开关 | **环境变量** `E2E_SECRET_CHAT_ENABLED` |
| 7 | binlog / 备份 / 访问日志的保留期 | 7 / 30 / 90 天 | 由运维定；**需在合规说明里写明"业务表零残留，物理介质按运维策略清理"**（见 §7.6）|

---

## 15. 与现有实现的差异总结

| 维度 | 现在 | 本方案 |
|---|---|---|
| 密钥维度 | 用户（`user_keys`，覆盖） | **设备**（`device_keys`，互不覆盖） |
| 会话可见性 | 用户级（所有设备） | **设备级**（仅绑定设备） |
| 多设备 | 互相覆盖，只有一台能解 | 各设备独立会话，互不影响 |
| 关闭语义 | 无 | **关闭 = 物理删除**（会话行/消息/回执/成员/附件全删，可立即重新发起） |
| 关闭后残留 | — | **业务表零残留**；binlog/备份/日志由运维策略处理（§7.6） |
| 唯一性 | 无 | 一对用户同一时间仅一条 pending/active |
| 结束状态 | — | 不设 closed/rejected/expired 状态，删行即结束 |
| 审计 | — | **刻意不写**（避免反推"曾经有过私密会话"） |
| 推送 | 用户级 | 私密会话不推（v1） |
| 迁移数量 | — | **2 个**（conversations 扩展、device_keys 建表） |


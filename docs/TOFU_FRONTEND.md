# TOFU 公钥防替换 · 前端对接指南

> 适用后端：**v5.7**（fenxin-server，含 `POST /keys/query` + WS `key:changed`）
> 面向角色：前端（Web Vue3 / RN App）｜预计工作量：**0.5 ~ 1 天**
> 配套阅读：协议总览 `docs/E2E_ENCRYPTION.md`（§2 接口、§4 TOFU 摘要）、WS 事件 `docs/websocket-events.md`

---

## 1. 一分钟看懂：为什么做这个

E2EE 防得住「偷看」（脱库拿到的全是密文），防不住「演戏」：

```
Alice 向服务端要 Bob 的公钥
  → 被攻破/作恶的服务端返回 攻击者的公钥
  → Alice 用假公钥加密，攻击者解开，再用 Bob 真公钥重加密转发
  → Alice 和 Bob 全程毫无察觉（经典 MITM），全程没碰到任何密码学漏洞
```

**TOFU（Trust On First Use）= 首次拿到公钥就本地钉住，之后每次使用前比对，一旦变了立刻告警。**
服务端换公钥的攻击从「零成本、无感知」变成「必然触发全网告警」。

前端要做的就三件事：

1. **本地公钥通讯录**（钉住层）：首次拿到的公钥存本地
2. **加密前比对**：每次给某人加密发消息前，比对服务端公钥 vs 本地钉住的公钥，不一致 → 阻断 + 告警
3. **实时监听 `key:changed`**：对方公钥一变，服务端立刻推事件，前端马上比对告警

---

## 2. 后端能力速览

| 能力 | 形式 | 什么时候用 | 限流 |
| --- | --- | --- | --- |
| 批量查公钥 | `POST /keys/query` | App 启动 / 进会话，一次拉一组人比对 | 30 次/分 |
| 公钥变更通知 | WS 事件 `key:changed` | 对方轮换公钥时实时推送，被动接收 | — |
| 查单人公钥 | `GET /keys/:userId` | 单点比对 / 收到 key:changed 后拉新公钥 | 60 次/分 |
| 上传自己公钥 | `POST /keys` | 注册/登录后上传；覆盖更新=轮换（触发广播） | 5 次/分 |

下文所有 curl 的 base 为 `http://localhost:9091/api/v1`（按环境替换），均需带 `Authorization: Bearer <token>`。

---

## 3. 接口详情

### 3.1 批量查询公钥 `POST /keys/query`（v5.7 新增）

```bash
curl -X POST http://localhost:9091/api/v1/keys/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_ids": ["7c9e6679-7425-40de-944b-e07fc1f90ae7", "3f9a2b8e-1111-4222-8333-444455556666"]}'
```

请求体：`user_ids` 为 UUID 数组，**1 ~ 500 个**，可包含自己。

```json
{
  "code": 0,
  "message": "公钥批量查询成功",
  "data": [
    {
      "user_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "identity_pubkey": "MCowBQYDK2VuAyEAj1Zs8a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4=",
      "created_at": "2026-08-30T10:00:00.000Z",
      "updated_at": "2026-08-31T14:00:00.000Z"
    }
  ]
}
```

**关键规则（前端必知）：**

- `data` 是**数组**（自己转 Map），**只包含**「自己 + 与自己至少有一个共同会话」的用户
- 没上传过公钥的人 / 无共同会话的人 **直接不出现在结果里，不报错** —— 前端按「请求 N 个、返回 M 个」自行 diff 出缺失项
- **结果里永远含自己**（方便比对「我本地存的 vs 服务端存的」）
- 400：数组为空 / 非法 UUID / 超过 500 个；429：触发限流

### 3.2 WS 事件 `key:changed`（v5.7 新增）

socket.io v4，事件名 `'key:changed'`：

```ts
socket.on('key:changed', (payload: { user_id: string; updated_at: string }) => {
  // ...
});
```

| 要点 | 说明 |
| --- | --- |
| 触发时机 | 有人调 `POST /keys` **覆盖更新**公钥（即「轮换」）时 |
| 首次上传 | **不推**（没人缓存过旧公钥，无比对意义） |
| 推给谁 | 轮换者的**全部共同会话用户**（谁可能缓存了旧公钥就推给谁） |
| payload | **只有 `user_id` + `updated_at`（ISO8601），故意不带公钥本体** |
| 为什么不带公钥 | 保证所有公钥都走同一条「本地缓存比对」路径 —— WS 直接推个假公钥给你也没用 |

**收到后的标准动作：**
`user_id` 是自己 → 忽略；是别人 → `GET /keys/:userId`（或批量 query）拉新公钥 → 和本地钉住的比对 → 不一致就告警。

### 3.3 查单人公钥 `GET /keys/:userId`（既有）

```json
{ "code": 0, "message": "Success", "data": { "user_id": "uuid", "identity_pubkey": "base64...", "created_at": "...", "updated_at": "..." } }
```

错误码：`403` 对方不在你的会话中，无权获取公钥；`404` 对方尚未上传公钥，无法加密发送（查自己且没上传过也是 404）。

### 3.4 上传自己公钥 `POST /keys`（既有，注意语义）

```json
// 请求
{ "identity_pubkey": "MCowBQYDK2VuAyEA..." }
// 响应 data
{ "updated": true }
```

- 相同公钥重复上传 → 幂等，`updated: false`，**不触发广播**
- 覆盖更新（新公钥）→ `updated: true`，**触发 key:changed 广播**
- 公钥格式：X25519 32 字节的 base64（43~44 字符），格式错 400

---

## 4. 前端实现（可直接抄）

### 4.1 本地公钥通讯录 `keyStore.ts`

公钥不是机密（本来就是公开的），明文存即可。**每台设备各自维护，不进服务端。**

```ts
// src/services/e2ee/keyStore.ts
export interface PinnedKey {
  user_id: string;
  identity_pubkey: string;
  /** 首次钉住时间（毫秒），告警文案可展示「首次信任于 xxx」 */
  first_seen_at: number;
}

const STORE_KEY = 'fx.pinned_keys'; // Map<user_id, PinnedKey> 的 JSON 序列化

// ---------- 存储适配：Web 用 localStorage，RN 换 AsyncStorage ----------
const storage = {
  // Web (Vue3)：
  async get(): Promise<Record<string, PinnedKey>> {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  },
  async set(map: Record<string, PinnedKey>): Promise<void> {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  },
  // // RN（裸 RN 0.75+）：
  // async get() {
  //   const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  //   return JSON.parse((await AsyncStorage.getItem(STORE_KEY)) || '{}');
  // },
  // async set(map: Record<string, PinnedKey>) {
  //   const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  //   await AsyncStorage.setItem(STORE_KEY, JSON.stringify(map));
  // },
};

export const keyStore = {
  async get(userId: string): Promise<PinnedKey | null> {
    return (await storage.get())[userId] ?? null;
  },
  /** 覆盖写入；首次钉住记 first_seen_at，轮换确认时保留首次时间 */
  async put(userId: string, pubkey: string): Promise<void> {
    const map = await storage.get();
    map[userId] = {
      user_id: userId,
      identity_pubkey: pubkey,
      first_seen_at: map[userId]?.first_seen_at ?? Date.now(),
    };
    await storage.set(map);
  },
  async remove(userId: string): Promise<void> {
    const map = await storage.get();
    delete map[userId];
    await storage.set(map);
  },
};
```

### 4.2 TOFU 校验 `verifyPeerKey`（核心，三态返回）

```ts
// src/services/e2ee/tofu.ts
import { keyStore, PinnedKey } from './keyStore';

export type KeyVerifyResult =
  | { status: 'first_trust'; pubkey: string }          // 首次见到，已钉住，正常放行
  | { status: 'ok'; pubkey: string }                   // 与本地一致，放行
  | { status: 'changed'; oldPubkey: string; newPubkey: string; pinned: PinnedKey }; // 变了！阻断+告警

/**
 * 取对方公钥并做 TOFU 比对。加密发送前必须调这个，不要直接裸调 GET /keys/:userId。
 * 注意：changed 时不更新本地缓存 —— 必须等用户在告警 UI 上点「确认信任」才更新。
 */
export async function verifyPeerKey(peerId: string): Promise<KeyVerifyResult> {
  const local = await keyStore.get(peerId);
  const { data: remote } = await api.get(`/keys/${peerId}`); // {user_id, identity_pubkey, ...}

  if (!local) {
    await keyStore.put(peerId, remote.identity_pubkey); // 首次信任：钉住
    return { status: 'first_trust', pubkey: remote.identity_pubkey };
  }
  if (local.identity_pubkey === remote.identity_pubkey) {
    return { status: 'ok', pubkey: local.identity_pubkey };
  }
  return {
    status: 'changed',
    oldPubkey: local.identity_pubkey,
    newPubkey: remote.identity_pubkey,
    pinned: local,
  };
}

/** 用户在告警横幅点了「确认信任新密钥」→ 才允许更新钉住并恢复加密发送 */
export async function confirmNewKey(peerId: string, newPubkey: string): Promise<void> {
  await keyStore.put(peerId, newPubkey);
}
```

### 4.3 发送加密消息的接入点

在既有 E2EE 发送流程（`docs/E2E_ENCRYPTION.md` §3.2）里，**把「取对方公钥」那一步换成 verifyPeerKey**：

```ts
async function encryptAndSend(conversationId: string, plaintext: string) {
  const peerId = await getPeerUserId(conversationId);

  // —— TOFU：加密前比对（原来这里是裸调 GET /keys/:peerId）——
  const result = await verifyPeerKey(peerId);
  if (result.status === 'changed') {
    tofuStore.raiseAlert(peerId, result);   // 弹告警横幅
    throw new Error('E2EE_KEY_CHANGED');    // 阻断本次加密发送，不发密文
  }
  const peerPubkey = result.pubkey;

  // ……下面照旧：ECDH 协商 + AES-256-GCM 加密 + POST /messages（cipher_* 字段）
}
```

### 4.4 WS `key:changed` 监听接入

```ts
// src/services/ws.ts —— WS_EVENTS 镜像里补一行（与后端 events.types.ts 保持一致）
export const WS_EVENTS = {
  // ...已有的 message:new 等
  KEY_CHANGED: 'key:changed',
} as const;

// 建立 socket 连接后：
socket.on(WS_EVENTS.KEY_CHANGED, async (payload: { user_id: string; updated_at: string }) => {
  if (payload.user_id === myUserId) return;        // 自己轮换，忽略
  const result = await verifyPeerKey(payload.user_id);
  if (result.status === 'changed') {
    tofuStore.raiseAlert(payload.user_id, result); // 顶部横幅告警
  }
});
```

### 4.5 App 启动 / 进会话时的批量比对

用 `POST /keys/query` 一次拉一批，别逐个 GET（500 人以上分批）：

```ts
// src/services/e2ee/tofuSync.ts
async function syncPinnedKeys(memberIds: string[]) {
  const changed: Array<{ user_id: string; newPubkey: string }> = [];

  for (const batch of chunk(memberIds, 500)) {
    const { data } = await api.post('/keys/query', { user_ids: batch });
    const remoteMap = new Map(data.map((k: any) => [k.user_id, k.identity_pubkey]));

    for (const [uid, pubkey] of remoteMap) {
      if (uid === myUserId) continue;
      const local = await keyStore.get(uid);
      if (!local) {
        await keyStore.put(uid, pubkey);            // 首次：直接钉住，不打扰用户
      } else if (local.identity_pubkey !== pubkey) {
        changed.push({ user_id: uid, newPubkey: pubkey }); // 变了：只收集，不自动更新！
      }
      // 不在 remoteMap 里的 = 未上传公钥或无共同会话，跳过即可
    }
  }

  if (changed.length) tofuStore.raiseAlerts(changed); // 汇总告警
}

const chunk = <T>(arr: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
```

**调用时机建议：**
- 登录成功后：拉「最近会话的全部成员」跑一次
- 打开某个会话时：跑该会话成员（可只对当前会话做）
- 收到 `key:changed` 时：单点 verifyPeerKey（见 4.4），批量接口做兜底刷

### 4.6 告警横幅 UI（Vue3 示例）

```vue
<!-- src/components/KeyChangeBanner.vue -->
<template>
  <div v-for="a in tofuStore.alerts" :key="a.user_id" class="key-banner">
    <span>⚠️ 「{{ a.displayName }}」的安全密钥已变更（可能是对方换了手机/重装，也可能是密钥被替换）</span>
    <button @click="tofuStore.confirm(a.user_id)">确认信任新密钥</button>
    <button @click="tofuStore.dismiss(a.user_id)">稍后处理</button>
  </div>
</template>

<script setup lang="ts">
import { useTofuStore } from '@/stores/tofu';
const tofuStore = useTofuStore();
</script>

<style scoped>
.key-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; background: #fff7e6; border-bottom: 1px solid #ffd591;
  color: #d46b08; font-size: 13px;
}
</style>
```

```ts
// src/stores/tofu.ts（Pinia）核心状态机
export const useTofuStore = defineStore('tofu', {
  state: () => ({ alerts: [] as KeyAlert[] }),   // KeyAlert: {user_id, displayName, newPubkey}
  actions: {
    raiseAlert(userId: string, result) {
      if (this.alerts.some((a) => a.user_id === userId)) return; // 去重
      this.alerts.push({ user_id: userId, displayName: userId2Name(userId), newPubkey: result.newPubkey });
    },
    async confirm(userId: string) {
      const a = this.alerts.find((x) => x.user_id === userId)!;
      await confirmNewKey(userId, a.newPubkey);   // 更新本地钉住 → 加密发送自动恢复
      this.alerts = this.alerts.filter((x) => x.user_id !== userId);
    },
    dismiss(userId: string) {
      this.alerts = this.alerts.filter((x) => x.user_id !== userId); // 只关横幅，加密发送仍被阻断
    },
  },
});
```

**文案要求：换手机/重装是合法轮换，告警是常态事件，别写太吓人；但必须保留「确认」这道人工关卡，禁止静默自动信任新密钥。**

---

## 5. 边界情况处理表

| 场景 | 现象 | 正确处理 |
| --- | --- | --- |
| 对方换手机 / 重装 App | 收到 key:changed，比对不一致 | 告警 → 用户点确认 → 更新钉住，恢复发送（**常态，占 99%**） |
| 自己换了设备/清了缓存 | 本地通讯录丢失 | 全员回到「首次信任」重新钉住（TOFU 固有弱点；与产品「密钥丢=消息焚」语义一致） |
| 多端登录（同一账号多设备） | 各端各自维护通讯录 | 互不干扰，各端独立告警 |
| key:changed 的 user_id 是自己 | 自己刚轮换了公钥 | 直接忽略，不告警 |
| 用户一直不点「确认信任」 | 横幅被关掉 | **加密发送保持阻断**（每次发都触发 changed）；明文发送不受影响 |
| /keys/query 结果里缺人 | 未上传公钥 / 无共同会话 | 跳过即可，缺失是正常情况，不要报错重试 |
| WS 断线期间对方轮换了公钥 | 没收到 key:changed | 启动/进会话时的批量比对（4.5）兜底覆盖 |

---

## 6. 联调自测步骤（双账号 A/B）

前置：A、B 互为好友或已有会话；A 已实现 4.1~4.6；浏览器开两个页签分别登录 A、B，控制台看 WS 日志。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | B 首次上传公钥（POST /keys） | A **不**收到 key:changed（首次上传不广播） |
| 2 | A 给 B 发加密消息 | verifyPeerKey 返回 `first_trust`，本地通讯录多了一条 B |
| 3 | 再发一条 | 返回 `ok`，无任何提示 |
| 4 | B 重新生成密钥对并上传（模拟换手机） | A **实时**收到 key:changed；A 发消息被阻断并弹横幅 |
| 5 | A 点「确认信任新密钥」 | 横幅消失，再发消息返回 `ok`（本地已更新） |
| 6 | A 调 POST /keys/query 查 [A, B, 随机无关用户] | data 里只有 A、B；无关用户缺席不报错 |
| 7 | A 查一个无会话用户的公钥（GET） | 403「对方不在你的会话中」 |
| 8 | 重启 A 的客户端（不清缓存） | 启动批量比对无告警（钉住数据还在） |
| 9 | 清掉 A 的本地存储再登录 | 启动比对全员 first_trust 重新钉住，无告警 |

curl 快速验证后端（与前端无关，先确认服务端 OK）：

```bash
# 批量查询（结果里应含自己 + 共同会话成员，别人缺席）
curl -X POST http://localhost:9091/api/v1/keys/query \
  -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d '{"user_ids": ["<A的userId>", "<B的userId>"]}'

# B 轮换公钥（B 的新公钥随便换几位）→ A 的 WS 应立刻收到 key:changed
curl -X POST http://localhost:9091/api/v1/keys \
  -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" \
  -d '{"identity_pubkey": "<B的新base64公钥>"}'
```

---

## 7. FAQ

**Q1：不做前端 TOFU，后端这些接口会有影响吗？**
不会。key:changed 照推、/keys/query 照返回，只是没人消费 —— 等于回到「每次裸信」，服务端换公钥依然无感知。**TOFU 的安全价值 100% 在前端这三步里。**

**Q2：用户点了「确认信任」，但公钥其实真被替换了怎么办？**
TOFU 的职责是**让替换可见、可留痕**，最终裁决在人。这就把作恶成本从「零成本无感知」抬到「每换一次钥匙、全网告警一次」。要更强保证是「安全码」（双端各算哈希出 60 位数字，线下对数字），在加密路线图后续版本。

**Q3：为什么收到 key:changed 不能直接信服务器推的新公钥？**
因为 WS 通道本身也是服务端的 —— 直接信它推的公钥，等于 TOFU 白做。所以 payload 故意不带公钥，**统一走「拉取 + 本地比对」一条路**，服务端无论从哪个口子塞假公钥都要过同一道比对。

**Q4：群聊要做吗？**
当前 E2EE 仅单聊（方案 B）。但 key:changed 广播覆盖所有共同会话用户（含群成员），前端 4.4 的监听是全局的，群聊 E2EE（Sender Keys）上线后直接复用。

**Q5：验证 /keys/query 用哪个字段判断"变没变"？**
直接比对 `identity_pubkey` 字符串。`updated_at` 只用于展示（「密钥于 xxx 变更」），**不要**用它做判断依据 —— 时间戳可以伪造，公钥本体才是钉住的对象。

---

## 8. 验收标准

- [ ] `keyStore`：钉住数据落本地，重启不丢，清缓存回到首次信任
- [ ] 加密发送前必经 `verifyPeerKey`；`changed` 时密文**没有**发出
- [ ] WS 监听 `key:changed`：自己轮换忽略、他人轮换实时告警
- [ ] 启动/进会话批量比对跑通，缺失用户不报错
- [ ] 告警横幅：确认后才更新钉住；关横幅不解阻断
- [ ] §6 联调 9 步全过

完成后请在 WS_EVENTS 镜像（前端 ws.ts）与本文档各留一行版本注释，后续协议升级（one-time prekey / X3DH）会扩展此文档。

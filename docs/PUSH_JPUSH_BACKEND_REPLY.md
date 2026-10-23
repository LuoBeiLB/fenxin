# 回复《极光推送收不到 — 后端排查清单 v2》

> 回复方：后端　｜　日期：2026-10-22
> 相关提交：`8a425c1`（推送后端接入）、`1b455a4`（断连立即判离线）、`e6bb9cb`（启动自检日志）
> 结论先行：**你们清单里的第 3️⃣ 条就是根因**，已经修了。但修复依赖"前端切后台真的断开 WS"，这一条需要你们确认。

---

## 一、清单 5 个问题的回答

### Q1. 极光控制台「推送记录」里有没有业务消息触发的推送记录？

**我看不到**（开发沙箱无外网、也没有极光账号），需要你们查。

**替代判据（后端日志）**——比控制台更快：

| 日志 | 含义 |
|---|---|
| `[JPush] push ok users=1 resp={"sendno":"0","msg_id":"..."}` | 后端发了，极光收了 → 问题在极光侧（渠道/厂商通道/权限） |
| `[JPush] push failed status=400 body=...` | 发了但被极光拒绝（大概率 alias 没绑 / 参数不合法） |
| **完全没有 `[JPush]` 开头的行** | 后端**根本没发**（三个原因见 Q3/Q4） |

> 这一行是本次新增的（`8a425c1` 就有），如果你们日志里搜不到 `[JPush]`，直接跳到 Q4。

### Q2. 推送体里用的是 `notification` 还是透传 `message`？

**`notification`，没有 `message` 字段。**

代码：`src/modules/push/jpush.provider.ts:61-76`

这是用本地 mock 极光服务抓到的**真实请求体**（不是示意）：

```jsonc
{
  "platform": ["android"],
  "audience": { "alias": ["<收件人 userId>"] },
  "notification": {
    "android": {
      "alert": "推送A：普通消息内容ABC",
      "title": "推送A",
      "channel_id": "messages",
      "extras": {
        "conversation_id": "4c63efb5-43c2-48b7-919b-c225d8fdc8ba",
        "message_id": "8104b369-9a84-45c2-8d13-a40c24a575ba",
        "type": "text"
      }
    }
  },
  "options": { "time_to_live": 3600 }
}
```

> `small_icon` 目前**没有**（`JPUSH_SMALL_ICON` 未配置，见 Q3 的 .env 片段）。你们控制台测试用的是 `ic_stat_notify`，两边不一致；如果决定统一，把资源名填进 `JPUSH_SMALL_ICON` 即可，代码已支持。

### Q3. `JPUSH_ENABLED` 当前值？

**我查了真实的 `.env`（不是 .env.example），28 项配置，极光部分是齐的：**

```
JPUSH_ENABLED        = true
JPUSH_APP_KEY        24 位，纯十六进制（91***53）  ← 格式符合极光规范
JPUSH_MASTER_SECRET  24 位（18***3f）
JPUSH_CHANNEL_ID     = messages
JPUSH_TTL_SECONDS    = 3600
JPUSH_SMALL_ICON     未配置
JPUSH_ENDPOINT       未配置（正常，直连 api.jpush.cn）
ONLINE_TTL_SECONDS   未配置 → 默认 150s
```

**并且实测确认这份 `.env` 真的被读取了**（我用它起了服务，启动日志）：

```jsonc
{"context":"InstanceLoader","msg":"PushModule dependencies initialized"}
{"context":"Push","msg":"推送已启用：channel=messages small_icon=(未配置) ttl=3600s endpoint=api.jpush.cn"}
```

所以 **"没配置" 不是原因**。

如果你们服务器上日志显示 `[Push] 推送未启用：...`，说明那个进程没读到 env，可能是：

1. Docker 容器没重建（`JPUSH_*` 是我这两天才加进 `docker-compose.yml` 的，旧容器里没有这些环境变量）
2. pm2/进程的 cwd 不是仓库根（`dotenv/config` 按 cwd 找 `.env`）

### Q4. `pickOffline()` 对「App 在后台但没杀」的用户返回什么？为什么 `is_online = 1`？

**这就是根因，你们判断对了，只是等待窗口算少了。**

**旧逻辑（问题所在）**

```
is_online 只在 PresenceScheduler 里被置 0：
  - @Cron 每分钟跑一次
  - 且要求 last_active_at < now - ONLINE_TTL_SECONDS(150s)

断连后：先等 150s 心跳超时，再等下一分钟扫描
→ 最长 150 + 60 = 【210 秒】才判离线
→ 这期间被判定为"在线" → 完全不推送
```

清单里写"切后台等 30~90 秒再查" → 这时 `is_online` 仍是 1 → 后端跳过推送 → **和你们看到的现象完全吻合**。

更关键的是：**App 在后台即使 WS 还连着，用户也看不到系统通知**。所以"在线就不推"在这段窗口里逻辑上就是错的。

**新逻辑（`1b455a4` 已修）**

```
WS 断开 → socket_count -1 → 若归 0 → 【立即】置 is_online=0 + offline_at
        + 广播 device:offline
```

保留两道保护：

- `socket_count` 守卫：多标签页/多设备下只有**最后一个**连接断开才置离线，不会误判
- `PresenceScheduler` 继续兜底，覆盖"进程被杀导致断连事件丢失"

**但这依赖你们一件事**：切后台要真的 `disconnect()`。用这条 SQL 一查就知道现在属于哪种情况：

```sql
SELECT device_name, is_online, socket_count, last_active_at
FROM devices WHERE user_id = '<收件人 uuid>';
```

| 结果 | 含义 | 谁的问题 |
|---|---|---|
| `is_online=0, socket_count=0` | ✅ 判定正常 | 问题在极光侧（看推送记录/厂商通道） |
| `is_online=1, socket_count=0` | 跑的是**旧构建**（修复没生效） | 后端重启/重新 build |
| `is_online=1, socket_count>0` | **切后台没有真的断开 WS** | 前端要查 |

> 建议：手机切后台后 **5 秒**查一次，而不是 30~90 秒。

### Q5. 消息表的「焚毁」「加密」字段名？

| 语义 | 字段 | 判断方式 |
|---|---|---|
| 焚毁消息 | `messages.burn_ttl_seconds` | `!= null` 即焚毁消息（NULL = 非焚毁） |
| 加密消息 | `messages.is_encrypted` | `=== true` |

脱敏实现在 `src/modules/push/push.service.ts` 的 `buildContent()`：

| 类型 | 推送正文 |
|---|---|
| 焚毁 | `你有一条阅后即焚消息` |
| 加密 | `你有一条加密消息` |
| 图片/语音/视频/文件 | `[图片] 张三` / `[语音] 张三` / `[视频] 张三` / `[文件] 张三` |
| 文本 | `张三：前 30 字` |

**红线已用单测 + 端到端锁死**：焚毁/加密消息的推送体里不含任何正文（E2E 里断言了响应 JSON 不含 `绝密内容XYZ`）。

---

## 二、清单里判断正确的 3 点（已按你们建议改）

| 你们的建议 | 处理 |
|---|---|
| 必须用 `notification` 而不是 `message` | ✅ 本来就是 `notification`，无 `message` 字段 |
| `catch(() => {})` 吞异常不可见 | ✅ 已改为 `logger.warn('[push] notify skipped: ...')`（`1b455a4`） |
| 要能打印请求体/响应做对比 | ✅ 成功记 `push ok users=N resp={...}`；失败记 `push failed status=... body=...`；启动打印配置状态 |

## 三、清单里需要修正的 4 点

1. **等待窗口**：不是 30~90 秒，旧逻辑最长 **210 秒**（150s TTL + 60s 扫描间隔）。修复后是**秒级**。
2. **`pickOffline` 此前确实是"按心跳算"**：`is_online` 由「WS 连接数」+「心跳 `last_active_at` ≤ 150s」共同维护。现在断连即离线，心跳只作为兜底。
3. **`small_icon` 目前未配置**：后端不传该字段，极光用默认图标。若要和你们控制台一致，需要 `JPUSH_SMALL_ICON=ic_stat_notify`（代码已支持，见 Q2 注）。
4. **控制台手工推送测点击跳转**：控制台里如果没填 `extras.conversation_id`，点击跳不过去是**正常的**，不代表代码问题。判断方法：后端发一条真实消息，点那条通知。

---

## 四、需要你们确认的 2 件事（阻塞项）

### 1. 切后台是否真的断开 WS（最关键）

```
前端切后台 → socket.disconnect() → 服务端 handleDisconnect → socket_count 归 0 → 立即离线 → 推送
```

如果只是"停止发心跳"但没 `disconnect()`，`socket_count` 仍是 1，后端仍判在线 → 永远不推。
**用 Q4 的 SQL 验证，一条就能定论。**

### 2. 点击通知时读取的路径

后端 extras 的键是 **`conversation_id`**（snake_case），值 = 会话 uuid，已实测带上。

但"后端有" ≠ "前端能读到"，中间还经过：极光 SDK → Intent extras → 你们的插件 → JS。请先打印一次原始对象：

```js
Jpush.addListener('notificationOpened', (data) => {
  console.log('[push] opened raw =', JSON.stringify(data));
  // 可能是 data.conversation_id，也可能是 data.extras.conversation_id，以打印为准
});
```

如果打印出来是 `{"extras":{"conversation_id":"..."}}`，前端要读 `data.extras.conversation_id`；后端不需要改。

---

## 五、我这边已验证的事实（可复现）

| 项 | 结果 |
|---|---|
| 单测（推送编排 17 例 + 断连即离线 3 例） | 全绿 |
| 端到端（本地 mock 极光服务，真实 HTTP）| **13/13** |
| ├ 离线用户收普通消息 | alias=[B]、channel_id=messages、正文含发送者+内容、extras 带 conversation_id |
| ├ 焚毁消息 | 正文恒为「你有一条阅后即焚消息」，响应体不含真实内容 |
| └ 对方上线后再发 | 不产生新推送（在线由 WS 覆盖，避免双提醒） |
| 全量测试 | 24 suites / 220 tests 全绿 |
| 真实 `.env` 启动自检 | `[Push] 推送已启用：channel=messages ...` |

---

## 六、下一步（分工）

| 谁 | 做什么 | 判据 |
|---|---|---|
| **前端** | 确认切后台真断开 WS；打印点击回调原始结构 | SQL `is_online/socket_count`；console 输出 |
| **后端（我）** | 已完成：断连即离线、启动自检、small_icon 支持、异常日志 | — |
| **运维/你们** | 部署环境重启并抓 `[Push]` 那行；Docker 重建容器 | 日志有 `推送已启用` |
| **你们** | 补 `JPUSH_SMALL_ICON=ic_stat_notify`（可选，影响图标观感） | 通知栏图标不是灰块 |
| **你们** | 极光控制台确认厂商通道是否已开（自有通道杀进程必丢） | 杀掉 App 后仍能收到 |

**建议的验证顺序**（10 分钟内能定位）：

```
① 后端重启 → 抓日志 [Push] 推送已启用
② 手机切后台 → 等 5 秒 → 查 SQL is_online=0
③ 发消息 → 抓日志 [JPush] push ok
④ 手机应弹出（没弹 → 查极光推送记录 + 厂商通道）
⑤ 点通知 → 打印回调结构 → 确认跳转路径
```

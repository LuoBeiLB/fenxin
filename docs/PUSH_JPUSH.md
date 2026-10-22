# 极光推送（JPush）接入方案 — Android APK

> 适用仓库：`fenxin`（Vue 3 + Capacitor 8 + Android）、`fenxin-server`（NestJS）
> 应用包名：**`com.burnmsg.app`**（`android/app/build.gradle` 的 `namespace` / `applicationId`）
> 关联文档：[BURN_SETTING_FLOW.md](./BURN_SETTING_FLOW.md) · [ONLINE_PRESENCE.md](./ONLINE_PRESENCE.md) · [websocket-events.md](./websocket-events.md)

---

## 0. 实现状态（2026-10-22）

**后端已完成**（本次提交），其余待 SDK/控制台：

| 项 | 状态 | 位置 |
|---|---|---|
| 极光 REST 提供方（alias 投递） | ✅ 已实现 | `src/modules/push/jpush.provider.ts` |
| 离线筛选 + 内容脱敏编排 | ✅ 已实现 | `src/modules/push/push.service.ts` |
| 接入发送链路（异步不阻塞） | ✅ 已实现 | `message.service.ts` `sendMessage` 末尾 `void this.push.notifyNewMessage(...)` |
| env / docker-compose | ✅ 已加 | `.env.example`、`docker-compose.yml` |
| 单测（16 例） | ✅ 全绿 | `test/modules/push/push.service.spec.ts` |
| 端到端（mock 极光，13/13） | ✅ 通过 | 见 §7.1 |
| Android 接 SDK + 渠道 + 图标 | ⏳ 待做 | §3 |
| 前端 alias 绑定 / 点击跳转 | ⏳ 待做 | §4 |
| 极光控制台建应用 + 厂商通道 | ⏳ 待做（你） | §2 |

**已实现的关键行为（实测）**

```
① 离线用户发普通消息 → 调推送：alias=[B]、channel_id=messages、
   正文「推送A：普通消息内容ABC」、extras 带 conversation_id/message_id/type、Basic Auth 正确
② 焚毁消息 → 正文恒为「你有一条阅后即焚消息」，响应体不含真实内容（红线验证）
③ 对方上线后再发 → 不再推送（在线由 WS 覆盖，避免双提醒）
```

**开关语义**

```bash
JPUSH_ENABLED=false          # 默认；此时完全不发请求
JPUSH_APP_KEY=               # 与 MASTER_SECRET 三者齐备才真发
JPUSH_MASTER_SECRET=
```

**测试可用的一个入口**：`JPUSH_ENDPOINT` 可覆盖推送地址，端到端测试时可指向本地 mock 服务。

---

## 0.1 决策记录（结论先行）
| 决策 | 结论 | 理由 |
|---|---|---|
| 只走极光自有通道够不够 | **不够** | 自有通道依赖 App 进程存活；进程被杀 / Doze 冻结网络后收不到，等价于"应用活着才能收"，与现有 WS 收益重叠 |
| 是否必须接厂商通道 | **建议接** | 只有厂商通道能在 App 被杀后送达（走系统级推送服务） |
| 服务端用 alias 还是 registration_id | **alias = userId** | 不需要维护 token 表；一个 alias 可绑多台设备（上限以极光文档为准，约 10 台） |
| 推送内容能带消息正文吗 | **焚毁/加密消息一律不带** | 通知会显示在锁屏、经过第三方服务器；带正文等于废掉阅后即焚 |
| 在线用户要不要推 | **不推** | WS 已经实时送达，重复提醒很吵；只对离线用户推 |
| 是否等控制台审批完再写代码 | **不用** | 服务端用 `JPUSH_ENABLED=false` 开关，代码先就位 |

---

## 1. 整体链路

```
① APK 启动 → 极光 SDK 初始化 → 拿到 registration_id
② 登录成功 → JPushInterface.setAlias(userId)        ← 极光侧建立「用户 ↔ 设备」映射
③ 用户发消息 → 后端判断收件人是否离线（devices.is_online = 0）
④ 离线者 → 后端调极光 REST（api.jpush.cn/v3/push），audience.alias = [userId...]
⑤ 极光 → 厂商通道（小米/华为/OPPO/vivo/荣耀）或自有通道
⑥ 手机系统弹通知 → 用户点击 → APK 打开并跳到对应会话
```

**与现有 WS 的关系**：WS 负责"在线实时"，极光负责"离线唤醒"，两者互补，不替代。

---

## 2. 极光控制台配置（先做，卡审批）

### 2.1 创建应用

| 字段 | 填写 |
|---|---|
| 应用名称 | 焚信 |
| Android 包名 | **`com.burnmsg.app`**（必须完全一致，填错表现为 registration_id 为空） |
| 应用图标 | 焚信图标 |

创建后在「应用设置 → 应用信息」拿到：

- **AppKey**（APK 和服务端都要用）
- **MasterSecret**（**只给服务端**，绝不能进 APK）

### 2.2 开通厂商通道（耗时最长，第一天就提交）

| 通道 | 需要准备 | 在极光的配置位置 |
|---|---|---|
| 小米 | 小米开放平台账号 + 应用 AppID/AppKey/AppSecret | 应用设置 → 厂商通道 → 小米 |
| 华为 | 华为开发者联盟 + 应用 AppID/AppSecret（AGC） | 同上 |
| 荣耀 | 荣耀开发者平台（与华为独立） | 同上 |
| OPPO | OPPO 开放平台 + AppKey/MasterSecret | 同上 |
| vivo | vivo 开放平台 + AppID/AppKey/AppSecret | 同上 |

> 只填 AppKey 不填厂商通道 = 只有自有通道，效果见 §0。

### 2.3 先用控制台验证通道（不写代码）

1. APK 装好、启动过一次（完成 SDK 初始化）
2. 极光控制台 → 推送 → 发送通知 → 目标「广播」
3. 三种测试：前台 / 后台 / **杀掉 App** 各推一次
4. 记录结果，决定是否需要把厂商通道补齐

---

## 3. Android 侧接入

### 3.1 两条路线

| 路线 | 说明 | 风险 |
|---|---|---|
| **A. Cordova 插件**（官方 `jpush-cordova-plugin`） | 改动小，Capacitor 会自动桥接 Cordova 插件 | 与 Capacitor 8 / targetSdk 36 的兼容性需实测 |
| **B. 自写薄 Capacitor 插件**（推荐长期） | 只暴露 `init` / `getRegistrationId` / `setAlias` / 点击事件 | 需要写 Kotlin，但完全可控 |

> 建议：先 30 分钟试路线 A，能拿到 registration_id 就先用；拿不到再走路线 B。

### 3.2 Gradle 依赖（`android/app/build.gradle`）

```gradle
android {
    defaultConfig {
        // 极光要求：包名 + AppKey + 渠道
        manifestPlaceholders = [
            JPUSH_PKGNAME : "com.burnmsg.app",
            JPUSH_APPKEY  : project.findProperty("JPUSH_APPKEY") ?: "请填入AppKey",
            JPUSH_CHANNEL : "developer-default",
        ]
    }
}

dependencies {
    // 版本以 https://docs.jiguang.cn/jpush/client/Android/android_guide/ 为准
    implementation 'cn.jiguang.sdk:jpush:5.x.x'
    implementation 'cn.jiguang.sdk:jcore:5.x.x'
}
```

> AppKey 建议放 `android/gradle.properties`（不进 git）或 CI 注入，别硬编码在 build.gradle。

### 3.3 权限（`android/app/src/main/AndroidManifest.xml`）

```xml
<!-- 通知权限：targetSdk 36（Android 16）必须声明 + 运行时申请 -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<!-- 极光基础权限；厂商通道所需权限由各家 AAR 自动合并 -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.VIBRATE" />
```

> 现有 Manifest 已有 `INTERNET`，其余按需补。

### 3.4 自写插件骨架（路线 B，Kotlin）

```kotlin
@CapacitorPlugin(name = "Jpush")
class JpushPlugin : Plugin() {

    @PluginMethod
    fun init(call: PluginCall) {
        JPushInterface.setDebugMode(false)
        JPushInterface.init(context)
        call.resolve()
    }

    @PluginMethod
    fun getRegistrationId(call: PluginCall) {
        val id = JPushInterface.getRegistrationID(context)
        call.resolve(JSObject().put("registrationId", id ?: ""))
    }

    /** 用 userId 做别名：服务端只发 alias，无需维护 token 表 */
    @PluginMethod
    fun setAlias(call: PluginCall) {
        val alias = call.getString("alias") ?: return call.reject("alias required")
        JPushInterface.setAlias(context, 1, alias)
        call.resolve()
    }

    @PluginMethod
    fun deleteAlias(call: PluginCall) {
        JPushInterface.deleteAlias(context, 2)
        call.resolve()
    }

    /** 点击通知时把 extras 交给 JS（前端据此跳会话） */
    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        intent.extras?.let { b ->
            val data = JSObject()
            b.keySet().forEach { k -> data.put(k, b.getString(k)) }
            notifyListeners("notificationOpened", data)
        }
    }
}
```

### 3.5 通知渠道与图标（不配会不显示 / 显示灰块）

**渠道**：`id` 必须与后端推送里的 `channel_id` 完全一致（本方案统一用 `messages`）。
创建时机：App 首次启动。

```kotlin
val channel = NotificationChannel(
    "messages", "消息通知", NotificationManager.IMPORTANCE_HIGH
).apply {
    description = "新消息提醒"
    enableVibration(true)
    lockscreenVisibility = Notification.VISIBILITY_PRIVATE   // 锁屏不展示正文
}
getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
```

**图标**：`smallIcon` 必须是**白色透明剪影**（24×24，alpha-only），彩色图会显示成灰块。

```
android/app/src/main/res/drawable/ic_stat_notify.xml
```

```xml
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF"
        android:pathData="M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2z"/>
</vector>
```

---

## 4. 前端（Vue）接入

### 4.1 封装 `src/utils/push.js`

```js
import { Capacitor, registerPlugin } from '@capacitor/core';

/** 极光插件（路线 A 时换成 Cordova 插件的调用方式） */
const Jpush = registerPlugin('Jpush');
const isNative = Capacitor.isNativePlatform();

/** App 启动时调用一次 */
export async function initPush() {
  if (!isNative) return;              // Web 端不接极光（走 Web Push，另见文档）
  try {
    await Jpush.init();
  } catch (e) {
    console.warn('[push] init failed', e);
  }
}

/** 登录成功后调用：把 userId 绑成极光 alias */
export async function bindPushAlias(userId) {
  if (!isNative || !userId) return;
  try {
    await Jpush.setAlias({ alias: String(userId) });
  } catch (e) {
    console.warn('[push] setAlias failed', e);
  }
}

/** 退出登录时解绑，避免下一个人登录还收到上一个人的消息 */
export async function unbindPushAlias() {
  if (!isNative) return;
  try {
    await Jpush.deleteAlias();
  } catch (e) { /* 忽略 */ }
}

/** 点击通知 → 跳会话；在 App.vue 挂载时注册一次 */
export function onPushOpened(router) {
  if (!isNative) return;
  Jpush.addListener('notificationOpened', (data) => {
    const cid = data?.conversation_id;
    if (cid) router.push(`/chat/${cid}`);
  });
}
```

### 4.2 接入点

| 时机 | 调用 |
|---|---|
| `App.vue` `onMounted` | `initPush()` + `onPushOpened(router)` |
| 登录成功（`store` 的 login 动作） | `bindPushAlias(user.id)` |
| 退出登录 / 切换账号 | `unbindPushAlias()` |
| 收到 WS `message:new` 且不在当前会话 | 可选：本地通知（见 §6.2 二选一，避免与极光重复） |

---

## 5. 后端（NestJS）接入

### 5.1 目录结构

```
src/modules/push/
  push.module.ts        # 导出 PushService
  jpush.provider.ts     # 极光 REST 直连
  push.service.ts       # 编排：离线筛选 + 内容脱敏 + 调用 provider
```

### 5.2 env（`.env.example` + `docker-compose.yml` 都要加）

```bash
# ===== 极光推送（Android 离线推送）=====
# 关闭时只打日志不真发，方便本地开发和灰度
JPUSH_ENABLED=false
JPUSH_APP_KEY=
JPUSH_MASTER_SECRET=
# 推送通道 id，必须与 APK 里创建的 NotificationChannel 一致
JPUSH_CHANNEL_ID=messages
# 离线消息保留时长（秒）；超过该时长不再打扰
JPUSH_TTL_SECONDS=3600
```

### 5.3 `jpush.provider.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';

export interface PushPayload {
  title: string;
  alert: string;
  conversationId: string;
  extra?: Record<string, string>;
}

/**
 * 极光推送（REST 直连，不依赖 SDK）。
 * 用 alias = userId 投递：无需维护 registration_id 表。
 */
@Injectable()
export class JpushProvider {
  private readonly logger = new Logger('JPush');
  private readonly endpoint = 'https://api.jpush.cn/v3/push';
  private readonly appKey = process.env.JPUSH_APP_KEY ?? '';
  private readonly masterSecret = process.env.JPUSH_MASTER_SECRET ?? '';
  private readonly channelId = process.env.JPUSH_CHANNEL_ID || 'messages';

  get enabled(): boolean {
    return process.env.JPUSH_ENABLED === 'true' && !!this.appKey && !!this.masterSecret;
  }

  /** 推给一组 userId（极光侧 alias）；调用方负责内容脱敏 */
  async pushToUsers(userIds: string[], msg: PushPayload): Promise<boolean> {
    if (!this.enabled || userIds.length === 0) return false;

    const ttl = parseInt(process.env.JPUSH_TTL_SECONDS || '3600', 10);
    const body = {
      platform: ['android'],
      audience: { alias: userIds },
      notification: {
        android: {
          alert: msg.alert,
          title: msg.title,
          channel_id: this.channelId,
          extras: { conversation_id: msg.conversationId, ...(msg.extra ?? {}) },
        },
      },
      options: {
        time_to_live: Number.isFinite(ttl) && ttl > 0 ? ttl : 3600,
      },
    };

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' + Buffer.from(`${this.appKey}:${this.masterSecret}`).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        this.logger.warn(`JPush failed status=${res.status} body=${text}`);
        return false;
      }
      this.logger.log(`JPush ok users=${userIds.length} resp=${text}`);
      return true;
    } catch (err: any) {
      // 推送失败绝不影响发消息主流程
      this.logger.error(`JPush error: ${err?.message || err}`);
      return false;
    }
  }
}
```

### 5.4 `push.service.ts`（编排 + 脱敏红线）

```ts
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Device } from '../../entities/device.entity';
import { Message } from '../../entities/message.entity';
import { AppUser } from '../../entities/app-user.entity';
import { Conversation } from '../../entities/conversation.entity';
import { JpushProvider } from './jpush.provider';

@Injectable()
export class PushService {
  private readonly logger = new Logger('Push');

  constructor(
    private readonly dataSource: DataSource,
    private readonly jpush: JpushProvider,
  ) {}

  /**
   * 消息发送后调用：只给「离线」成员推，且内容按类型脱敏。
   * 失败只记日志，不影响发送。
   */
  async notifyNewMessage(params: {
    message: Message;
    memberIds: string[];
    senderId: string;
  }): Promise<void> {
    if (!this.jpush.enabled) return;

    const { message, memberIds, senderId } = params;
    // 不推给自己；只推真正离线的人（在线已被 WS 覆盖）
    const candidates = memberIds.filter((id) => id !== senderId);
    const offline = await this.pickOffline(candidates);
    if (offline.length === 0) return;

    const [title, alert] = await this.buildContent(message);
    await this.jpush.pushToUsers(offline, {
      title,
      alert,
      conversationId: message.conversation_id,
      extra: { message_id: message.id, type: message.type },
    });
  }

  /** 离线判定：is_online=0 即视为离线（WS 连接数 + 心跳维护，见 ONLINE_PRESENCE.md） */
  private async pickOffline(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const qb = this.dataSource.getRepository(Device).createQueryBuilder('d');
    qb.select('DISTINCT d.user_id', 'user_id');
    qb.where('d.user_id IN (:...userIds)', { userIds });
    qb.andWhere('d.is_online = 1');
    const rows = await qb.getRawMany<{ user_id: string }>();
    const online = new Set(rows.map((r) => r.user_id));
    return userIds.filter((id) => !online.has(id));
  }

  /**
   * 内容脱敏（红线）：
   *  - 焚毁消息 → 「你有一条阅后即焚消息」
   *  - 加密消息 → 「你有一条加密消息」
   *  - 附件类   → 「[图片] [文件] [语音] [视频]」
   *  - 文本     → 前 30 字
   * 通知会显示在锁屏、会经过第三方服务器，带正文等于废掉阅后即焚。
   */
  private async buildContent(message: Message): Promise<[string, string]> {
    const convQb = this.dataSource.getRepository(Conversation).createQueryBuilder('c');
    convQb.select('c.name', 'name');
    convQb.where('c.id = :cid', { cid: message.conversation_id });
    const conv = await convQb.getRawOne<{ name: string | null }>();

    const senderQb = this.dataSource.getRepository(AppUser).createQueryBuilder('u');
    senderQb.select('u.display_name', 'display_name');
    senderQb.where('u.id = :uid', { uid: message.sender_id });
    const sender = await senderQb.getRawOne<{ display_name: string | null }>();

    const title = conv?.name || sender?.display_name || '焚信';
    const name = sender?.display_name || '对方';

    if (message.burn_ttl_seconds != null) return [title, '你有一条阅后即焚消息'];
    if (message.is_encrypted) return [title, '你有一条加密消息'];

    switch (message.type) {
      case 'image': return [title, `[图片] ${name}`];
      case 'voice': return [title, `[语音] ${name}`];
      case 'video': return [title, `[视频] ${name}`];
      case 'file':  return [title, `[文件] ${name}`];
      default:      return [title, `${name}：${(message.content ?? '').slice(0, 30)}`];
    }
  }
}
```

### 5.5 接入点（`MessageService.sendMessage` 末尾）

```ts
// 放在 WS 广播之后、return 之前
this.push
  .notifyNewMessage({ message: savedMsg, memberIds, senderId: params.senderId })
  .catch(() => { /* 内部已记日志 */ });
```

> **必须异步、不 await**：推送慢不能拖慢发消息。

---

## 6. 内容规范（红线）

| 消息类型 | 标题 | 正文 |
|---|---|---|
| 普通文本 | 会话名 / 发送者名 | `${发送者}：${前 30 字}` |
| 图片 | 会话名 | `[图片] 张三` |
| 文件 | 会话名 | `[文件] 张三` |
| 语音 / 视频 | 会话名 | `[语音]/[视频] 张三` |
| **焚毁消息** | 会话名 | **`你有一条阅后即焚消息`**（不带任何内容） |
| **E2E 加密消息** | 会话名 | **`你有一条加密消息`**（服务端本无明文） |

**为什么必须这样**：

1. 通知显示在**锁屏**上，旁人可见
2. 推送内容会经过极光服务器
3. 焚毁消息的价值就在"阅后不留"，一旦进了通知栏就等于留了副本

---

## 7. 联调步骤（每步独立验证）

| 步骤 | 验证内容 | 方法 | 通过标准 |
|---|---|---|---|
| 1 | SDK 初始化 | APK 调 `getRegistrationId()` | 返回非空 |
| 2 | alias 绑定成功 | 登录后调 `setAlias` | 极光控制台「设备查询」能按 alias 查到 |
| 3 | 极光能推到设备 | 控制台发送通知 | 手机弹出 |
| 4 | 被杀也能收 | 杀掉 App 后再推 | 手机弹出（不弹 → 缺厂商通道） |
| 5 | 后端能推 | 下面 curl | 手机弹出 |
| 6 | 业务能推 | 给离线用户发消息 | 弹出且**内容已脱敏** |
| 7 | 点击跳转 | 点通知 | 打开 App 并进入对应会话 |

### 后端直测 curl

```bash
APP_KEY=xxx
MASTER_SECRET=yyy
USER_ID=目标用户的uuid

curl -s -X POST https://api.jpush.cn/v3/push \
  -H "Authorization: Basic $(printf '%s:%s' "$APP_KEY" "$MASTER_SECRET" | base64)" \
  -H 'Content-Type: application/json' \
  -d "{
    \"platform\": [\"android\"],
    \"audience\": { \"alias\": [\"$USER_ID\"] },
    \"notification\": {
      \"android\": {
        \"alert\": \"你有一条阅后即焚消息\",
        \"title\": \"产品评审群\",
        \"channel_id\": \"messages\",
        \"extras\": { \"conversation_id\": \"会话uuid\" }
      }
    },
    \"options\": { \"time_to_live\": 3600 }
  }"
```

成功返回：

```json
{ "sendno": "0", "msg_id": "1234567890" }
```

---

## 8. 常见问题排查

| 现象 | 原因 | 解决 |
|---|---|---|
| registration_id 为空 | 包名 / AppKey 不匹配 | 控制台包名必须是 `com.burnmsg.app`；`JPUSH_PKGNAME` 一致 |
| 前台能收、杀掉收不到 | 只有自有通道 | 配厂商通道（§2.2） |
| 通知完全不显示（日志正常） | 缺 `POST_NOTIFICATIONS`（Android 13+） | 声明权限 + 运行时申请 |
| 通知显示灰块 / 空白 | `smallIcon` 是彩色图 | 换 24×24 纯白剪影 |
| Android 8+ 不显示 | 没建 NotificationChannel，或 `channel_id` 不一致 | APK 建 `messages` 渠道，后端 `JPUSH_CHANNEL_ID=messages` |
| 控制台显示"发送成功"但收不到 | 设备没绑上 alias / 设备被厂商通道过滤 | 控制台按 registration_id 查设备状态 |
| 重复收到两条 | 后端既推极光、前端又发本地通知 | 二选一（见 §6 补充） |
| 点击通知没反应 | 没处理 `notificationOpened` / extras 键名不一致 | 统一用 `conversation_id` |
| 一段时间后收不到 | 国产 ROM 电池优化 | 引导用户加白名单（见 §9） |
| 退出登录后仍收到别人的消息 | 没 `deleteAlias` | 登出时调 `unbindPushAlias()` |

### 避免重复提醒（二选一）

| 方案 | 前台 | 后台 | 被杀 |
|---|---|---|---|
| **只靠极光**（推荐） | 极光弹（略延迟） | 极光弹 | 厂商通道弹 |
| 极光 + 本地通知 | 本地立刻弹 | 本地弹 | 极光弹 |

若选"混合"，必须加互斥：前端弹过本地通知就不要再让极光弹（可给消息打标记，或后端只对"确认离线且超过 N 秒未读"的用户推）。

**建议先只靠极光**，链路最简单。

---

## 9. 国产 ROM 适配（用户侧指引）

即使厂商通道配好，部分机型仍需用户配合。建议做一页"通知设置指引"：

```
① 设置 → 应用管理 → 焚信 → 通知管理：全部允许
② 设置 → 电池 → 焚信 → 允许后台活动 / 关闭省电优化
③ 设置 → 应用启动管理 → 焚信 → 允许自启动（小米/华为特有）
④ 最近任务卡片下拉 → 锁定焚信（小米/OPPO 支持）
```

企业内网场景可由 IT 通过 MDM 统一下发，比接厂商通道成本更低。

---

## 10. 安全与合规

| 项 | 要求 |
|---|---|
| `JPUSH_MASTER_SECRET` | **只能放服务端**，绝不进 APK / 前端仓库 |
| AppKey | 可进 APK（必然公开），但不要写进 git（走 `gradle.properties` 或 CI 变量） |
| 推送内容 | 遵守 §6 脱敏红线；日志里也不要打印明文正文 |
| E2E 消息 | 服务端本无明文，推送自然安全；**不要**为了"推送好看"去解密 |
| 日志 | 只记 `users.length` / `msg_id` / 错误码，不记 alert 正文 |
| 频率 | 同一用户 1 分钟内最多 N 条（建议 3 条），避免轰炸 |

---

## 11. 排期与分工

| 阶段 | 内容 | 负责 | 预估 |
|---|---|---|---|
| 0 | 极光控制台建应用 + 提交厂商通道申请 | 你 | 0.5 天（审批等数天） |
| 1 | 后端 `JpushProvider` + `PushService` + env + 单测 | 后端 | 0.5 天 |
| 2 | Android 接 SDK（先试 Cordova 插件，不行自写） + 渠道 + 图标 | 安卓 | 1 天 |
| 3 | 前端 `push.js` + alias 绑定/解绑 + 点击跳转 | 前端 | 0.5 天 |
| 4 | 按 §7 联调（6~7 步） | 全员 | 0.5 天 |
| 5 | 灰度：先内部 10 台设备，观察到达率与耗电 | 运维 | 1 周 |

---

## 12. 不在本方案范围

| 项 | 说明 |
|---|---|
| **iOS** | 需另配 APNs 证书上传极光；当前只有 Android APK |
| **Web 端系统通知** | 走 Web Push（VAPID + Service Worker），与极光无关 |
| **桌面端** | 需 Electron overlay icon，与极光无关 |
| **精确到设备的推送** | 本方案用 alias（用户级）；若要"只推某台设备"，需引入 `push_tokens` 表 |

---

## 附录 A：alias vs registration_id

| 维度 | alias = userId（本方案） | registration_id |
|---|---|---|
| 服务端存储 | 不需要表 | 需 `push_tokens` 表 |
| 多设备 | 该用户所有设备都收到 ✅ | 精确到单设备 |
| 绑定上限 | 一个 alias 最多约 10 台（以极光文档为准） | 无 |
| 解绑 | `deleteAlias` | 删除 token 行 |
| 设备下线清理 | 极光自动 | 需自己处理失效 token |

**建议**：先用 alias。等真的需要"踢掉某台设备的推送"时再加表。

## 附录 B：与现有系统的对接点

| 现有能力 | 位置 | 用途 |
|---|---|---|
| `devices.is_online` / `socket_count` | V6.0 在线状态 | 离线判定（本方案 §5.4） |
| WS `message:new` | `events.types.ts` | 在线实时推送（不重复推） |
| 焚毁消息脱敏 | `MessageService.maskBurnMessage` | 推送文案与之保持一致 |
| `saveMessage` 返回的 memberIds | `MessageService.sendMessage` | 推送收件人来源 |

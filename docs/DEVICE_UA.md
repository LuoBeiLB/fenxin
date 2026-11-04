# 登录设备识别（User-Agent 解析）

> 版本：V6.2 · 2026-11-02
> 相关：`src/common/ua/ua-parser.ts`、`devices` 表、`GET /auth/devices`

---

## 1. 为什么改

以前设备信息是**客户端自报**的：

```
POST /auth/login { device_name: "Web", device_type: "web" }
```

现网 `devices` 表的真实数据：

| device_name | device_type | 数量 |
|---|---|---|
| Web | web | 15 |
| MacBook Pro | desktop | 4 |
| Pixel 8 | mobile | 4 |
| Android App | mobile | 3 |
| 回归-bbbb | web | 1 |

同一个浏览器出现过 `Web` 与 `web` 两种写法；管理端想展示"什么浏览器、什么系统"完全靠猜。

**V6.2 起：服务端解析请求头 `User-Agent`**，客户端自报的字段降级为"设备昵称"。

---

## 2. 落库字段（`devices` 表）

| 列 | 说明 |
|---|---|
| `user_agent` | 原始 UA，截断 512 字符 |
| `browser` | `Chrome` / `Safari` / `Edge` / `Firefox` / `Opera` / `Samsung Internet` / `WeChat` / `WeCom` / `QQBrowser` / `QQ` / `UC` / `Huawei Browser` / `Mi Browser` / `Android WebView` |
| `browser_version` | 浏览器版本 |
| `os` | `Windows` / `macOS` / `iOS` / `iPadOS` / `Android` / `HarmonyOS` / `Linux` / `ChromeOS` |
| `os_version` | 系统版本 |

> 存量设备这 5 列为 `NULL`（历史 UA 只存在审计日志里，无法回溯），前端回退显示 `device_name`。

---

## 3. 接口返回

`GET /auth/devices` 每条设备额外返回：

```json
{
  "device_name": "Web",
  "device_type": "web",
  "browser": "Chrome",
  "browser_version": "129.0.0.0",
  "os": "Windows",
  "os_version": "10/11",
  "ua_display": "Chrome 129 · Windows 10/11",
  "user_agent": "Mozilla/5.0 (Windows NT 10.0; ...) Chrome/129.0.0.0 Safari/537.36"
}
```

前端直接用 `ua_display` 展示即可；为 `null` 时回退 `device_name`。

---

## 4. 识别规则（顺序很重要）

```
微信用内置浏览器（MicroMessenger）→ WeChat
企业微信（wxwork）                → WeCom
QQ 浏览器（QQBrowser）            → QQBrowser
QQ 内置（QQ/8.x）                 → QQ
UC 浏览器（UCBrowser）            → UC
华为浏览器（HuaweiBrowser）       → Huawei Browser
小米浏览器（MiuiBrowser）         → Mi Browser
Android WebView（; wv 或 Version/4.0 Chrome/）→ Android WebView
Edge（Edg/ EdgA/ EdgiOS/ Edge/）  → Edge
Opera（OPR/ Opera/）              → Opera
三星浏览器（SamsungBrowser/）     → Samsung Internet
Firefox（Firefox/ FxiOS/）        → Firefox
Chrome（Chrome/ CriOS/ Chromium/）→ Chrome
Safari（含 Version/ 与 Safari/）  → Safari
```

系统识别顺序：

```
HarmonyOS / OpenHarmony（鸿蒙 UA 里也带 Android，必须先判）
Windows Phone
Windows NT → 10/11、8.1、8、7
iPadOS（iPad，或 Macintosh + Mobile/ 的桌面模式伪装）
iOS
Android
ChromeOS
macOS
Linux
```

设备类型：

| 判定 | `device_type` |
|---|---|
| `os = iPadOS` / UA 含 iPad、Tablet | `tablet` |
| Android 且 **不带** Mobile | `tablet` |
| iPhone / iPod / Android+Mobile / Windows Phone / Mobile Safari | `mobile` |
| Windows / macOS / Linux / ChromeOS | `desktop` |
| 其他 | `unknown` |

---

## 5. 已知局限（**不要用于安全判定**）

| 局限 | 说明 |
|---|---|
| **UA 可伪造** | 客户端想写什么都行 → 只能当展示信息，不能当风控依据 |
| **iOS 上全是 WebKit** | Chrome/Edge/Firefox 只能靠 `CriOS` / `EdgiOS` / `FxiOS` 前缀区分；识别不到就显示 Safari |
| **Chrome UA 冻结** | Chrome 101+ 版本号形如 `129.0.0.0`，只有大版本可信（展示时也只取大版本） |
| **Windows 10/11 不可分** | 两者 UA 都是 `NT 10.0`，统一显示 `10/11` |
| **iPadOS 桌面模式** | UA 伪装成 `Macintosh; Intel Mac OS X 10_15`，靠 `Mobile/` 特征识别 |
| **桌面微信内置浏览器** | 部分版本 UA 不带 `MicroMessenger`，会退化成 Chrome |

---

## 6. 测试

`test/common/ua-parser.spec.ts`（20 条）覆盖：

- Chrome / Edge / Firefox / Safari / Opera / 三星
- Windows 7 / 10、macOS、iOS、iPadOS（含桌面模式伪装）、Android、HarmonyOS
- 微信、QQ 浏览器、UC、华为浏览器
- Android WebView 与 Chrome 的区分
- 空值 / `curl` 等异常 UA 不抛错

```bash
node node_modules/jest/bin/jest.js --ci --runInBand --coverage=false test/common/ua-parser.spec.ts
```

# App 自更新对接指南（V5.8）

> 后端已就绪（v5.8）。本文档面向两端的对接工作：
> - **App 前端（李长荣）**：第三章——启动自检 + WS 实时监听 + 下载安装插件
> - **管理后台前端（饶伟元）**：第四章——版本管理页 5 个接口
>
> 所有响应走统一包装 `{ code: 0, message, data }`；错误时 `code != 0`。

---

## 一、整体链路

```
管理员在后台发版（上传 APK + 填版本号）
        │
        ├─→ 落库 app_versions（published=true）
        │
        └─→ WS 广播 app:update 给全部在线用户（离线用户走启动自检兜底）
                 │
App 收到事件 / 启动自检 → 比对 version_code（整数！）
        │
        ├─ 无更新 → 什么都不做
        └─ 有更新 → 弹窗（force=true 无"下次再说"）
                 │
                 └─ 用户点"立即更新" → 下载 APK（进度条）→ 唤起系统安装器 → 用户点"安装"
```

**核心规则：版本判定一律用整数 `version_code`**（Android versionCode），不要用 `version_name`
字符串比较——`"5.10" < "5.9"` 在字符串比较下是成立的，会漏更新。

---

## 二、后端接口

### 2.1 App 端：检查更新

```
GET /api/v1/app-versions/latest?platform=android&current_code=57
```

- **公开接口**（无需登录，限流 30 次/分/IP）——App 启动时可能尚未登录
- `platform` 可选：`android`（默认）/ `ios`，返回该平台的最新版
- `current_code` 可选：传客户端当前 versionCode，已是最新则 `data: null`

**响应（有更新）：**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "platform": "android",
    "version_code": 58,
    "version_name": "5.8",
    "apk_url": "/uploads/app/fenxin-android-v5.8-a1b2c3d4.apk",
    "file_size": 20971520,
    "force": false,
    "notes": "1. 修复焚毁倒计时偏移\n2. 新增点开才焚",
    "published_at": "2026-09-01T10:00:00.000Z"
  }
}
```

**响应（无更新 / 已是最新）：** `"data": null`

- `apk_url` 是相对路径，客户端自行拼 `baseURL`（如 `https://api.xxx.com`）
- `file_size` 字节；`force` 强更；`notes` 更新说明（弹窗内展示，含换行 `\n`）

### 2.2 管理后台端：版本管理

| 方法 | 路径 | 说明 | 限流 |
|---|---|---|---|
| POST | `/api/v1/app-versions` | 上传 APK 发版（multipart） | 5 次/分/IP |
| GET | `/api/v1/app-versions/manage?page=1&pageSize=20` | 版本列表（version_code 倒序） | — |
| PATCH | `/api/v1/app-versions/:id` | 改 force / notes / published | — |
| DELETE | `/api/v1/app-versions/:id` | 删版本记录（磁盘 APK 保留） | — |

以上均需 **admin 角色 JWT**。

**POST 发版（multipart/form-data）：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | file | ✅ | APK 文件，仅 `.apk`，≤50MB |
| `platform` | string | ❌ | `android`（默认）/ `ios` |
| `version_name` | string | ✅ | 展示用版本名，如 `5.8` |
| `version_code` | int | ✅ | 必须大于**该平台**当前最大值（服务端校验，不满足返回 400 并说明当前最大值；两平台 version_code 互不影响） |
| `force` | boolean | ❌ | 默认 false。form-data 里传字符串 `true`/`false` 即可（服务端已做归一化） |
| `notes` | string | ❌ | 更新说明，默认空 |

**PATCH 可改字段（均可选）：**

```json
{ "force": true, "notes": "新文案", "published": false }
```

- `published: false` = **撤回**：App 端 latest 不再返回该版本（已下载中的不受影响）
- `published: false → true`（恢复发布）或已发布版本切换 `force` → 会**重新 WS 广播**给在线用户
- 仅改 `notes` 不广播（不打扰在线用户）

---

## 三、App 前端对接（李长荣）

### 3.1 启动自检

App 启动（splash 后、登录页之前即可）：

```js
import { App as CapApp } from '@capacitor/app';

const info = await CapApp.getInfo();
// info.build = Android versionCode（整数，来自 android/app/build.gradle 的 versionCode）
const res = await fetch(
  `${baseURL}/api/v1/app-versions/latest?platform=android&current_code=${info.build}`
);
const { data } = await res.json();
if (data) showUpdateDialog(data); // null 则静默
```

- `@capacitor/app` 若未安装：`npm i @capacitor/app && npx cap sync`
- 若不想引插件，也可在 `capacitor.config` 维护常量，但**以 build.gradle 的 versionCode 为准最稳**（打包时唯一事实来源）

### 3.2 WS 实时监听 `app:update`

在 `services/ws.ts` 的 `WS_EVENTS` 常量里补一行（与后端事件名对齐）：

```js
APP_UPDATE: 'app:update',
```

监听（登录后 WS 建立时生效）：

```js
socket.on('app:update', (payload) => {
  // payload: { platform, version_code, version_name, apk_url, file_size, force, notes, published_at }
  if (payload.platform !== 'android') return; // 只处理自己平台的事件
  const myCode = Number(currentVersionCode);
  if (payload.version_code > myCode) showUpdateDialog(payload);
});
```

- payload 结构与 latest 接口的 `data` 完全一致，可复用同一个 `showUpdateDialog`
- 已在用旧版本、同一事件重复推送（管理员改强更开关）时：若弹窗已展示，更新弹窗内容即可，不要叠弹窗

### 3.3 弹窗交互

- **普通更新（force=false）**：标题"发现新版本 v{version_name}"，按钮「立即更新」/「下次再说」
  - 点"下次再说"：把 `version_code` 存入 localStorage（如 `dismissed_update_code`），本次运行期内同版本不再弹；**下次冷启动仍会提示**（不自检也行——启动自检时跳过 dismissed 的版本号）
- **强制更新（force=true）**：无取消按钮，弹窗不可关闭（不可点遮罩、无右上角×）
- 弹窗内容：`notes` 按 `\n` 分行展示；可显示文件大小（`file_size / 1024 / 1024` 保留 1 位小数）

### 3.4 下载与安装（Android）

WebView 内直接 `window.open(apkUrl)` 或 `<a download>` **不可靠**（Android WebView 不会像系统浏览器那样弹安装）。标准做法是一个 ~50 行的迷你 Capacitor 插件：**下载到 cacheDir → FileProvider 转 content:// URI → Intent 唤起系统安装器**。

**① 插件 Java 代码**（`android/app/src/main/java/<包名>/DownloadApkPlugin.java`，包名按项目实际改）：

```java
package com.burnmsg.app; // ← 改成实际包名

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "DownloadApk")
public class DownloadApkPlugin extends Plugin {

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("url is required"); return; }

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                File apk = new File(getContext().getCacheDir(), "burnmsg-update.apk");
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.connect();
                int total = conn.getContentLength();
                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[8192];
                    int len; long done = 0; int lastPct = -1;
                    while ((len = in.read(buf)) != -1) {
                        out.write(buf, 0, len);
                        done += len;
                        if (total > 0) {
                            int pct = (int) (done * 100 / total);
                            if (pct != lastPct) {          // 每 1% 通知一次 JS
                                lastPct = pct;
                                JSObject ret = new JSObject();
                                ret.put("progress", pct);
                                notifyListeners("downloadProgress", ret);
                            }
                        }
                    }
                }
                // 下载完成 → 唤起系统安装器
                Uri uri = FileProvider.getUriForFile(getContext(),
                        getContext().getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
            } catch (Exception e) {
                call.reject("下载失败: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }
}
```

**② MainActivity 注册插件**：

```java
// android/app/src/main/java/<包名>/MainActivity.java
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(DownloadApkPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
```

**③ AndroidManifest.xml**（application 标签内加 provider；manifest 根加权限）：

```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />

<application ...>
    <provider
        android:name="androidx.core.content.FileProvider"
        android:authorities="${applicationId}.fileprovider"
        android:exported="false"
        android:grantUriPermissions="true">
        <meta-data
            android:name="android.support.FILE_PROVIDER_PATHS"
            android:resource="@xml/file_paths" />
    </provider>
</application>
```

> 若项目已有 FileProvider（authority 不同则并存即可），只补 `file_paths` 里的 cache-path。

**④ res/xml/file_paths.xml**（新建）：

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="update_cache" path="." />
</paths>
```

**⑤ JS 侧调用**：

```js
import { registerPlugin } from '@capacitor/core';
const DownloadApk = registerPlugin('DownloadApk');

// 弹窗"立即更新"按钮：
DownloadApk.addListener('downloadProgress', ({ progress }) => {
  // 更新进度条 UI（0-100）
});

try {
  await DownloadApk.downloadAndInstall({ url: baseURL + data.apk_url });
  // 走到这里说明安装器已唤起，系统界面接管
} catch (e) {
  // 下载失败：toast + 恢复按钮可点击
}
```

**⑥ 首次安装的系统开关**：Android 8+ 第一次会弹"允许此应用安装未知应用"的系统页
（因为请求了 `REQUEST_INSTALL_PACKAGES`）。用户打开开关返回后重新点"立即更新"即可。
建议在 catch/返回时检测并提示一句"请允许安装权限后重试"。

### 3.5 versionCode 管理（发版纪律）

每次发版三处 versionCode 必须一致递增：

1. `android/app/build.gradle` → `defaultConfig { versionCode 58; versionName "5.8" }`
2. 管理后台发版表单填的 `version_code`
3. （展示用）`version_name`

**顺序**：先改 build.gradle 打出正式 APK → 再去管理后台上传该 APK 并填同样的 versionCode。

### 3.6 验收清单（App 端）

- [ ] 启动自检：低版本启动 → 弹窗；已是最新 → 无感
- [ ] WS 实时：登录在线时管理员发版 → 立即弹窗（不重启 App）
- [ ] 普通更新：可点"下次再说"，同版本本次运行不再弹
- [ ] 强更（force=true）：无取消按钮
- [ ] 下载：进度条推进、断网失败可重试
- [ ] 安装：系统安装器弹出、覆盖安装后旧数据保留（同签名）
- [ ] Android 8+ 首次：引导开"允许安装未知应用"开关

---

## 四、管理后台对接（饶伟元）

版本管理页建议布局：上方"发新版"表单 + 下方版本列表表格。

### 4.1 发版表单

| 字段 | 控件 | 备注 |
|---|---|---|
| 平台 | select | android / ios（默认 android；列表页可按平台筛选） |
| APK 文件 | file input | 仅 .apk；前端预校验 ≤50MB（后端也会拦） |
| 版本名 | input | 如 `5.8` |
| versionCode | number input | **进入页面时自动填"当前平台最大值+1"**（从列表接口该平台第一条取 `version_code+1`），允许手改 |
| 强制更新 | switch | 默认关；旁边加提示"开启后用户不升级无法使用 App" |
| 更新说明 | textarea | 支持换行；发版日志展示给全体用户 |

提交：`POST /api/v1/app-versions`，multipart（`file` + 上述字段）。注意 axios 需用 FormData 且不要手动设 Content-Type。响应成功 = 已发布并广播。

### 4.2 版本列表

`GET /api/v1/app-versions/manage?page=1&pageSize=20` → `data: { data: [...], total }`

表格列：平台 / 版本名 / versionCode / 强更 / 状态（已发布/已撤回）/ 更新说明 / 发布时间 / 操作

行操作：

- **撤回**：`PATCH /app-versions/:id` body `{ "published": false }`（App 端立刻不再提示该版本）
- **恢复发布**：同接口 `{ "published": true }`（会重新广播）
- **切强更**：同接口 `{ "force": true/false }`（已发布版本切强更会重新广播，在线用户立即收到）
- **删除**：`DELETE /app-versions/:id`（仅删记录，已分发的下载链接不失效；二次确认弹窗）

### 4.3 错误码提示

- 发版 400 `version_code 必须大于 <platform> 平台当前最大值 N`：提示"该平台 versionCode 需大于 N"，输入框自动填 N+1
- 发版 400 `仅支持上传 .apk 文件` / `APK 体积超过 50MB 上限`：表单级提示
- 限流 429：发版接口 5 次/分，正常操作触发不了

---

## 五、联调顺序建议

1. 管理后台页面上线 → 管理员发一个 versionCode 大于当前 App 的测试包（APK 可用当前正式包，versionCode 填大）
2. App 端（在线状态）→ 应立即收到 `app:update` 弹窗
3. App 端杀进程冷启动 → 启动自检弹窗
4. 点"立即更新" → 下载进度 → 系统安装器 → 覆盖安装成功
5. 管理后台撤回该测试版本 → App 端 latest 返回 null、不再提示
6. 清理：删除测试版本记录

---

*后端实现：`src/modules/app-version/`（v5.8）；数据库迁移 `1767300000000-AddAppVersions`（含 platform 列 + (platform, version_code) 联合唯一）；单测 `test/modules/app-version/app-version.service.spec.ts`（14 用例，含跨平台互不影响用例）。*

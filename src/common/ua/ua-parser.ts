/**
 * 轻量 User-Agent 解析（零依赖）。
 *
 * 目的：登录时由**服务端**识别浏览器 / 系统 / 设备类型，而不是信任客户端自报的
 * `device_name` / `device_type`（网页端与 APK 写法不统一，且可伪造）。
 *
 * 只做"够用"的粒度：
 *  - browser：Chrome / Safari / Edge / Firefox / Opera / Samsung Internet /
 *             WeChat / QQ浏览器 / UC / 华为浏览器 / Android WebView / 未知
 *  - os：Windows / macOS / iOS / iPadOS / Android / HarmonyOS / Linux / ChromeOS / 未知
 *  - device_type：mobile / tablet / desktop / unknown
 *
 * 已知局限（不要指望它 100% 准）：
 *  1. iOS 上所有浏览器（Chrome/Edge/Firefox）都用 WebKit 且 UA 里都带 Safari 标识，
 *     只能靠 CriOS / EdgiOS / FxiOS 这些前缀识别；识别不到就显示 Safari。
 *  2. Chrome 从 101 起做 UA 冻结（Chrome/129.0.0.0），版本号只能拿到大版本。
 *  3. UA 可被客户端任意伪造，只能当"展示信息"，**不能用于安全判定**。
 *  4. 微信/QQ 内置浏览器会同时带 Chrome 标识，必须先匹配微信/QQ 再匹配 Chrome。
 */

export type UaDeviceType = 'mobile' | 'tablet' | 'desktop' | 'unknown';

export interface UaInfo {
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  os_version: string | null;
  device_type: UaDeviceType;
}

const UNKNOWN: UaInfo = {
  browser: null,
  browser_version: null,
  os: null,
  os_version: null,
  device_type: 'unknown',
};

/** 从 "Xxx/1.2.3" 里取版本号 */
function pickVersion(ua: string, token: RegExp): string | null {
  const m = ua.match(token);
  return m?.[1] ?? null;
}

/** Windows NT 版本号 → 用户可读名称 */
function windowsVersion(nt: string): string {
  switch (nt) {
    case '10.0':
      // Windows 11 的 UA 也是 NT 10.0，无法区分，统一显示 10/11
      return '10/11';
    case '6.3':
      return '8.1';
    case '6.2':
      return '8';
    case '6.1':
      return '7';
    default:
      return nt;
  }
}

/** "10_15_7" / "14.2" → "10.15.7" / "14.2" */
function dots(version: string | null | undefined): string | null {
  if (!version) return null;
  return version.replace(/_/g, '.');
}

function detectOs(ua: string): { os: string | null; os_version: string | null } {
  // HarmonyOS 优先于 Android（鸿蒙 UA 里带 Android）
  if (/HarmonyOS|OpenHarmony/i.test(ua)) {
    return {
      os: 'HarmonyOS',
      os_version: dots(pickVersion(ua, /(?:HarmonyOS|OpenHarmony)[/\s]([\d._]+)/i)),
    };
  }
  if (/Windows Phone/i.test(ua)) {
    return { os: 'Windows Phone', os_version: dots(pickVersion(ua, /Windows Phone(?: OS)? ([\d.]+)/i)) };
  }
  if (/Windows NT ([\d.]+)/i.test(ua)) {
    const nt = pickVersion(ua, /Windows NT ([\d.]+)/i);
    return { os: 'Windows', os_version: nt ? windowsVersion(nt) : null };
  }
  // iPadOS 13+ 默认伪装成 macOS（Macintosh; Intel Mac OS X 10_15），靠触摸点特征识别
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile\/\w+/i.test(ua))) {
    return { os: 'iPadOS', os_version: dots(pickVersion(ua, /OS ([\d._]+) like Mac OS X/i)) };
  }
  if (/iPhone|iPod/i.test(ua)) {
    return { os: 'iOS', os_version: dots(pickVersion(ua, /OS ([\d._]+) like Mac OS X/i)) };
  }
  if (/Android/i.test(ua)) {
    return { os: 'Android', os_version: dots(pickVersion(ua, /Android[\s/]([\d.]+)/i)) };
  }
  if (/CrOS/i.test(ua)) {
    return { os: 'ChromeOS', os_version: null };
  }
  if (/Mac OS X|Macintosh/i.test(ua)) {
    return { os: 'macOS', os_version: dots(pickVersion(ua, /Mac OS X ([\d._]+)/i)) };
  }
  if (/Linux/i.test(ua)) {
    return { os: 'Linux', os_version: null };
  }
  return { os: null, os_version: null };
}

function detectBrowser(ua: string): { browser: string | null; browser_version: string | null } {
  // 顺序很重要：内置浏览器 > 套壳 Chromium > Chrome > Safari

  // 微信内置浏览器：MicroMessenger/8.0.47
  if (/MicroMessenger/i.test(ua)) {
    return { browser: 'WeChat', browser_version: pickVersion(ua, /MicroMessenger\/([\d.]+)/i) };
  }
  // 企业微信
  if (/wxwork/i.test(ua)) {
    return { browser: 'WeCom', browser_version: pickVersion(ua, /wxwork\/([\d.]+)/i) };
  }
  // QQ / QQ 浏览器
  if (/QQBrowser/i.test(ua)) {
    return { browser: 'QQBrowser', browser_version: pickVersion(ua, /QQBrowser\/([\d.]+)/i) };
  }
  if (/\bQQ\/[\d.]+/i.test(ua) && !/QQBrowser/i.test(ua)) {
    return { browser: 'QQ', browser_version: pickVersion(ua, /\bQQ\/([\d.]+)/i) };
  }
  // UC 浏览器
  if (/UCBrowser/i.test(ua)) {
    return { browser: 'UC', browser_version: pickVersion(ua, /UCBrowser\/([\d.]+)/i) };
  }
  // 华为浏览器
  if (/HuaweiBrowser/i.test(ua)) {
    return { browser: 'Huawei Browser', browser_version: pickVersion(ua, /HuaweiBrowser\/([\d.]+)/i) };
  }
  // 小米浏览器
  if (/MiuiBrowser/i.test(ua)) {
    return { browser: 'Mi Browser', browser_version: pickVersion(ua, /MiuiBrowser\/([\d.]+)/i) };
  }
  // Android WebView：UA 里带 "; wv" 或 "Version/4.0 Chrome/xx Mobile Safari"
  if (/;\s*wv\)?/i.test(ua) || /Version\/4\.0 Chrome\//i.test(ua)) {
    return {
      browser: 'Android WebView',
      browser_version: pickVersion(ua, /Chrome\/([\d.]+)/i),
    };
  }

  // Edge（Chromium 版）：Edg/129.0.0.0 / EdgA/ / EdgiOS/
  const edge = ua.match(/(?:Edg|EdgA|EdgiOS)\/([\d.]+)/i);
  if (edge) return { browser: 'Edge', browser_version: edge[1] };
  // 旧 Edge（EdgeHTML）：Edge/18.19041
  const legacyEdge = ua.match(/\bEdge\/([\d.]+)/i);
  if (legacyEdge) return { browser: 'Edge', browser_version: legacyEdge[1] };

  // Opera：OPR/ / Opera/
  const opera = ua.match(/(?:OPR|Opera)\/([\d.]+)/i);
  if (opera) return { browser: 'Opera', browser_version: opera[1] };

  // 三星浏览器
  const samsung = ua.match(/SamsungBrowser\/([\d.]+)/i);
  if (samsung) return { browser: 'Samsung Internet', browser_version: samsung[1] };

  // Firefox：Firefox/ / FxiOS/（iOS 版）
  const firefox = ua.match(/(?:Firefox|FxiOS)\/([\d.]+)/i);
  if (firefox) return { browser: 'Firefox', browser_version: firefox[1] };

  // Chrome（含 iOS 的 CriOS、Android 的 Chrome/）
  const chrome = ua.match(/(?:Chrome|CriOS|Chromium)\/([\d.]+)/i);
  if (chrome) return { browser: 'Chrome', browser_version: chrome[1] };

  // Safari：只在有 Safari/ 且带 Version/ 时认定（WebView 已被前面拦截）
  if (/Safari\//i.test(ua)) {
    return {
      browser: 'Safari',
      browser_version: pickVersion(ua, /Version\/([\d.]+)/i),
    };
  }

  return { browser: null, browser_version: null };
}

function detectDeviceType(ua: string, os: string | null): UaDeviceType {
  if (!ua) return 'unknown';
  // 平板：iPad / iPadOS（含伪装成 Macintosh 的桌面模式）/ Android 且不带 Mobile
  if (os === 'iPadOS') return 'tablet';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet';
  // 手机
  if (/iPhone|iPod|Android.*Mobile|Windows Phone|Mobile Safari/i.test(ua)) return 'mobile';
  // 桌面系统
  if (os === 'Windows' || os === 'macOS' || os === 'Linux' || os === 'ChromeOS') return 'desktop';
  return 'unknown';
}

/** 主入口：解析 UA 字符串（空/异常一律返回 unknown，绝不抛错） */
export function parseUserAgent(userAgent?: string | null): UaInfo {
  const ua = (userAgent ?? '').trim();
  if (!ua) return { ...UNKNOWN };

  const { os, os_version } = detectOs(ua);
  const { browser, browser_version } = detectBrowser(ua);
  const device_type = detectDeviceType(ua, os);

  return { browser, browser_version, os, os_version, device_type };
}

/**
 * 生成展示串，例如 "Chrome 129 · Windows 10/11"、"WeChat 8.0 · Android 14"。
 * 解析不出来时返回 null（调用方自行回退到客户端自报的 device_name）。
 */
export function formatUaDisplay(info: UaInfo): string | null {
  const parts: string[] = [];

  if (info.browser) {
    // Chrome UA 冻结后版本号形如 129.0.0.0，只留主版本更可读
    const version = info.browser_version ? info.browser_version.split('.')[0] : null;
    parts.push(version ? `${info.browser} ${version}` : info.browser);
  }
  if (info.os) {
    parts.push(info.os_version ? `${info.os} ${info.os_version}` : info.os);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

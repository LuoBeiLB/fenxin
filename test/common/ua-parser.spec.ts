import { formatUaDisplay, parseUserAgent } from 'src/common/ua/ua-parser';

/**
 * User-Agent 解析（V6.2 登录设备识别）。
 *
 * 只校验"能不能分对"，不追求覆盖所有冷门浏览器。
 * 真实 UA 常量取自主流客户端的现网抓包。
 */

const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  edgeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/129.0.2792.65 Version/17.0 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.70 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Mobile Safari/537.36',
  ipad:
    'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  ipadOsDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/605.1.15',
  wechatAndroid:
    'Mozilla/5.0 (Linux; Android 14; V2309A Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160065 MMWEBSDK/20240404 MMWEBID/1234 MicroMessenger/8.0.47.2560(0x28002F35) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  qqBrowser:
    'Mozilla/5.0 (Linux; U; Android 14; zh-cn; V2309A Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 MQQBrowser/14.6 Mobile Safari/537.36',
  ucBrowser:
    'Mozilla/5.0 (Linux; U; Android 14; zh-CN; V2309A Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UCBrowser/15.5.8.1225 Mobile Safari/537.36',
  harmony:
    'Mozilla/5.0 (Phone; OpenHarmony 4.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile HuaweiBrowser/5.0.4.300',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  opera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0',
  win7:
    'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
};

describe('parseUserAgent（V6.2 登录设备识别）', () => {
  it('Chrome / Windows 10', () => {
    const r = parseUserAgent(UA.chromeWin);
    expect(r).toMatchObject({
      browser: 'Chrome',
      browser_version: '129.0.0.0',
      os: 'Windows',
      os_version: '10/11',
      device_type: 'desktop',
    });
  });

  it('Edge（Chromium）不被识别成 Chrome', () => {
    const r = parseUserAgent(UA.edgeWin);
    expect(r.browser).toBe('Edge');
    expect(r.browser_version).toBe('129.0.0.0');
    expect(r.os).toBe('Windows');
  });

  it('Firefox / macOS', () => {
    const r = parseUserAgent(UA.firefoxMac);
    expect(r).toMatchObject({ browser: 'Firefox', os: 'macOS', os_version: '10.15', device_type: 'desktop' });
  });

  it('Safari / macOS', () => {
    const r = parseUserAgent(UA.safariMac);
    expect(r).toMatchObject({ browser: 'Safari', browser_version: '17.6', os: 'macOS' });
  });

  it('iPhone Safari → iOS + mobile', () => {
    const r = parseUserAgent(UA.safariIphone);
    expect(r).toMatchObject({ browser: 'Safari', os: 'iOS', os_version: '17.6', device_type: 'mobile' });
  });

  it('iOS 上的 Chrome（CriOS）识别为 Chrome', () => {
    const r = parseUserAgent(UA.chromeIos);
    expect(r).toMatchObject({ browser: 'Chrome', os: 'iOS', device_type: 'mobile' });
  });

  it('iOS 上的 Edge（EdgiOS）识别为 Edge', () => {
    const r = parseUserAgent(UA.edgeIos);
    expect(r.browser).toBe('Edge');
  });

  it('Android Chrome → mobile', () => {
    const r = parseUserAgent(UA.chromeAndroid);
    expect(r).toMatchObject({ browser: 'Chrome', os: 'Android', os_version: '14', device_type: 'mobile' });
  });

  it('Android WebView（; wv）单独识别，不显示成微信/Chrome 混淆', () => {
    const r = parseUserAgent(UA.androidWebView);
    expect(r.browser).toBe('Android WebView');
    expect(r.device_type).toBe('mobile');
  });

  it('iPad → tablet', () => {
    const r = parseUserAgent(UA.ipad);
    expect(r).toMatchObject({ browser: 'Safari', os: 'iPadOS', device_type: 'tablet' });
  });

  it('iPadOS 桌面模式（伪装成 Macintosh + Mobile）仍识别为 iPadOS', () => {
    const r = parseUserAgent(UA.ipadOsDesktopMode);
    expect(r).toMatchObject({ os: 'iPadOS', device_type: 'tablet' });
  });

  it('微信内置浏览器优先于 Chrome', () => {
    const r = parseUserAgent(UA.wechatAndroid);
    expect(r).toMatchObject({ browser: 'WeChat', browser_version: '8.0.47.2560', os: 'Android' });
  });

  it('QQ 浏览器优先于 Chrome', () => {
    const r = parseUserAgent(UA.qqBrowser);
    expect(r.browser).toBe('QQBrowser');
  });

  it('UC 浏览器', () => {
    const r = parseUserAgent(UA.ucBrowser);
    expect(r.browser).toBe('UC');
  });

  it('鸿蒙（HarmonyOS/OpenHarmony）优先于 Android', () => {
    const r = parseUserAgent(UA.harmony);
    expect(r).toMatchObject({ os: 'HarmonyOS', os_version: '4.1', browser: 'Huawei Browser' });
  });

  it('三星浏览器', () => {
    const r = parseUserAgent(UA.samsung);
    expect(r.browser).toBe('Samsung Internet');
  });

  it('Opera', () => {
    const r = parseUserAgent(UA.opera);
    expect(r.browser).toBe('Opera');
  });

  it('Windows 7（NT 6.1）', () => {
    const r = parseUserAgent(UA.win7);
    expect(r).toMatchObject({ os: 'Windows', os_version: '7' });
  });

  it('空 / null / 乱串不抛错，返回 unknown', () => {
    for (const v of ['', null, undefined, 'curl/8.4.0']) {
      const r = parseUserAgent(v as any);
      expect(r.device_type).toBe('unknown');
      expect(r.browser).toBeNull();
      expect(r.os).toBeNull();
    }
  });

  it('formatUaDisplay 生成可读串（Chrome 只显示大版本）', () => {
    expect(formatUaDisplay(parseUserAgent(UA.chromeWin))).toBe('Chrome 129 · Windows 10/11');
    expect(formatUaDisplay(parseUserAgent(UA.wechatAndroid))).toBe('WeChat 8 · Android 14');
    expect(formatUaDisplay(parseUserAgent(''))).toBeNull();
  });
});

import { DataSource } from 'typeorm';
import { PushService } from 'src/modules/push/push.service';
import { JpushProvider } from 'src/modules/push/jpush.provider';

/**
 * 离线推送编排单测（V6.2）。
 *
 * 核心断言（红线）：
 *  1. 焚毁消息的推送正文**不含任何内容**，只推「你有一条阅后即焚消息」
 *  2. 加密消息同理
 *  3. 在线用户不推（WS 已覆盖，避免双提醒）
 *  4. 发送者本人不推
 *  5. 开关关闭 / 推送抛错 都不影响主流程（不抛异常）
 */

/** 快速构造一条消息 */
function msg(over: Partial<any> = {}) {
  return {
    id: 'm-1',
    conversation_id: 'c-1',
    sender_id: 'u-sender',
    type: 'text',
    content: '这是一条很长的消息内容，用来验证推送正文是否被截断到 30 个字以内，后面还有很多字',
    is_encrypted: false,
    burn_ttl_seconds: null,
    ...over,
  } as any;
}

function buildService(opts: {
  onlineUserIds?: string[];
  convName?: string | null;
  senderName?: string | null;
  enabled?: boolean;
}) {
  const qb = (kind: string) => {
    const q: any = {};
    ['select', 'where', 'andWhere', 'orderBy', 'limit', 'offset'].forEach((m) => {
      q[m] = jest.fn(() => q);
    });
    q.getRawMany = jest.fn(async () =>
      kind === 'device' ? (opts.onlineUserIds ?? []).map((id) => ({ user_id: id })) : [],
    );
    q.getRawOne = jest.fn(async () => {
      if (kind === 'conv') return { name: opts.convName === undefined ? '产品评审群' : opts.convName };
      if (kind === 'sender') return { display_name: opts.senderName ?? '张三' };
      return null;
    });
    return q;
  };

  const dataSource: any = {
    getRepository: (entity: any) => {
      const name = entity?.name;
      return {
        createQueryBuilder: () =>
          qb(name === 'Device' ? 'device' : name === 'Conversation' ? 'conv' : 'sender'),
      };
    },
  };

  const provider: any = {
    enabled: opts.enabled ?? true,
    pushToUsers: jest.fn(async () => true),
  };

  const service = new PushService(dataSource as DataSource, provider as JpushProvider);
  return { service, provider };
}

const baseParams = { memberIds: ['u-sender', 'u-a', 'u-b'], senderId: 'u-sender' };

describe('PushService · 内容脱敏（红线）', () => {
  it('焚毁消息：正文不含内容，只推固定文案', async () => {
    const { service, provider } = buildService({ onlineUserIds: [] });
    await service.notifyNewMessage({
      message: msg({ burn_ttl_seconds: 3600, content: '绝密内容ABC' }),
      ...baseParams,
    });

    expect(provider.pushToUsers).toHaveBeenCalledTimes(1);
    const [, payload] = provider.pushToUsers.mock.calls[0];
    expect(payload.alert).toBe('你有一条阅后即焚消息');
    expect(JSON.stringify(payload)).not.toContain('绝密内容ABC');
  });

  it('加密消息：正文不含内容，只推固定文案', async () => {
    const { service, provider } = buildService({ onlineUserIds: [] });
    await service.notifyNewMessage({
      message: msg({ is_encrypted: true, content: '密文不该泄露' }),
      ...baseParams,
    });
    const [, payload] = provider.pushToUsers.mock.calls[0];
    expect(payload.alert).toBe('你有一条加密消息');
    expect(JSON.stringify(payload)).not.toContain('密文不该泄露');
  });

  it('普通文本：正文截断到 30 字，且带发送者名', async () => {
    const { service, provider } = buildService({ onlineUserIds: [] });
    await service.notifyNewMessage({ message: msg(), ...baseParams });
    const [, payload] = provider.pushToUsers.mock.calls[0];
    expect(payload.alert).toContain('张三：');
    // 「张三：」4 字符 + 30 字内容
    expect(payload.alert.length).toBeLessThanOrEqual('张三：'.length + 30);
    expect(payload.title).toBe('产品评审群');
  });

  it('附件类：用 [图片]/[文件] 占位，不带文件名', async () => {
    const { service, provider } = buildService({ onlineUserIds: [] });
    await service.notifyNewMessage({
      message: msg({ type: 'file', content: null, file_name: '绝密合同.pdf' }),
      ...baseParams,
    });
    const [, payload] = provider.pushToUsers.mock.calls[0];
    expect(payload.alert).toBe('[文件] 张三');
    expect(JSON.stringify(payload)).not.toContain('绝密合同');
  });
});

describe('PushService · 收件人筛选', () => {
  it('在线用户不推（只推离线者）', async () => {
    // u-a 在线、u-b 离线
    const { service, provider } = buildService({ onlineUserIds: ['u-a'] });
    await service.notifyNewMessage({ message: msg(), ...baseParams });

    const [userIds] = provider.pushToUsers.mock.calls[0];
    expect(userIds).toEqual(['u-b']);
  });

  it('全部在线 → 完全不调用推送', async () => {
    const { service, provider } = buildService({ onlineUserIds: ['u-a', 'u-b'] });
    await service.notifyNewMessage({ message: msg(), ...baseParams });
    expect(provider.pushToUsers).not.toHaveBeenCalled();
  });

  it('发送者本人永远不推', async () => {
    const { service, provider } = buildService({ onlineUserIds: [] });
    await service.notifyNewMessage({ message: msg(), ...baseParams });
    const [userIds] = provider.pushToUsers.mock.calls[0];
    expect(userIds).not.toContain('u-sender');
    expect(userIds).toEqual(['u-a', 'u-b']);
  });

  it('传了 extra：带上 conversation_id / message_id / type', async () => {
    const { service, provider } = buildService({ onlineUserIds: [] });
    await service.notifyNewMessage({ message: msg(), ...baseParams });
    const [, payload] = provider.pushToUsers.mock.calls[0];
    expect(payload.conversationId).toBe('c-1');
    expect(payload.extra).toMatchObject({ message_id: 'm-1', type: 'text' });
  });
});

describe('PushService · 开关与容错', () => {
  it('JPUSH_ENABLED=false（provider.enabled=false）→ 不发请求', async () => {
    const { service, provider } = buildService({ enabled: false });
    await service.notifyNewMessage({ message: msg(), ...baseParams });
    expect(provider.pushToUsers).not.toHaveBeenCalled();
  });

  it('推送抛错 → notifyNewMessage 不抛（不影响发消息）', async () => {
    const { service, provider } = buildService({ onlineUserIds: [] });
    provider.pushToUsers.mockRejectedValueOnce(new Error('network down'));
    await expect(service.notifyNewMessage({ message: msg(), ...baseParams })).resolves.toBeUndefined();
  });

  it('成员列表为空 → 不发请求', async () => {
    const { service, provider } = buildService({ onlineUserIds: [] });
    await service.notifyNewMessage({ message: msg(), memberIds: ['u-sender'], senderId: 'u-sender' });
    expect(provider.pushToUsers).not.toHaveBeenCalled();
  });
});

describe('JpushProvider · 请求构造与容错', () => {
  const env = { ...process.env };
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env = { ...env };
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function withEnv() {
    process.env.JPUSH_ENABLED = 'true';
    process.env.JPUSH_APP_KEY = 'test-key';
    process.env.JPUSH_MASTER_SECRET = 'test-secret';
    process.env.JPUSH_CHANNEL_ID = 'messages';
    process.env.JPUSH_TTL_SECONDS = '120';
  }

  it('enabled：三个条件缺一不可', () => {
    const p = new JpushProvider();
    process.env.JPUSH_ENABLED = 'false';
    process.env.JPUSH_APP_KEY = 'k';
    process.env.JPUSH_MASTER_SECRET = 's';
    expect(p.enabled).toBe(false);

    process.env.JPUSH_ENABLED = 'true';
    delete process.env.JPUSH_APP_KEY;
    expect(p.enabled).toBe(false);

    withEnv();
    expect(p.enabled).toBe(true);
  });

  it('payload：platform/alias/channel_id/extras/TTL 正确', async () => {
    withEnv();
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"sendno":"0","msg_id":"123"}',
    }));
    globalThis.fetch = fetchMock as any;

    const p = new JpushProvider();
    const ok = await p.pushToUsers(['u-1', 'u-2'], {
      title: '产品评审群',
      alert: '你有一条阅后即焚消息',
      conversationId: 'c-9',
      extra: { message_id: 'm-9' },
    });

    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as any;
    const body = JSON.parse(init.body);
    expect(body.platform).toEqual(['android']);
    expect(body.audience.alias).toEqual(['u-1', 'u-2']);
    expect(body.notification.android.channel_id).toBe('messages');
    expect(body.notification.android.extras).toMatchObject({
      conversation_id: 'c-9',
      message_id: 'm-9',
    });
    expect(body.options.time_to_live).toBe(120);
    // 未配 JPUSH_SMALL_ICON 时不应出现该字段
    expect(body.notification.android.small_icon).toBeUndefined();
    // Basic Auth 头存在
    expect((init.headers as any).Authorization).toMatch(/^Basic /);
  });

  it('payload：配置 JPUSH_SMALL_ICON 后带上 small_icon', async () => {
    withEnv();
    process.env.JPUSH_SMALL_ICON = 'ic_stat_notify';
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"sendno":"0","msg_id":"1"}',
    }));
    globalThis.fetch = fetchMock as any;

    const p = new JpushProvider();
    await p.pushToUsers(['u-1'], { title: 't', alert: 'a', conversationId: 'c' });

    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(body.notification.android.small_icon).toBe('ic_stat_notify');
  });

  it('非 2xx → 返回 false，不抛错', async () => {
    withEnv();
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"code":1004}}',
    })) as any;

    const p = new JpushProvider();
    await expect(
      p.pushToUsers(['u-1'], { title: 't', alert: 'a', conversationId: 'c' }),
    ).resolves.toBe(false);
  });

  it('fetch 抛错 → 返回 false，不抛错', async () => {
    withEnv();
    globalThis.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    const p = new JpushProvider();
    await expect(
      p.pushToUsers(['u-1'], { title: 't', alert: 'a', conversationId: 'c' }),
    ).resolves.toBe(false);
  });

  it('userId 列表为空 → 不发请求', async () => {
    withEnv();
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as any;
    const p = new JpushProvider();
    await expect(p.pushToUsers([], { title: 't', alert: 'a', conversationId: 'c' })).resolves.toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

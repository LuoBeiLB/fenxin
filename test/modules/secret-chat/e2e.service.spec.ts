import { BadRequestException, ConflictException, ForbiddenException, GoneException } from '@nestjs/common';
import { E2eService, E2E_STATE } from 'src/modules/e2e/e2e.service';
import { Conversation } from 'src/entities/conversation.entity';
import { ConversationMember } from 'src/entities/conversation-member.entity';
import { Message } from 'src/entities/message.entity';
import { MessageReceipt } from 'src/entities/message-receipt.entity';
import { MessageTombstone } from 'src/entities/message-tombstone.entity';
import { BurnSetting } from 'src/entities/burn-setting.entity';
import { AppUser } from 'src/entities/app-user.entity';
import { Device } from 'src/entities/device.entity';

/**
 * 设备配对私密会话（V6.2）。
 *
 * 覆盖：
 *  - 发起：不能对自己 / 无共同会话 / 已有 pending 冲突 / 成功建 pending + 推给目标全部设备
 *  - 接受：非成员 403 / 状态非法 409 / 过期 410 且删行 / 成功绑定当前设备 + 推两台设备
 *  - 拒绝：发起方不能拒绝 / 成功删行 + 通知发起设备
 *  - 关闭：不存在时幂等 / 非绑定设备 403 / 成功**物理删除**全部数据 + 推两台设备
 *  - 设备下线联动 / pending 过期清理
 *
 * 不接 DB：用替身 repository + 假事务，验证服务层分支与"删除顺序"。
 */

type QbResult = { one?: any; many?: any[]; rawMany?: any[]; count?: number; execute?: any };

function qb(result: QbResult = {}) {
  const self: any = {
    select: () => self,
    addSelect: () => self,
    where: () => self,
    andWhere: () => self,
    innerJoin: () => self,
    orderBy: () => self,
    addOrderBy: () => self,
    limit: () => self,
    take: () => self,
    skip: () => self,
    getOne: jest.fn(async () => result.one ?? null),
    getMany: jest.fn(async () => result.many ?? []),
    getRawMany: jest.fn(async () => result.rawMany ?? []),
    getCount: jest.fn(async () => result.count ?? 0),
    delete: () => self,
    from: () => self,
    execute: jest.fn(async () => result.execute ?? { affected: 0 }),
  };
  return self;
}

const USER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const DEV_A = 'device-a';
const DEV_B = 'device-b';
const CONV = 'conv-1';

/**
 * @param opts.conversations 按调用顺序返回的会话行（findOne 用第一个，可空）
 * @param opts.convQbResults createQueryBuilder('c') 依次返回的结果
 */
function makeService(opts: {
  conversation?: any;
  convQbs?: QbResult[];
  msgQbs?: QbResult[];
  deviceQbs?: QbResult[];
  relQb?: QbResult;
  existingPair?: any;
  transactionImpl?: (m: any) => Promise<any>;
  /** V6.2.1：listMine / 409 / 僵尸清理用到的设备与用户数据 */
  devices?: any[];
  peers?: any[];
} = {}) {
  const calls: string[] = [];
  const emitted: Array<{ type: string; event: string; targets: any; payload: any }> = [];
  const deleted: Array<{ entity: string; criteria: any }> = [];
  const saved: any[] = [];
  const updated: any[] = [];

  let convQbIdx = 0;
  let msgQbIdx = 0;
  let deviceQbIdx = 0;

  const convRepo: any = {
    findOne: jest.fn(async () => (opts.conversation === undefined ? null : opts.conversation)),
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (v: any) => {
      saved.push(v);
      return { id: CONV, ...v };
    }),
    createQueryBuilder: jest.fn(() => {
      // findActiveOrPending 也要经过 createQueryBuilder
      const next = opts.convQbs?.[convQbIdx];
      convQbIdx += 1;
      if (next) return qb(next);
      return qb({ one: opts.existingPair ?? null, many: [] });
    }),
    update: jest.fn(async (id: any, patch: any) => {
      updated.push({ id, patch });
      return { affected: 1 };
    }),
    delete: jest.fn(async (criteria: any) => {
      deleted.push({ entity: 'Conversation', criteria });
      return { affected: 1 };
    }),
  };

  const memberRepo: any = {
    findOne: jest.fn(async () => (opts.relQb?.one === undefined ? { id: 'cm' } : opts.relQb.one)),
    createQueryBuilder: jest.fn(() => qb(opts.relQb ?? { one: { id: 'cm' } })),
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (rows: any) => {
      saved.push(...(Array.isArray(rows) ? rows : [rows]));
      return rows;
    }),
    delete: jest.fn(async (criteria: any) => {
      deleted.push({ entity: 'ConversationMember', criteria });
      return { affected: 2 };
    }),
  };

  const messageRepo: any = {
    createQueryBuilder: jest.fn(() => {
      const next = opts.msgQbs?.[msgQbIdx];
      msgQbIdx += 1;
      return qb(next ?? { many: [] });
    }),
    delete: jest.fn(async (criteria: any) => {
      deleted.push({ entity: 'Message', criteria });
      return { affected: 3 };
    }),
  };

  const receiptRepo: any = {
    delete: jest.fn(async (criteria: any) => {
      deleted.push({ entity: 'MessageReceipt', criteria });
      return { affected: 3 };
    }),
  };

  const tombstoneRepo: any = {
    delete: jest.fn(async (criteria: any) => {
      deleted.push({ entity: 'MessageTombstone', criteria });
      return { affected: 1 };
    }),
  };

  const burnSettingRepo: any = {
    createQueryBuilder: jest.fn(() => qb({ execute: { affected: 0 } })),
  };

  const userRepo: any = {
    findOne: jest.fn(async () => ({ id: USER_B, display_name: 'Bob' })),
    find: jest.fn(async () => opts.peers ?? []),
  };

  const deviceRepo: any = {
    createQueryBuilder: jest.fn(() => {
      const next = opts.deviceQbs?.[deviceQbIdx];
      deviceQbIdx += 1;
      return qb(next ?? { many: [] });
    }),
    find: jest.fn(async () => opts.devices ?? []),
    findOne: jest.fn(
      async ({ where }: any) => (opts.devices ?? []).find((d: any) => d.id === where.id) ?? null,
    ),
  };

  const manager: any = {
    getRepository: (entity: any) => {
      const name = entity?.name;
      if (name === 'Conversation') return convRepo;
      if (name === 'ConversationMember') return memberRepo;
      if (name === 'Message') return messageRepo;
      if (name === 'MessageReceipt') return receiptRepo;
      if (name === 'MessageTombstone') return tombstoneRepo;
      if (name === 'BurnSetting') return burnSettingRepo;
      return {};
    },
  };

  const dataSource: any = {
    getRepository: (entity: any) => {
      const name = entity?.name;
      if (name === 'Conversation') return convRepo;
      if (name === 'ConversationMember') return memberRepo;
      if (name === 'Message') return messageRepo;
      if (name === 'MessageReceipt') return receiptRepo;
      if (name === 'MessageTombstone') return tombstoneRepo;
      if (name === 'BurnSetting') return burnSettingRepo;
      if (name === 'AppUser') return userRepo;
      if (name === 'Device') return deviceRepo;
      return {};
    },
    transaction: jest.fn(async (cb: any) => {
      calls.push('transaction');
      if (opts.transactionImpl) return opts.transactionImpl(manager);
      return cb(manager);
    }),
  };

  const events: any = {
    emitToUsers: jest.fn((event: string, targets: any, payload: any) => {
      emitted.push({ type: 'users', event, targets, payload });
    }),
    emitToDevices: jest.fn((event: string, targets: any, payload: any) => {
      emitted.push({ type: 'devices', event, targets, payload });
    }),
  };

  const oss: any = { deleteByUrl: jest.fn(async () => true) };

  const service = new E2eService(dataSource, events, oss);
  return { service, dataSource, events, oss, emitted, deleted, saved, updated, calls };
}

const activeConv = (over: any = {}) => ({
  id: CONV,
  type: 'private',
  e2e_mode: 1,
  e2e_state: E2E_STATE.ACTIVE,
  user_a: USER_A,
  user_b: USER_B,
  e2e_device_a: DEV_A,
  e2e_device_b: DEV_B,
  created_at: new Date(),
  ...over,
});

const pendingConv = (over: any = {}) =>
  activeConv({ e2e_state: E2E_STATE.PENDING, e2e_device_b: null, ...over });

describe('E2eService · 发起私密聊天', () => {
  it('对自己发起 → 400', async () => {
    const { service } = makeService();
    await expect(service.requestSecretChat(USER_A, DEV_A, USER_A)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('无共同会话 → 403', async () => {
    const { service } = makeService({ relQb: { one: null } });
    await expect(service.requestSecretChat(USER_A, DEV_A, USER_B)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('已有 pending → 409 且带上已有 conversation_id', async () => {
    const { service } = makeService({
      relQb: { one: { id: 'cm' } },
      existingPair: {
        id: 'old-conv',
        e2e_state: E2E_STATE.PENDING,
      },
    });
    await expect(service.requestSecretChat(USER_A, DEV_A, USER_B)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'E2E_PAIR_EXISTS', conversation_id: 'old-conv' }),
    });
  });

  it('成功 → 建 pending 会话并推给目标用户的全部设备', async () => {
    const { service, emitted, saved } = makeService({
      relQb: { one: { id: 'cm' } },
      existingPair: null,
    });
    const r = await service.requestSecretChat(USER_A, DEV_A, USER_B);
    expect(r.e2e_state).toBe(E2E_STATE.PENDING);
    expect(saved.filter((m) => m.conversation_id)).toHaveLength(2); // 两条成员
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'users', event: 'e2e:requested' });
    expect(emitted[0].targets).toEqual([USER_B]);
  });
});

describe('E2eService · 接受', () => {
  it('会话不存在 → 404 E2E_SESSION_GONE（不能是 500）', async () => {
    const { service } = makeService({ conversation: null });
    await expect(service.acceptSecretChat('not-exist', USER_B, DEV_B)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: 'E2E_SESSION_GONE' }),
    });
  });

  it('非成员 → 403', async () => {
    const { service } = makeService({ conversation: pendingConv() });
    await expect(service.acceptSecretChat(CONV, 'stranger', DEV_B)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('状态不是 pending → 409', async () => {
    const { service } = makeService({ conversation: activeConv() });
    await expect(service.acceptSecretChat(CONV, USER_B, DEV_B)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('已过期 → 410 且删行', async () => {
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const { service, deleted } = makeService({
      conversation: pendingConv({ created_at: old }),
    });
    await expect(service.acceptSecretChat(CONV, USER_B, DEV_B)).rejects.toBeInstanceOf(GoneException);
    expect(deleted.some((d) => d.entity === 'Conversation')).toBe(true);
  });

  it('成功 → 绑定当前设备，并推给两台绑定设备', async () => {
    const { service, emitted, updated } = makeService({ conversation: pendingConv() });
    const r = await service.acceptSecretChat(CONV, USER_B, DEV_B);
    expect(r).toMatchObject({
      e2e_state: E2E_STATE.ACTIVE,
      bound_device_id: DEV_B,
      peer_device_id: DEV_A,
    });
    expect(updated[0].patch).toMatchObject({ e2e_state: E2E_STATE.ACTIVE, e2e_device_b: DEV_B });
    const accepted = emitted.find((e) => e.event === 'e2e:accepted');
    expect(accepted?.targets).toEqual([DEV_A, DEV_B]);
  });
});

describe('E2eService · 拒绝', () => {
  it('会话不存在 → 404 E2E_SESSION_GONE（不能是 500）', async () => {
    const { service } = makeService({ conversation: null });
    await expect(service.rejectSecretChat('not-exist', USER_B, DEV_B)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: 'E2E_SESSION_GONE' }),
    });
  });

  it('发起方不能"拒绝"（应撤回）→ 400', async () => {
    const { service } = makeService({ conversation: pendingConv() });
    await expect(service.rejectSecretChat(CONV, USER_A, DEV_A)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('被邀请方拒绝 → 删除会话并通知发起设备', async () => {
    const { service, emitted, deleted } = makeService({ conversation: pendingConv() });
    const r = await service.rejectSecretChat(CONV, USER_B, DEV_B);
    expect(r.deleted).toBe(true);
    expect(deleted.some((d) => d.entity === 'Conversation')).toBe(true);
    const ev = emitted.find((e) => e.event === 'e2e:rejected');
    expect(ev?.targets).toEqual([DEV_A]);
  });
});

describe('E2eService · 关闭（物理删除）', () => {
  it('会话已不存在 → 幂等成功，不报错', async () => {
    const { service, dataSource } = makeService({ conversation: null });
    const r = await service.closeSecretChat(CONV, USER_A, DEV_A);
    expect(r).toMatchObject({ deleted: true, deleted_messages: 0 });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('V6.2.1：同一用户的「非绑定设备」也能结束自己名下的会话（解开换设备死锁）', async () => {
    const { service, deleted } = makeService({
      conversation: activeConv(),
      msgQbs: [{ many: [] }],
    });
    const r = await service.closeSecretChat(CONV, USER_A, 'new-device-after-relogin', 'user');
    expect(r.deleted).toBe(true);
    expect(deleted.some((d) => d.entity === 'Conversation')).toBe(true);
  });

  it('非参与者的设备 → 403', async () => {
    const { service } = makeService({ conversation: activeConv() });
    await expect(
      service.closeSecretChat(CONV, 'stranger-user', 'stranger-device', 'user'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('成功 → 删消息/回执/墓碑/成员/会话，并推 closed 给两台设备', async () => {
    const { service, deleted, emitted, oss } = makeService({
      conversation: activeConv(),
      msgQbs: [{ many: [{ id: 'm-1', file_url: 'https://oss/a.jpg', file_original_url: null }] }],
    });
    const r = await service.closeSecretChat(CONV, USER_A, DEV_A, 'user');

    expect(r.deleted).toBe(true);
    expect(r.deleted_messages).toBe(3); // mock 的 Message.delete 返回 affected=3
    // 附件先删
    expect(oss.deleteByUrl).toHaveBeenCalledWith('https://oss/a.jpg');
    // 五类数据都被删
    const entities = deleted.map((d) => d.entity);
    expect(entities).toEqual(
      expect.arrayContaining([
        'MessageReceipt',
        'MessageTombstone',
        'Message',
        'ConversationMember',
        'Conversation',
      ]),
    );
    const ev = emitted.find((e) => e.event === 'e2e:closed');
    expect(ev?.targets).toEqual([DEV_A, DEV_B]);
    expect(ev?.payload.trigger).toBe('user');
  });

  it('pending 撤回 → 推 e2e:request_gone（不是 closed）', async () => {
    const { service, emitted } = makeService({
      conversation: pendingConv(),
      msgQbs: [{ many: [] }],
    });
    await service.closeSecretChat(CONV, USER_A, DEV_A, 'user');
    const ev = emitted.find((e) => e.event === 'e2e:request_gone');
    expect(ev?.payload.reason).toBe('cancelled');
  });
});

describe('E2eService · 设备下线联动 / 过期清理', () => {
  it('设备被移除 → 关闭它绑定的所有私密会话', async () => {
    const { service, dataSource } = makeService({
      convQbs: [{ many: [{ id: 'conv-1', user_a: USER_A }, { id: 'conv-2', user_a: USER_A }] }],
      conversation: activeConv(),
      msgQbs: [{ many: [] }, { many: [] }],
    });
    const n = await service.closeSecretChatsBoundTo(DEV_B);
    expect(n).toBe(2);
    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
  });

  it('pending 超期 → 定时任务删行', async () => {
    const { service, dataSource } = makeService({
      convQbs: [{ many: [{ id: CONV, user_a: USER_A }] }],
      conversation: pendingConv({ created_at: new Date(Date.now() - 8 * 24 * 3600 * 1000) }),
      msgQbs: [{ many: [] }],
    });
    await service.expirePendingRequests();
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });
});

/* ============ V6.2.1：跨设备治理（B-1 / B-3 / B-7 / B-10） ============ */

describe('E2eService · 跨设备列出（B-1 e2e-mine）', () => {
  const devices = [
    { id: DEV_A, device_name: '电脑A', is_online: false, last_active_at: new Date('2026-10-30T00:00:00Z') },
    { id: DEV_B, device_name: '手机B', is_online: true, last_active_at: new Date('2026-11-04T00:00:00Z') },
  ];
  const peers = [
    { id: USER_B, display_name: '张三' },
    { id: USER_A, display_name: '我' },
  ];

  it('列出我名下 active 会话：带对方昵称、绑定设备名与在线态', async () => {
    const { service } = makeService({
      convQbs: [{ many: [activeConv()] }],
      devices,
      peers,
    });
    const list = await service.listMine(USER_A, { deviceId: DEV_A });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      conversation_id: CONV,
      state: 'active',
      peer_name: '张三',
      bound_device_id: DEV_A,
      bound_device_name: '电脑A',
      bound_device_online: false,
      is_bound_device: true,
      peer_device_id: DEV_B,
    });
    expect(list[0].bound_device_last_seen_at).toEqual(devices[0].last_active_at);
  });

  it('bound_device=other：只返回绑在「其它设备」的会话', async () => {
    const { service } = makeService({
      // 两台会话：一条绑 DEV_A（当前），一条绑 DEV_X（旧设备）
      convQbs: [
        {
          many: [
            activeConv(),
            activeConv({ id: 'conv-old', e2e_device_a: 'dev-old', e2e_device_b: DEV_B }),
          ],
        },
      ],
      devices: [...devices, { id: 'dev-old', device_name: 'Chrome', is_online: false, last_active_at: new Date() }],
      peers,
    });

    const list = await service.listMine(USER_A, { deviceId: DEV_A, boundDevice: 'other' });
    expect(list).toHaveLength(1);
    expect(list[0].conversation_id).toBe('conv-old');
    expect(list[0].bound_device_name).toBe('Chrome');
    expect(list[0].is_bound_device).toBe(false);
  });

  it('bound_device=this：只返回绑在当前设备上的', async () => {
    const { service } = makeService({
      convQbs: [
        {
          many: [
            activeConv(),
            activeConv({ id: 'conv-old', e2e_device_a: 'dev-old', e2e_device_b: DEV_B }),
          ],
        },
      ],
      devices,
      peers,
    });
    const list = await service.listMine(USER_A, { deviceId: DEV_A, boundDevice: 'this' });
    expect(list.map((x) => x.conversation_id)).toEqual([CONV]);
  });

  it('pending 会话：带 expires_at，绑定设备为发起设备', async () => {
    const { service } = makeService({ convQbs: [{ many: [pendingConv()] }], devices, peers });
    const [item] = await service.listMine(USER_A, { deviceId: DEV_A });
    expect(item.state).toBe('pending');
    expect(item.expires_at).toBeTruthy();
    expect(item.bound_device_id).toBe(DEV_A);
  });

  it('没有会话 → 返回空数组', async () => {
    const { service } = makeService({ convQbs: [{ many: [] }] });
    await expect(service.listMine(USER_A)).resolves.toEqual([]);
  });
});

describe('E2eService · 批量结束（B-3 e2e-close-all）', () => {
  it('结束全部：返回 closed 数量与 id 列表', async () => {
    const { service } = makeService({
      convQbs: [
        { many: [activeConv(), pendingConv({ id: 'conv-2' })] },
      ],
      conversation: activeConv(),
      msgQbs: [{ many: [] }, { many: [] }],
    });
    const r = await service.closeAll(USER_A, DEV_A, 'logout');
    expect(r.closed).toBe(2);
    expect(r.conversation_ids).toEqual([CONV, 'conv-2']);
  });

  it('onlyOtherDevices：只关绑在其它设备上的（不动当前设备的）', async () => {
    const { service } = makeService({
      convQbs: [
        {
          many: [
            activeConv(),
            activeConv({ id: 'conv-old', e2e_device_a: 'dev-old', e2e_device_b: DEV_B }),
          ],
        },
      ],
      conversation: activeConv({ id: 'conv-old', e2e_device_a: 'dev-old', e2e_device_b: DEV_B }),
      devices: [{ id: 'dev-old', device_name: 'Chrome', is_online: false, last_active_at: new Date() }],
      peers: [{ id: USER_B, display_name: '张三' }],
      msgQbs: [{ many: [] }],
    });
    const r = await service.closeAll(USER_A, DEV_A, 'device_change', { onlyOtherDevices: true });
    expect(r.conversation_ids).toEqual(['conv-old']);
  });
});

describe('E2eService · 僵尸会话清理（B-10）', () => {
  it('绑定设备记录已删除 → 自动结束（reason=device_gone）', async () => {
    const { service, emitted } = makeService({
      convQbs: [{ many: [activeConv()] }],
      conversation: activeConv(),
      devices: [], // 两台绑定设备都查不到
      msgQbs: [{ many: [] }],
    });
    await service.closeGoneDeviceChats();
    const ev = emitted.find((e) => e.event === 'e2e:closed');
    expect(ev?.payload.trigger).toBe('device_gone');
  });

  it('绑定设备 8 天未上线 → 自动结束', async () => {
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const { service, dataSource } = makeService({
      convQbs: [{ many: [activeConv()] }],
      conversation: activeConv(),
      devices: [
        { id: DEV_A, device_name: '电脑A', is_online: false, last_active_at: old },
        { id: DEV_B, device_name: '手机B', is_online: true, last_active_at: new Date() },
      ],
      msgQbs: [{ many: [] }],
    });
    await service.closeGoneDeviceChats();
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('绑定设备最近活跃 → 不动', async () => {
    const { service, dataSource } = makeService({
      convQbs: [{ many: [activeConv()] }],
      devices: [
        { id: DEV_A, device_name: '电脑A', is_online: true, last_active_at: new Date() },
        { id: DEV_B, device_name: '手机B', is_online: true, last_active_at: new Date() },
      ],
    });
    await service.closeGoneDeviceChats();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});

describe('E2eService · 409 撞车时返回绑定设备信息（B-7）', () => {
  it('已有 active 会话 → 409 带 bound_device_name / online / last_seen', async () => {
    const lastSeen = new Date('2026-11-01T00:00:00Z');
    const { service } = makeService({
      relQb: { one: { id: 'cm' } },
      existingPair: {
        id: 'old-conv',
        e2e_state: 2,
        user_a: USER_A,
        user_b: USER_B,
        e2e_device_a: DEV_A,
        e2e_device_b: DEV_B,
      },
      devices: [{ id: DEV_A, device_name: '电脑A', is_online: false, last_active_at: lastSeen }],
    });

    await expect(service.requestSecretChat(USER_A, 'dev-new', USER_B)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'E2E_PAIR_EXISTS',
        conversation_id: 'old-conv',
        bound_device_id: DEV_A,
        bound_device_name: '电脑A',
        bound_device_online: false,
        bound_device_last_seen_at: lastSeen,
      }),
    });
  });
});


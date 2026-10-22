import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BurnSettingService } from 'src/modules/burn-setting/burn-setting.service';
import { BurnSetting } from 'src/entities/burn-setting.entity';
import { AppUser } from 'src/entities/app-user.entity';
import { Conversation } from 'src/entities/conversation.entity';
import { ConversationMember } from 'src/entities/conversation-member.entity';

/**
 * 焚毁时长设置（V6.1「按人设置」）单测。
 *
 * 归属规则是「**看谁发的消息**」（发送方生效）：
 *   - A 给 B 设 5 秒  → 只约束 A→B 的消息
 *   - B 给 A 设 1 小时 → 只约束 B→A 的消息
 * 两个方向互不干扰，所以**不存在取较短**；对方对我的设置不影响我发出的消息。
 *
 * 覆盖：
 *  - 私聊：我设了 → contact_setting；没设 → 全局默认 → none
 *  - 私聊：只有对方设了 → 仍然走我的全局默认/none（不受对方影响）
 *  - 群聊：会话设置 → 全局默认 → none
 *  - 写入校验：给自己设 → 400；目标不存在 → 404；私聊用会话级 → 400；非成员 → 403
 */

type SettingRow = { ttl_seconds: number; updated_at: Date };

function makeService(opts: {
  conv?: any;
  member?: any;
  counterpart?: any;
  settings?: Record<string, SettingRow | null>; // key: `${owner}:${scopeType}:${scopeId}`
  globalDefault?: number | null;
  targetUser?: any;
}) {
  const settingTable = opts.settings ?? {};

  const qb = (kind: string) => {
    const q: any = {};
    const state: any = { kind, params: {} };
    ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'offset', 'limit', 'leftJoin', 'groupBy'].forEach(
      (m) => {
        q[m] = jest.fn((...args: any[]) => {
          if (m === 'where' || m === 'andWhere') {
            const [sql, params] = args;
            Object.assign(state.params, params ?? {});
            state.sql = (state.sql ?? '') + ' ' + sql;
          }
          return q;
        });
      },
    );
    q.getOne = jest.fn(async () => {
      if (kind === 'setting') {
        const key = `${state.params.ownerId}:${state.params.scopeType}:${state.params.scopeId}`;
        const v = settingTable[key];
        return v ? ({ id: `bs-${key}`, ...v } as any) : null;
      }
      return null;
    });
    q.getRawOne = jest.fn(async () => {
      if (kind === 'global') {
        return { default_burn_ttl_seconds: opts.globalDefault ?? null };
      }
      if (kind === 'counterpart') return opts.counterpart ?? null;
      return null;
    });
    q.getRawMany = jest.fn(async () => []);
    q.getCount = jest.fn(async () => 0);
    return q;
  };

  const repos: Record<string, any> = {
    BurnSetting: {
      createQueryBuilder: () => qb('setting'),
      delete: jest.fn(async () => ({ affected: 1 })),
      update: jest.fn(async () => ({ affected: 1 })),
      create: (x: any) => x,
      save: jest.fn(async (x: any) => x),
    },
    AppUser: { createQueryBuilder: () => qb('global'), findOne: jest.fn(async () => opts.targetUser ?? null) },
    Conversation: { findOne: jest.fn(async () => opts.conv ?? null) },
    ConversationMember: {
      findOne: jest.fn(async () => (opts.member === undefined ? { user_id: 'me' } : opts.member)),
      createQueryBuilder: () => qb('counterpart'),
    },
  };

  const dataSource: any = { getRepository: (e: any) => repos[e?.name] ?? {} };
  return { service: new BurnSettingService(dataSource as DataSource), repos };
}

const privateConv = { id: 'conv-p', type: 'private' };
const groupConv = { id: 'conv-g', type: 'group' };

describe('BurnSettingService · 解析优先级（发送方生效）', () => {
  it('私聊：我设了 3600 → contact_setting', async () => {
    const { service } = makeService({
      conv: privateConv,
      counterpart: { user_id: 'peer', display_name: '张三' },
      settings: { 'me:user:peer': { ttl_seconds: 3600, updated_at: new Date() } },
      globalDefault: 300,
    });
    const r = await service.resolveForConversation('me', 'conv-p');
    expect(r.effective_ttl_seconds).toBe(3600);
    expect(r.source).toBe('contact_setting');
    expect(r.counterpart).toEqual({ user_id: 'peer', display_name: '张三' });
  });

  it('私聊：对方给我设了 300，但我没设 → 不影响我发出的消息（仍走我的全局默认）', async () => {
    const { service } = makeService({
      conv: privateConv,
      counterpart: { user_id: 'peer', display_name: '张三' },
      settings: { 'peer:user:me': { ttl_seconds: 300, updated_at: new Date() } },
      globalDefault: 3600,
    });
    const r = await service.resolveForConversation('me', 'conv-p');
    // 关键：对方的设置约束的是「对方发出的消息」，不是我的
    expect(r.effective_ttl_seconds).toBe(3600);
    expect(r.source).toBe('global_default');
  });

  it('私聊：双方都设了 → 各管各的方向，我的值原样生效（不取 min）', async () => {
    const { service } = makeService({
      conv: privateConv,
      counterpart: { user_id: 'peer', display_name: '张三' },
      settings: {
        'me:user:peer': { ttl_seconds: 3600, updated_at: new Date() },
        'peer:user:me': { ttl_seconds: 5, updated_at: new Date() },
      },
    });
    const r = await service.resolveForConversation('me', 'conv-p');
    expect(r.effective_ttl_seconds).toBe(3600);
    expect(r.source).toBe('contact_setting');
    expect(r.my_setting?.ttl_seconds).toBe(3600);
    // 响应里不再有 counterpart_setting（对方的设置与本方向无关）
    expect(r).not.toHaveProperty('counterpart_setting');
  });

  it('私聊：都没设 → 回落全局默认', async () => {
    const { service } = makeService({
      conv: privateConv,
      counterpart: { user_id: 'peer', display_name: '张三' },
      globalDefault: 600,
    });
    const r = await service.resolveForConversation('me', 'conv-p');
    expect(r.effective_ttl_seconds).toBe(600);
    expect(r.source).toBe('global_default');
  });

  it('私聊：都没有 → none（不焚毁）', async () => {
    const { service } = makeService({
      conv: privateConv,
      counterpart: { user_id: 'peer', display_name: '张三' },
      globalDefault: null,
    });
    const r = await service.resolveForConversation('me', 'conv-p');
    expect(r.effective_ttl_seconds).toBeNull();
    expect(r.source).toBe('none');
  });

  it('群聊：会话级设置优先于全局默认', async () => {
    const { service } = makeService({
      conv: groupConv,
      settings: { 'me:conversation:conv-g': { ttl_seconds: 1800, updated_at: new Date() } },
      globalDefault: 300,
    });
    const r = await service.resolveForConversation('me', 'conv-g');
    expect(r.effective_ttl_seconds).toBe(1800);
    expect(r.source).toBe('conversation_setting');
    expect(r.counterpart).toBeNull();
  });

  it('群聊：没设 → 全局默认', async () => {
    const { service } = makeService({ conv: groupConv, globalDefault: 300 });
    const r = await service.resolveForConversation('me', 'conv-g');
    expect(r.source).toBe('global_default');
    expect(r.effective_ttl_seconds).toBe(300);
  });

  it('非成员 → 403', async () => {
    const { service } = makeService({ conv: privateConv, member: null });
    await expect(service.resolveForConversation('me', 'conv-p')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('会话不存在 → 404', async () => {
    const { service } = makeService({ conv: null });
    await expect(service.resolveForConversation('me', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('BurnSettingService · 写入校验', () => {
  it('给自己设置 → 400', async () => {
    const { service } = makeService({});
    await expect(service.setForUser('me', 'me', 60)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('目标用户不存在 → 404', async () => {
    const { service } = makeService({ targetUser: null });
    await expect(service.setForUser('me', 'ghost', 60)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('时长越界 → 400', async () => {
    const { service } = makeService({ targetUser: { id: 'peer', deleted_at: null } });
    await expect(service.setForUser('me', 'peer', 0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setForUser('me', 'peer', 2592001)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('私聊不允许用会话级设置 → 400（提示改用按人设置）', async () => {
    const { service } = makeService({ conv: privateConv });
    await expect(service.setForConversation('me', 'conv-p', 60)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('清除设置：幂等，返回 ttl=null', async () => {
    const { service } = makeService({});
    const r = await service.clearForUser('me', 'peer');
    expect(r).toMatchObject({ success: true, ttl_seconds: null, scope_type: 'user' });
  });
});

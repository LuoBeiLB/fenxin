import { KeysService } from 'src/modules/keys/keys.service';
import { UserKey } from 'src/entities/user-key.entity';
import { ConversationMember } from 'src/entities/conversation-member.entity';

/**
 * 验证"公钥上传 / 查询 / TOFU 批量比对 / 轮换广播"链路。
 *
 * 覆盖 10 个关键路径：
 *   1. uploadIdentityKey 首次上传 → updated=true，不广播（无人有旧公钥可比对）
 *   2. uploadIdentityKey 相同公钥幂等 → updated=false
 *   3. uploadIdentityKey 覆盖更新（不同公钥） → updated=true
 *   3b. 覆盖更新且有共同会话用户 → 广播 key:changed 给共同会话用户（TOFU）
 *   4. getIdentityKey 拿自己公钥 → 跳过权限校验
 *   5. getIdentityKey 同 conversation 成员 → 返回公钥
 *   6. getIdentityKey 非成员 → 抛 ForbiddenException
 *   7. getIdentityKey 对方未上传公钥 → 抛 NotFoundException
 *   8. getIdentityKeysBatch 批量查询 → 一条 SQL 返回映射结果（TOFU 比对）
 *   9. hasKey 有/无公钥
 *
 * 不接 DB：用 jest.fn 替身 repository 撑过去，目的就是验证服务层分支逻辑。
 * 权限过滤（共同会话 EXISTS 子查询）在 SQL 里，由真实库集成验证。
 */
describe('KeysService（V4.0 §E2E 公钥服务 + TOFU）', () => {
  let svc: KeysService;
  let dataSource: any;
  const events: any = { emitToUsers: jest.fn() };

  // 用 entity 名字路由到对应 mock repo
  // initial: 该 user 已存的 user_keys 行（null = 没上传过）
  // batchKeys: getIdentityKeysBatch 的 getMany 返回值（null = 空结果）
  const makeUserKeyRepo = (
    initial: Partial<UserKey> | null = null,
    batchKeys: any[] | null = null,
  ) => {
    let stored: Partial<UserKey> | null = initial;
    return {
      findOne: jest.fn(async (opts: any) => {
        if (!stored) return null;
        if (opts?.where?.user_id && stored.user_id !== opts.where.user_id) return null;
        return stored;
      }),
      save: jest.fn(async (entity: any) => {
        stored = { ...stored, ...entity };
        return stored;
      }),
      update: jest.fn(async (id: string, patch: any) => {
        if (stored && stored.id === id) stored = { ...stored, ...patch };
        return { affected: 1 };
      }),
      create: jest.fn((data: any) => data),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn(async () => (stored ? 1 : 0)),
        getMany: jest.fn(async () => batchKeys ?? []),
      })),
    };
  };

  // myConvIds: 当前用户所在的 conversationId 列表（getIdentityKey 权限查询用）
  // sharedWith: 给定目标 userId 时，返回的"共同" conversationId 列表（空数组 = 无共同会话）
  // peerUserIds: 与当前用户有共同会话的其他用户（getPeerUserIds → key:changed 广播目标）
  const makeMemberRepo = (
    myConvIds: string[],
    sharedWith: string[] = [],
    peerUserIds: string[] = [],
  ) => {
    return {
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          // 记录 select 的字段，getRawMany 据此分流两种查询（conversation_id / m2.user_id）
          selected: null as string | null,
          select: jest.fn((s: string) => {
            qb.selected = s;
            return qb;
          }),
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getRawMany: jest.fn(async () => {
            if (qb.selected && qb.selected.includes('m2.user_id')) {
              return peerUserIds.map((user_id) => ({ user_id }));
            }
            return myConvIds.map((conversation_id) => ({ conversation_id }));
          }),
          getRawOne: jest.fn(async () => {
            if (sharedWith.length === 0) return undefined;
            return { conversation_id: sharedWith[0] };
          }),
        };
        return qb;
      }),
    };
  };

  const buildDataSource = (userKeyRepo: any, memberRepo: any) => ({
    getRepository: (entity: any) => {
      const name = entity?.name || '';
      if (name === 'UserKey') return userKeyRepo;
      if (name === 'ConversationMember') return memberRepo;
      return {};
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===== uploadIdentityKey =====
  describe('uploadIdentityKey', () => {
    it('首次上传：updated=true，写库，不广播（无人有旧公钥可比对）', async () => {
      const repo = makeUserKeyRepo(null);
      dataSource = buildDataSource(repo, makeMemberRepo([], [], ['u2', 'u3']));
      svc = new KeysService(dataSource, events);

      const res = await svc.uploadIdentityKey('u1', 'PUBKEY_A_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(res).toEqual({ updated: true });
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(events.emitToUsers).not.toHaveBeenCalled();
    });

    it('相同公钥幂等：updated=false，不写库', async () => {
      const sameKey = 'PUBKEY_A_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const repo = makeUserKeyRepo({
        id: 'r1',
        user_id: 'u1',
        identity_pubkey: sameKey,
      } as any);
      dataSource = buildDataSource(repo, makeMemberRepo([]));
      svc = new KeysService(dataSource, events);

      const res = await svc.uploadIdentityKey('u1', sameKey);
      expect(res).toEqual({ updated: false });
      expect(repo.save).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(events.emitToUsers).not.toHaveBeenCalled();
    });

    it('不同公钥覆盖：updated=true，调 update', async () => {
      const repo = makeUserKeyRepo({
        id: 'r1',
        user_id: 'u1',
        identity_pubkey: 'PUBKEY_OLD_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      } as any);
      dataSource = buildDataSource(repo, makeMemberRepo([])); // 无共同会话用户
      svc = new KeysService(dataSource, events);

      const res = await svc.uploadIdentityKey('u1', 'PUBKEY_NEW_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(res).toEqual({ updated: true });
      expect(repo.update).toHaveBeenCalledWith('r1', { identity_pubkey: expect.any(String) });
    });

    it('不同公钥覆盖 + 有共同会话用户：广播 key:changed（TOFU）', async () => {
      const repo = makeUserKeyRepo({
        id: 'r1',
        user_id: 'u1',
        identity_pubkey: 'PUBKEY_OLD_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      } as any);
      const memberRepo = makeMemberRepo(['c1'], [], ['u2', 'u3']); // u1 的共同会话用户
      dataSource = buildDataSource(repo, memberRepo);
      svc = new KeysService(dataSource, events);

      const res = await svc.uploadIdentityKey('u1', 'PUBKEY_NEW_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(res).toEqual({ updated: true });
      expect(events.emitToUsers).toHaveBeenCalledWith(
        'key:changed',
        ['u2', 'u3'],
        expect.objectContaining({ user_id: 'u1', updated_at: expect.any(String) }),
      );
    });
  });

  // ===== getIdentityKey =====
  describe('getIdentityKey', () => {
    it('拿自己公钥：跳过权限校验', async () => {
      const selfKey = {
        id: 'r1',
        user_id: 'u1',
        identity_pubkey: 'PUBKEY_SELF_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
      } as any;
      const repo = makeUserKeyRepo(selfKey);
      const memberRepo = makeMemberRepo([]); // 没有任何会话
      dataSource = buildDataSource(repo, memberRepo);
      svc = new KeysService(dataSource, events);

      const res = await svc.getIdentityKey('u1', 'u1');
      expect(res.user_id).toBe('u1');
      // 拿自己跳权限 → memberRepo 都没被查
      expect(memberRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('拿对方公钥 + 同会话成员：返回公钥', async () => {
      const otherKey = {
        id: 'r2',
        user_id: 'u2',
        identity_pubkey: 'PUBKEY_OTHER_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
      } as any;
      const repo = makeUserKeyRepo(otherKey);
      const memberRepo = makeMemberRepo(['c1', 'c2'], ['c1']); // 跟 u2 有共同会话 c1
      dataSource = buildDataSource(repo, memberRepo);
      svc = new KeysService(dataSource, events);

      const res = await svc.getIdentityKey('u1', 'u2');
      expect(res.user_id).toBe('u2');
      expect(res.identity_pubkey).toBe('PUBKEY_OTHER_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    });

    it('拿对方公钥 + 非成员：抛 ForbiddenException', async () => {
      const repo = makeUserKeyRepo(null);
      const memberRepo = makeMemberRepo(['c1', 'c2'], []); // 无共同会话
      dataSource = buildDataSource(repo, memberRepo);
      svc = new KeysService(dataSource, events);

      await expect(svc.getIdentityKey('u1', 'u2')).rejects.toThrow('对方不在你的会话中');
    });

    it('拿对方公钥 + 对方未上传：抛 NotFoundException', async () => {
      const repo = makeUserKeyRepo(null); // 对方没公钥
      const memberRepo = makeMemberRepo(['c1'], ['c1']); // 关系通过
      dataSource = buildDataSource(repo, memberRepo);
      svc = new KeysService(dataSource, events);

      await expect(svc.getIdentityKey('u1', 'u2')).rejects.toThrow('对方尚未上传公钥');
    });
  });

  // ===== getIdentityKeysBatch（TOFU 批量比对）=====
  describe('getIdentityKeysBatch', () => {
    it('一条 SQL 批量返回，结果字段映射正确', async () => {
      const batchKeys = [
        {
          user_id: 'u1',
          identity_pubkey: 'PUBKEY_SELF_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          created_at: new Date('2026-01-01'),
          updated_at: new Date('2026-01-01'),
        },
        {
          user_id: 'u2',
          identity_pubkey: 'PUBKEY_OTHER_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          created_at: new Date('2026-01-01'),
          updated_at: new Date('2026-01-02'),
        },
      ];
      const repo = makeUserKeyRepo(null, batchKeys);
      dataSource = buildDataSource(repo, makeMemberRepo(['c1']));
      svc = new KeysService(dataSource, events);

      const res = await svc.getIdentityKeysBatch('u1', ['u1', 'u2', 'u2']);
      expect(res).toHaveLength(2);
      expect(res[0]).toMatchObject({ user_id: 'u1', identity_pubkey: 'PUBKEY_SELF_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
      expect(res[1]).toMatchObject({ user_id: 'u2', updated_at: new Date('2026-01-02') });
      // 批量接口只查一次库（不做逐个 userId 循环查询）
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('无任何结果 → 空数组', async () => {
      const repo = makeUserKeyRepo(null, []);
      dataSource = buildDataSource(repo, makeMemberRepo([]));
      svc = new KeysService(dataSource, events);

      const res = await svc.getIdentityKeysBatch('u1', ['u2']);
      expect(res).toEqual([]);
    });
  });

  // ===== hasKey =====
  describe('hasKey', () => {
    it('有公钥 → true', async () => {
      const repo = makeUserKeyRepo({ id: 'r1', user_id: 'u1' } as any);
      dataSource = buildDataSource(repo, makeMemberRepo([]));
      svc = new KeysService(dataSource, events);

      const res = await svc.hasKey('u1');
      expect(res).toBe(true);
    });

    it('无公钥 → false', async () => {
      const repo = makeUserKeyRepo(null);
      dataSource = buildDataSource(repo, makeMemberRepo([]));
      svc = new KeysService(dataSource, events);

      const res = await svc.hasKey('u1');
      expect(res).toBe(false);
    });
  });
});

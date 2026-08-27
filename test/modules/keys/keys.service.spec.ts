import { KeysService } from 'src/modules/keys/keys.service';
import { UserKey } from 'src/entities/user-key.entity';
import { ConversationMember } from 'src/entities/conversation-member.entity';

/**
 * 验证"公钥上传 / 查询"链路。
 *
 * 覆盖 7 个关键路径：
 *   1. uploadIdentityKey 首次上传 → updated=true
 *   2. uploadIdentityKey 相同公钥幂等 → updated=false
 *   3. uploadIdentityKey 覆盖更新（不同公钥） → updated=true
 *   4. getIdentityKey 拿自己公钥 → 跳过权限校验
 *   5. getIdentityKey 同 conversation 成员 → 返回公钥
 *   6. getIdentityKey 非成员 → 抛 ForbiddenException
 *   7. getIdentityKey 对方未上传公钥 → 抛 NotFoundException
 *
 * 不接 DB：用 jest.fn 替身 repository 撑过去，目的就是验证服务层分支逻辑。
 */
describe('KeysService（V4.0 §E2E 公钥服务）', () => {
  let svc: KeysService;
  let dataSource: any;

  // 用 entity 名字路由到对应 mock repo
  const makeUserKeyRepo = (initial: Partial<UserKey> | null = null) => {
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
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn(async () => (stored ? 1 : 0)),
      })),
    };
  };

  const makeMemberRepo = (myConvIds: string[], sharedWith: string[] = []) => {
    // myConvIds: 当前用户所在的 conversationId 列表
    // sharedWith: 给定目标 userId 时，返回的"共同" conversationId 列表（空数组 = 无共同会话）
    return {
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getRawMany: jest.fn(async () =>
            myConvIds.map((conversation_id) => ({ conversation_id })),
          ),
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
    it('首次上传：updated=true，写库', async () => {
      const repo = makeUserKeyRepo(null);
      dataSource = buildDataSource(repo, makeMemberRepo([]));
      svc = new KeysService(dataSource);

      const res = await svc.uploadIdentityKey('u1', 'PUBKEY_A_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(res).toEqual({ updated: true });
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('相同公钥幂等：updated=false，不写库', async () => {
      const sameKey = 'PUBKEY_A_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const repo = makeUserKeyRepo({
        id: 'r1',
        user_id: 'u1',
        identity_pubkey: sameKey,
      } as any);
      dataSource = buildDataSource(repo, makeMemberRepo([]));
      svc = new KeysService(dataSource);

      const res = await svc.uploadIdentityKey('u1', sameKey);
      expect(res).toEqual({ updated: false });
      expect(repo.save).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('不同公钥覆盖：updated=true，调 update', async () => {
      const repo = makeUserKeyRepo({
        id: 'r1',
        user_id: 'u1',
        identity_pubkey: 'PUBKEY_OLD_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      } as any);
      dataSource = buildDataSource(repo, makeMemberRepo([]));
      svc = new KeysService(dataSource);

      const res = await svc.uploadIdentityKey('u1', 'PUBKEY_NEW_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(res).toEqual({ updated: true });
      expect(repo.update).toHaveBeenCalledWith('r1', { identity_pubkey: expect.any(String) });
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
      svc = new KeysService(dataSource);

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
      svc = new KeysService(dataSource);

      const res = await svc.getIdentityKey('u1', 'u2');
      expect(res.user_id).toBe('u2');
      expect(res.identity_pubkey).toBe('PUBKEY_OTHER_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    });

    it('拿对方公钥 + 非成员：抛 ForbiddenException', async () => {
      const repo = makeUserKeyRepo(null);
      const memberRepo = makeMemberRepo(['c1', 'c2'], []); // 无共同会话
      dataSource = buildDataSource(repo, memberRepo);
      svc = new KeysService(dataSource);

      await expect(svc.getIdentityKey('u1', 'u2')).rejects.toThrow('对方不在你的会话中');
    });

    it('拿对方公钥 + 对方未上传：抛 NotFoundException', async () => {
      const repo = makeUserKeyRepo(null); // 对方没公钥
      const memberRepo = makeMemberRepo(['c1'], ['c1']); // 关系通过
      dataSource = buildDataSource(repo, memberRepo);
      svc = new KeysService(dataSource);

      await expect(svc.getIdentityKey('u1', 'u2')).rejects.toThrow('对方尚未上传公钥');
    });
  });

  // ===== hasKey =====
  describe('hasKey', () => {
    it('有公钥 → true', async () => {
      const repo = makeUserKeyRepo({ id: 'r1', user_id: 'u1' } as any);
      dataSource = buildDataSource(repo, makeMemberRepo([]));
      svc = new KeysService(dataSource);

      const res = await svc.hasKey('u1');
      expect(res).toBe(true);
    });

    it('无公钥 → false', async () => {
      const repo = makeUserKeyRepo(null);
      dataSource = buildDataSource(repo, makeMemberRepo([]));
      svc = new KeysService(dataSource);

      const res = await svc.hasKey('u1');
      expect(res).toBe(false);
    });
  });
});

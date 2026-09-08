import { GroupService } from 'src/modules/group/group.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * v5.9.2「成员移除自己=主动退群」单测。
 * 覆盖：
 *   1. 普通成员自退成功：无需群主权限，delete 成员记录 + member_count 更新 + WS 推送
 *   2. 群主自退 → 403（需先转让群主或解散群组）
 *   3. 非成员自退 → 404（不在该群成员中）
 *   4. 普通成员移除他人 → 403（Only group owner can remove members，原逻辑不变）
 *   5. 群主移除普通成员 → 成功（原逻辑回归）
 *   6. 系统管理员移除任意群成员 → 成功（原逻辑回归）
 *   7. 移除群主（target=owner）→ 403（Cannot remove the group owner，原逻辑回归）
 *
 * 不接 DB：jest.fn 替身 repository，与 media-burn-consume.spec.ts 同范式。
 */
describe('GroupService 成员移除/主动退群（v5.9.2）', () => {
  const build = (opts: {
    operatorMembership?: any; // operator 的成员记录（null=非成员）
    targetMembership?: any;   // target 的成员记录
  } = {}) => {
    const memberRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.user_id === 'owner') return opts.operatorMembership === undefined ? { role: 'owner' } : opts.operatorMembership;
        if (where.user_id === 'u2') return opts.operatorMembership === undefined ? { role: 'member' } : opts.operatorMembership;
        if (where.user_id === 'u3') return opts.targetMembership === undefined ? { role: 'member' } : opts.targetMembership;
        return null;
      }),
      delete: jest.fn(async () => ({ affected: 1 })),
      count: jest.fn(async () => 2),
      find: jest.fn(async () => [{ user_id: 'owner' }, { user_id: 'u4' }]),
    };
    const convRepo = { update: jest.fn(async () => ({ affected: 1 })) };
    const dataSource = {
      getRepository: jest.fn((entity: any) =>
        entity && entity.name === 'Conversation' ? convRepo : memberRepo,
      ),
    };
    const events = { emitToUsers: jest.fn() };
    const audit: any = {};
    const svc = new GroupService(dataSource as any, events as any, audit as any);
    return { svc, memberRepo, convRepo, events };
  };

  beforeEach(() => jest.clearAllMocks());

  it('1. 普通成员移除自己（userId=自己）→ 退群成功，无需群主权限', async () => {
    const { svc, memberRepo, convRepo, events } = build({ operatorMembership: { role: 'member' } });
    await svc.removeMember('c1', 'u2', 'u2'); // target=operator=u2

    expect(memberRepo.delete).toHaveBeenCalledWith({ conversation_id: 'c1', user_id: 'u2' });
    expect(convRepo.update).toHaveBeenCalledWith('c1', { member_count: 2 });
    expect(events.emitToUsers).toHaveBeenCalled();
    const [event, userIds] = events.emitToUsers.mock.calls[0];
    expect(userIds).toContain('u2'); // 退群者本人收到推送，会话列表移除该群
  });

  it('2. 群主移除自己 → 403，提示先转让/解散', async () => {
    const { svc } = build({ operatorMembership: { role: 'owner' } });
    await expect(svc.removeMember('c1', 'owner', 'owner')).rejects.toThrow(
      /群主不能移除自己退群/,
    );
  });

  it('3. 非成员移除自己 → 404（不在该群成员中）', async () => {
    const { svc } = build({ operatorMembership: null });
    await expect(svc.removeMember('c1', 'u2', 'u2')).rejects.toThrow(NotFoundException);
  });

  it('4. 普通成员移除他人 → 403（原逻辑不变）', async () => {
    const { svc, memberRepo } = build({ operatorMembership: { role: 'member' } });
    await expect(svc.removeMember('c1', 'u3', 'u2')).rejects.toThrow(ForbiddenException);
    expect(memberRepo.delete).not.toHaveBeenCalled();
  });

  it('5. 群主移除普通成员 → 成功（原逻辑回归）', async () => {
    const { svc, memberRepo } = build({ operatorMembership: { role: 'owner' }, targetMembership: { role: 'member' } });
    await svc.removeMember('c1', 'u3', 'owner');
    expect(memberRepo.delete).toHaveBeenCalledWith({ conversation_id: 'c1', user_id: 'u3' });
  });

  it('6. 系统管理员移除任意群成员 → 成功（原逻辑回归）', async () => {
    const { svc, memberRepo } = build({ targetMembership: { role: 'member' } });
    // operator=u9 不在本群，但 role=admin 直接放行
    await svc.removeMember('c1', 'u3', 'u9', 'admin');
    expect(memberRepo.delete).toHaveBeenCalledWith({ conversation_id: 'c1', user_id: 'u3' });
  });

  it('7. 移除群主（target=owner）→ 403（原逻辑回归）', async () => {
    const { svc } = build({ operatorMembership: { role: 'owner' }, targetMembership: { role: 'owner' } });
    await expect(svc.removeMember('c1', 'u3', 'owner')).rejects.toThrow(
      /Cannot remove the group owner/,
    );
  });
});

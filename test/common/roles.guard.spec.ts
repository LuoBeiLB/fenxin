import { RolesGuard } from '../../src/common/guards/roles.guard';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';

describe('RolesGuard', () => {
  const makeCtx = (user: any) => ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    // reflector.getAllAndOverride 内部要调 getHandler / getClass
    getHandler: () => null,
    getClass: () => null,
  } as any);

  it('无 @Roles 装饰器 → 放行', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValueOnce(undefined as any),
    } as any;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(makeCtx({ role: 'user' }))).toBe(true);
  });

  it('@Roles([]) 空数组 → 放行（视为未限制）', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValueOnce([] as any),
    } as any;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(makeCtx({ role: 'user' }))).toBe(true);
  });

  it('@Roles([admin]) + 当前 user.role=admin → 放行', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValueOnce(['admin'] as any),
    } as any;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(makeCtx({ role: 'admin' }))).toBe(true);
  });

  it('@Roles([admin]) + 当前 user.role=user → ForbiddenException', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValueOnce(['admin'] as any),
    } as any;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(makeCtx({ role: 'user' }))).toThrow(ForbiddenException);
  });

  it('@Roles([admin, super]) + user.role=super → 放行（多角色其一即可）', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValueOnce(['admin', 'super'] as any),
    } as any;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(makeCtx({ role: 'super' }))).toBe(true);
  });

  it('未登录（req.user 不存在） + 受限角色 → ForbiddenException', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValueOnce(['admin'] as any),
    } as any;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(makeCtx(undefined))).toThrow(ForbiddenException);
  });
});

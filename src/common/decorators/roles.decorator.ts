import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
/** 限定接口访问角色，如 @Roles('admin') */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

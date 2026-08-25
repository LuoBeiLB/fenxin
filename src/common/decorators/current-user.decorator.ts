import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthPayload } from '../guards/jwt-auth.guard';

/** 取当前登录用户 payload：@CurrentUser() user: AuthPayload */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthPayload | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as AuthPayload;
    return data ? user?.[data] : user;
  },
);

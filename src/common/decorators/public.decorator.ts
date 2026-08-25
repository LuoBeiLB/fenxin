import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** 标记无需登录即可访问的接口（如 login / refresh-token / health） */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

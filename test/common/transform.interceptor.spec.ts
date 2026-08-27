import 'reflect-metadata';
import { TransformInterceptor } from 'src/common/interceptors/transform.interceptor';
import { RESPONSE_MESSAGE_KEY } from 'src/common/decorators/response-message.decorator';
import { Reflector } from '@nestjs/core';
import { of, lastValueFrom } from 'rxjs';

describe('TransformInterceptor', () => {
  // 用真实 Reflector + Reflect.defineMetadata 注入，100% 还原线上反射路径
  const makeContext = (msg?: string) => {
    const handler: any = {};
    const cls: any = {};
    if (msg) Reflect.defineMetadata(RESPONSE_MESSAGE_KEY, msg, handler);
    return {
      switchToHttp: () => ({} as any),
      getHandler: () => handler,
      getClass: () => cls,
    } as any;
  };

  it('默认 message=ok，data 透传', async () => {
    const interceptor = new TransformInterceptor(new Reflector());
    const out = await lastValueFrom(
      interceptor.intercept(makeContext() as any, {
        handle: () => of({ a: 1 }),
      }),
    );
    expect(out).toEqual({ code: 0, message: 'ok', data: { a: 1 } });
  });

  it('@ResponseMessage 自定义 message', async () => {
    const interceptor = new TransformInterceptor(new Reflector());
    const out = await lastValueFrom(
      interceptor.intercept(makeContext('创建成功') as any, {
        handle: () => of({ id: 1 }),
      }),
    );
    expect(out).toEqual({ code: 0, message: '创建成功', data: { id: 1 } });
  });

  it('data 为 null 时仍输出 data: null（不吞）', async () => {
    const interceptor = new TransformInterceptor(new Reflector());
    const out = await lastValueFrom(
      interceptor.intercept(makeContext() as any, {
        handle: () => of(null),
      }),
    );
    expect(out).toEqual({ code: 0, message: 'ok', data: null });
  });

  it('data 为 undefined 时输出 data: null', async () => {
    const interceptor = new TransformInterceptor(new Reflector());
    const out = await lastValueFrom(
      interceptor.intercept(makeContext() as any, {
        handle: () => of(undefined),
      }),
    );
    expect(out).toEqual({ code: 0, message: 'ok', data: null });
  });
});

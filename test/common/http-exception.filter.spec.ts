import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import {
  HttpException,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

describe('HttpExceptionFilter', () => {
  const makeHost = () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const host = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as any;
    return { host, res };
  };
  const filter = new HttpExceptionFilter();

  it('HttpException 字符串 body → code=状态码', () => {
    const { host, res } = makeHost();
    filter.catch(new HttpException('boom', 418), host);
    expect(res.status).toHaveBeenCalledWith(418);
    expect(res.json).toHaveBeenCalledWith({ code: 418, message: 'boom' });
  });

  it('业务 code 字符串（ForbiddenException({code:...})）→ 提取 message（master 无 errorCode 体系）', () => {
    const { host, res } = makeHost();
    filter.catch(
      new ForbiddenException({
        code: 'FORCE_CHANGE_PASSWORD',
        message: '请先改密',
      }),
      host,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      code: 403,
      message: '请先改密',
    });
  });

  it('class-validator 失败（message 是数组）→ 拼接为分号串', () => {
    const { host, res } = makeHost();
    filter.catch(
      new BadRequestException({
        message: ['phone must be string', 'password too short'],
        error: 'Bad Request',
        statusCode: 400,
      }),
      host,
    );
    expect(res.json).toHaveBeenCalledWith({
      code: 400,
      message: 'phone must be string; password too short',
    });
  });

  it('非 HttpException Error → 500 + 通用消息（stack 走 logger）', () => {
    const { host, res } = makeHost();
    filter.catch(new Error('disk full'), host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ code: 500, message: '服务器内部错误' });
  });

  it('非 Error 异常 → 500 + 通用消息', () => {
    const { host, res } = makeHost();
    filter.catch({ weird: 'object' } as any, host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ code: 500, message: '服务器内部错误' });
  });

  it('UnauthorizedException 走 401（NestJS 字符串异常会自动加 error 字段）', () => {
    const { host, res } = makeHost();
    filter.catch(new UnauthorizedException('nope'), host);
    expect(res.status).toHaveBeenCalledWith(401);
    // NestJS 给字符串消息包成 { message, error, statusCode }，filter 透出 error 字段是预期行为
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 401, message: 'nope' }),
    );
  });
});

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';

/** 统一错误响应格式：{ code: <httpStatus>, message } */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();

    let status = 500;
    let message = '服务器内部错误';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const msg = typeof body === 'string' ? body : (body as any)?.message;
      message = Array.isArray(msg) ? msg.join('; ') : msg || exception.message;
    } else if (exception instanceof Error) {
      // 不透出内部错误详情（如磁盘/SQL 错误）给客户端，统一 500 通用消息；细节只记日志
      this.logger.error(exception.stack);
    } else {
      this.logger.error(String(exception));
    }

    res.status(status).json({ code: status, message });
  }
}

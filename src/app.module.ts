import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { join } from 'path';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { SeedService } from './database/seed.service';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TokenModule } from './modules/auth/token.module';
import { EventsModule } from './modules/events/events.module';
import { AuthCacheModule } from './common/cache/auth-cache.module';
import { KeysModule } from './modules/keys/keys.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { AccountModule } from './modules/account/account.module';
import { ContactModule } from './modules/contact/contact.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { MessageModule } from './modules/message/message.module';
import { GroupModule } from './modules/group/group.module';
import { UploadModule } from './modules/upload/upload.module';
import { StatsModule } from './modules/stats/stats.module';
import { AnnouncementModule } from './modules/announcement/announcement.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { AppVersionModule } from './modules/app-version/app-version.module';

@Module({
  imports: [
    // ====== 鉴权缓存：@Global() 注入，全应用共享同一份 in-memory map（30s TTL）======
    AuthCacheModule,
    // ====== 日志：pino 接管所有 NestJS Logger ======
    // 生产：JSON 行（含 reqId / status / latency），给采集系统；开发：pino-pretty 单行带色
    LoggerModule.forRoot({
      pinoHttp: {
        level:
          process.env.LOG_LEVEL ||
          (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        transport:
          (process.env.LOG_PRETTY || process.env.NODE_ENV !== 'production') === 'true'
            ? {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  translateTime: 'SYS:HH:MM:ss.l',
                  colorize: true,
                  ignore: 'pid,hostname',
                },
              }
            : undefined,
        // 注入请求 ID：优先用上游 X-Request-Id，否则 UUID
        genReqId: (req, res) => {
          const fromHeader =
            (req.headers['x-request-id'] as string | undefined) ||
            (req.headers['x-correlation-id'] as string | undefined);
          if (fromHeader) {
            res.setHeader('X-Request-Id', fromHeader);
            return fromHeader;
          }
          // crypto 在 Node 环境可用；用 require 避免顶部 import 抖动
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { randomUUID } = require('crypto');
          const id = randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        // HTTP 自动访问日志：4xx→warn / 5xx/err→error / 其余→info
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        // 不打 /health 噪音
        autoLogging: {
          ignore: (req) =>
            typeof req.url === 'string' && req.url.startsWith('/api/v1/health'),
        },
        // 序列化错误：把 stack 收敛到一行
        formatters: {
          level: (label) => ({ level: label }),
        },
      },
    }),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      username: process.env.DB_USERNAME || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_DATABASE || 'burnmsg',
      // 首次部署建表可设 DB_SYNC=true；正式运行务必 false
      synchronize: (process.env.DB_SYNC || 'false') === 'true',
      logging: process.env.NODE_ENV === 'development',
      entities: [join(__dirname, '/**/*.entity{.ts,.js}')],
      charset: 'utf8mb4',
    }),
    ScheduleModule.forRoot(),
    // 全局限流：每 IP 每分钟 300 次；登录等敏感接口单独收紧
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), process.env.UPLOAD_DIR || './uploads'),
      serveRoot: '/uploads',
    }),
    TokenModule,
    KeysModule,
    EventsModule,
    AuditModule,
    AuthModule,
    AccountModule,
    ContactModule,
    ConversationModule,
    MessageModule,
    GroupModule,
    UploadModule,
    StatsModule,
    AnnouncementModule,
    FeedbackModule,
    AppVersionModule,
  ],
  controllers: [AppController],
  providers: [
    SeedService,
    // 全局守卫顺序：限流 → JWT 认证（含账号状态/设备吊销校验）→ 角色
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}

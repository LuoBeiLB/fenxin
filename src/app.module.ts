import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { join } from 'path';
import { AppController } from './app.controller';
import { SeedService } from './database/seed.service';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TokenModule } from './modules/auth/token.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { AccountModule } from './modules/account/account.module';
import { ContactModule } from './modules/contact/contact.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { MessageModule } from './modules/message/message.module';
import { GroupModule } from './modules/group/group.module';
import { UploadModule } from './modules/upload/upload.module';

@Module({
  imports: [
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
    AuditModule,
    AuthModule,
    AccountModule,
    ContactModule,
    ConversationModule,
    MessageModule,
    GroupModule,
    UploadModule,
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

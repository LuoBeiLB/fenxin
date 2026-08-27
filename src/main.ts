import 'reflect-metadata';
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  // 确保上传目录存在
  const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // CORS 白名单（来自环境变量；配置 * 放行所有来源；为空则禁止跨域浏览器调用）
  const origins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // '*' 通配时用 origin: true（反射请求方 Origin），与 credentials: true 兼容；
  // 注意不能回字面 '*'，浏览器在携带凭证模式下会拒绝。
  const corsOrigin = origins.includes('*') ? true : origins.length > 0 ? origins : false;
  app.enableCors({ origin: corsOrigin, credentials: true });

  // Swagger 仅显式开启时暴露（生产环境应关闭）
  if ((process.env.SWAGGER_ENABLED || 'false') === 'true') {
    let doc: any;
    // 优先加载项目根目录的 openapi.yaml（手工维护的完整中文详细文档，
    // 34 个接口逐字段描述，以源码为准核对过）；文件缺失时回退为装饰器自动生成
    const openapiPath = path.resolve(process.cwd(), 'openapi.yaml');
    if (fs.existsSync(openapiPath)) {
      const yaml = require('js-yaml');
      doc = yaml.load(fs.readFileSync(openapiPath, 'utf-8'));
      console.log('[Swagger] 已加载 openapi.yaml（完整版文档）');
    } else {
      const config = new DocumentBuilder()
        .setTitle('焚信 (BurnMsg) API')
        .setDescription('企业级端到端加密通讯应用后端接口文档（NestJS 版）')
        .setVersion('2.0.0')
        .addBearerAuth()
        .build();
      doc = SwaggerModule.createDocument(app, config);
      console.log('[Swagger] openapi.yaml 不存在，使用自动生成文档');
    }
    SwaggerModule.setup('api-docs', app, doc, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: '焚信 API 文档',
    });
  }

  const port = parseInt(process.env.PORT || '9091', 10);
  await app.listen(port);
  console.log(`[Server] BurnMsg API (NestJS) running on port ${port}`);
}

bootstrap();

import 'reflect-metadata';
import 'dotenv/config';
import { join } from 'path';
import { DataSource } from 'typeorm';

/**
 * TypeORM CLI DataSource（生产化用，运行时仍走 src/app.module.ts 的 TypeOrmModule.forRoot）。
 * 仅供 npm scripts migration:generate / migration:run / migration:revert 使用：
 *   pnpm migration:run     → 跑所有未执行的迁移
 *   pnpm migration:revert  → 回滚最后一次迁移
 *   pnpm migration:generate src/database/migrations/<Name> → 自动生成迁移文件
 *
 * 注意：运行时（nest start）不需要这个文件，应用走自己的 TypeOrmModule 配置；
 * synchronize 永远为 false，避免与迁移系统冲突。
 */
export default new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  username: process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'burnmsg',
  charset: 'utf8mb4',
  // CLI 必须关闭 synchronize，避免和 migrations 抢着改表
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
  entities: [join(__dirname, '../**/*.entity{.ts,.js}')],
  migrations: [join(__dirname, 'migrations/*{.ts,.js}')],
  migrationsTableName: 'typeorm_migrations',
});

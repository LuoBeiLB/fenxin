import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 用户主题色字段迁移（V5.8 用户自选前端主题色）。
 * app_users 加 topic 列：用户在 App 设置页自选主题色标识（值域由前端定义），
 * 存服务端换设备登录后同步；登录响应与 GET /auth/profile 返回，PUT /auth/profile 可修改。
 *
 * 生产环境（DB_SYNC=false）执行：npm run migration:run
 */
export class AddUserTopic1767400000000 implements MigrationInterface {
  name = 'AddUserTopic1767400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE `app_users` ADD COLUMN `topic` varchar(20) NOT NULL DEFAULT 'default' COMMENT '用户自选前端主题色标识（值域由前端定义）' AFTER `signature`",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `app_users` DROP COLUMN `topic`');
  }
}

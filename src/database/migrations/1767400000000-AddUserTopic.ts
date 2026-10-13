import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 用户主题色字段迁移（V5.8 用户自选前端主题色）。
 * app_users 加 topic 列：用户在 App 设置页自选主题色标识（值域由前端定义），
 * 存服务端换设备登录后同步；登录响应与 GET /auth/profile 返回，PUT /auth/profile 可修改。
 *
 * 生产环境（DB_SYNC=false）执行：npm run migration:run
 *
 * 幂等（2026-10-13 加固）：用 information_schema 判断列是否已存在，重复执行不报错。
 * 必须如此的原因：凡是用 DB_SYNC=true 建过表的库（开发库 / 从开发库克隆的库），
 * topic 列早已被 synchronize 建出来；这类库首次跑 migration:run 会把历史迁移全量重放，
 * 没有守卫就会以 "Duplicate column name 'topic'" 中断整个迁移批次。
 */
export class AddUserTopic1767400000000 implements MigrationInterface {
  name = 'AddUserTopic1767400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.columnExists(queryRunner)) return; // 已存在（DB_SYNC 建过 / 重复执行）→ 幂等跳过
    await queryRunner.query(
      "ALTER TABLE `app_users` ADD COLUMN `topic` varchar(20) NOT NULL DEFAULT 'default' COMMENT '用户自选前端主题色标识（值域由前端定义）' AFTER `signature`",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner))) return;
    await queryRunner.query('ALTER TABLE `app_users` DROP COLUMN `topic`');
  }

  /** 查当前库 app_users 是否已有 topic 列 */
  private async columnExists(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'app_users'
          AND column_name = 'topic'`,
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

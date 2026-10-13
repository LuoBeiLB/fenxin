import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 用户默认焚毁时长偏好迁移（V5.9.4）。
 *
 * app_users 加 default_burn_ttl_seconds 列（int NULL）：
 * 用户在 App 设置页选择的「默认焚毁时长」（秒，如 600 = 10 分钟、86400 = 1 天），
 * 与 topic 同模式的用户偏好字段 —— 存服务端，换设备 / 重启浏览器后登录即恢复，
 * 不需要用户重新选择。NULL = 默认不焚毁（用户选择关闭或从未选择过）。
 *
 * 与 topic 的区别（有意为之）：
 * - topic 是 NOT NULL DEFAULT 'default'（字符串，前端自定义值域）；
 * - 本列必须可空：需要区分「用户明确选择不焚毁（NULL）」与「选了具体时长（正整数）」，
 *   没有合理的非空默认值 —— 任何数字默认都会让新用户凭空得到一个焚毁时长。
 *
 * 语义边界：本列只是「用户偏好 / 上次选择」，服务端只存取，**不参与任何焚毁判定**；
 * 真正生效的焚毁时长仍以发送请求体的 messages.burn_ttl_seconds 为准。
 *
 * 幂等：用 information_schema 判断列是否已存在，重复执行不报错
 * （与 docs/migration-20260831-burn-on-read.sql 同一写法）。
 * 生产环境（DB_SYNC=false）执行：npm run migration:run
 */
export class AddUserBurnPreference1767700000000 implements MigrationInterface {
  name = 'AddUserBurnPreference1767700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await this.columnExists(queryRunner);
    if (exists) return; // 已存在（重复执行 / DB_SYNC 已建列）→ 幂等跳过

    await queryRunner.query(
      "ALTER TABLE `app_users` ADD COLUMN `default_burn_ttl_seconds` int NULL " +
        "COMMENT '用户默认焚毁时长（秒）；NULL=默认不焚毁。仅用户偏好，不参与焚毁判定' " +
        'AFTER `topic`',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await this.columnExists(queryRunner);
    if (!exists) return;
    await queryRunner.query('ALTER TABLE `app_users` DROP COLUMN `default_burn_ttl_seconds`');
  }

  /** 查当前库 app_users 是否已有 default_burn_ttl_seconds 列 */
  private async columnExists(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'app_users'
          AND column_name = 'default_burn_ttl_seconds'`,
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

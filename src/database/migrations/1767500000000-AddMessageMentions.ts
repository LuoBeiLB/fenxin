import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 消息 @提及字段迁移（V5.8 前端「有人@我」提醒）。
 * messages 加 mentions 列（json）：本条消息实际@到的成员用户 ID 数组。
 * content 里的「@昵称」纯文本仅供展示（同名/改名会漂移误判），mentions 是精确身份；
 * 发送时仅保留会话成员 uid（非成员过滤），查询返回与 WS message:new 推送均原样携带。
 *
 * 生产环境（DB_SYNC=false）执行：npm run migration:run
 *
 * 幂等（2026-10-13 加固）：用 information_schema 判断列是否已存在，重复执行不报错。
 * 必须如此的原因：用 DB_SYNC=true 建过表的库（开发库等）mentions 列已由 synchronize 建出，
 * 这类库首次跑 migration:run 会全量重放历史迁移，无守卫会以
 * "Duplicate column name 'mentions'" 中断整个批次。
 */
export class AddMessageMentions1767500000000 implements MigrationInterface {
  name = 'AddMessageMentions1767500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.columnExists(queryRunner)) return; // 已存在（DB_SYNC 建过 / 重复执行）→ 幂等跳过
    // MySQL 8.0：json 列用表达式默认值（8.0.13+ 支持），存量行自动回填 []
    await queryRunner.query(
      "ALTER TABLE `messages` ADD COLUMN `mentions` json NOT NULL DEFAULT (JSON_ARRAY()) COMMENT '被@成员用户ID数组（前端「有人@我」判定依据）' AFTER `sender_ephemeral_pubkey`",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner))) return;
    await queryRunner.query('ALTER TABLE `messages` DROP COLUMN `mentions`');
  }

  /** 查当前库 messages 是否已有 mentions 列 */
  private async columnExists(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'messages'
          AND column_name = 'mentions'`,
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

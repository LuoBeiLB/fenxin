import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 焚毁时长「按人设置」（V6.1）。
 *
 * 背景：V6.0 的时长是「每条消息发送时决定」，用户每次都要重新选；
 * 本次改为「联系人级 / 会话级默认值」：进会话时查一次，之后发消息自动套用。
 *
 * 本表只存**默认值**，不影响已发消息：
 *   生效时长会快照进 messages.burn_ttl_seconds，改设置只影响之后发出的消息。
 *
 * 幂等：information_schema 判断。
 */
export class AddBurnSettings1768000000000 implements MigrationInterface {
  name = 'AddBurnSettings1768000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasTable(queryRunner, 'burn_settings'))) {
      await queryRunner.query(`
        CREATE TABLE \`burn_settings\` (
          \`id\` varchar(36) NOT NULL,
          \`owner_id\` varchar(36) NOT NULL COMMENT '设置者（视角），只影响其本人发出的消息',
          \`scope_type\` varchar(16) NOT NULL COMMENT 'user=按对方用户（私聊）；conversation=按会话（群/频道）',
          \`scope_id\` varchar(36) NOT NULL COMMENT 'scope_type=user 时为目标 user_id；=conversation 时为 conversation_id',
          \`ttl_seconds\` int NOT NULL COMMENT '焚毁时长（秒）1~2592000',
          \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uk_burn_owner_scope\` (\`owner_id\`, \`scope_type\`, \`scope_id\`),
          KEY \`idx_burn_owner\` (\`owner_id\`),
          KEY \`idx_burn_scope\` (\`scope_type\`, \`scope_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          COMMENT='焚毁时长设置（按人/按会话，仅影响后续发送）'
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasTable(queryRunner, 'burn_settings')) {
      await queryRunner.query('DROP TABLE `burn_settings`');
    }
  }

  private async hasTable(queryRunner: QueryRunner, table: string): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

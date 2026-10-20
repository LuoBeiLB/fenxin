import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 焚毁机制 V6.0：两阶段销毁（软删标记 + 确认后真删）。
 *
 * 内容：
 *  ① `messages.is_destroyed` 从"死字段"变为真正的软删标记（之前永远为 0）
 *  ② 新增审计列 `destroyed_at` / `destroy_reason`
 *  ③ 新增 `message_tombstones`（真删除后仍能渲染"已焚毁"占位）
 *  ④ 新增 `message_destroy_acks`（前端确认真删除的记录）
 *  ⑤ 补调度扫描索引
 *  ⑥ 修正存量数据：`destroy_at` 曾被固定写成"发送 + 24h"，与用户选的 ttl 无关，
 *     导致 7 天档消息 24 小时就被删。这里把不足 `created_at + burn_ttl_seconds` 的抬上去。
 *  ⑦ 清理确认无引用的冗余列：`conversation_members.muted`、`conversations.ai_enabled`、
 *     `message_receipts.is_delivered`（全仓库 0 读取）。
 *     注意：`conversations.is_channel` 仍被前端使用，本次**不删**。
 *
 * 幂等：全部用 information_schema 判断（对齐仓库既有迁移写法），可重复执行。
 * 生产环境（DB_SYNC=false）执行：npm run migration:run
 *
 * 回滚注意：`down()` 会删列删表，已真删除的消息无法恢复（墓碑/确认表随之丢失）。
 */
export class BurnV6SoftDelete1767800000000 implements MigrationInterface {
  name = 'BurnV6SoftDelete1767800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ① is_destroyed 语义确认（列已存在，统一类型与默认值）
    if (await this.hasColumn(queryRunner, 'messages', 'is_destroyed')) {
      await queryRunner.query(
        "ALTER TABLE `messages` MODIFY COLUMN `is_destroyed` tinyint(1) NOT NULL DEFAULT 0 " +
          "COMMENT '0=正常 1=已焚毁（软删，列表/搜索/reveal 均不可见，等待确认真删）'",
      );
    }

    // ② 审计列
    if (!(await this.hasColumn(queryRunner, 'messages', 'destroyed_at'))) {
      await queryRunner.query(
        "ALTER TABLE `messages` ADD COLUMN `destroyed_at` datetime NULL " +
          "COMMENT '实际标记焚毁的时刻（真删除任务依据）' AFTER `is_destroyed`",
      );
    }
    if (!(await this.hasColumn(queryRunner, 'messages', 'destroy_reason'))) {
      await queryRunner.query(
        "ALTER TABLE `messages` ADD COLUMN `destroy_reason` varchar(20) NULL " +
          "COMMENT 'fallback_expired/all_read/owner_dissolve/admin_dissolve/manual' AFTER `destroyed_at`",
      );
    }

    // ③ 墓碑表
    if (!(await this.hasTable(queryRunner, 'message_tombstones'))) {
      await queryRunner.query(`
        CREATE TABLE \`message_tombstones\` (
          \`id\` varchar(36) NOT NULL,
          \`conversation_id\` varchar(36) NOT NULL,
          \`sender_id\` varchar(36) NOT NULL,
          \`type\` varchar(20) NOT NULL,
          \`created_at\` datetime NOT NULL,
          \`destroyed_at\` datetime NOT NULL,
          \`destroy_reason\` varchar(20) NOT NULL,
          PRIMARY KEY (\`id\`),
          KEY \`idx_tomb_conv\` (\`conversation_id\`, \`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          COMMENT='已真删除消息的轻量墓碑（不含任何内容）'
      `);
    }

    // ④ 确认记录表
    if (!(await this.hasTable(queryRunner, 'message_destroy_acks'))) {
      await queryRunner.query(`
        CREATE TABLE \`message_destroy_acks\` (
          \`id\` varchar(36) NOT NULL,
          \`message_id\` varchar(36) NOT NULL,
          \`user_id\` varchar(36) NOT NULL,
          \`device_id\` varchar(36) NULL,
          \`acked_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uk_ack_msg_user\` (\`message_id\`, \`user_id\`),
          KEY \`idx_ack_msg\` (\`message_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          COMMENT='真删除确认记录'
      `);
    }

    // ⑤ 调度扫描索引
    if (!(await this.hasIndex(queryRunner, 'messages', 'idx_messages_burn_scan'))) {
      await queryRunner.query(
        'CREATE INDEX `idx_messages_burn_scan` ON `messages` (`is_destroyed`, `destroy_at`)',
      );
    }
    if (!(await this.hasIndex(queryRunner, 'messages', 'idx_messages_purge'))) {
      await queryRunner.query(
        'CREATE INDEX `idx_messages_purge` ON `messages` (`is_destroyed`, `destroyed_at`)',
      );
    }

    // ⑥ 存量修正：destroy_at 不得早于 created_at + burn_ttl_seconds
    //    分批更新，避免大表长时间锁（每次 1000 行，最多 100 批）
    for (let i = 0; i < 100; i += 1) {
      const result = await queryRunner.query(
        `UPDATE \`messages\`
            SET \`destroy_at\` = DATE_ADD(\`created_at\`, INTERVAL \`burn_ttl_seconds\` SECOND)
          WHERE \`burn_ttl_seconds\` IS NOT NULL
            AND (\`destroy_at\` IS NULL
                 OR \`destroy_at\` < DATE_ADD(\`created_at\`, INTERVAL \`burn_ttl_seconds\` SECOND))
          LIMIT 1000`,
      );
      const affected = Number(result?.affectedRows ?? 0);
      if (affected === 0) break;
    }

    // ⑦ 冗余列清理（全仓库 0 读取；如需保留请注释掉对应语句）
    if (await this.hasColumn(queryRunner, 'conversation_members', 'muted')) {
      await queryRunner.query('ALTER TABLE `conversation_members` DROP COLUMN `muted`');
    }
    if (await this.hasColumn(queryRunner, 'conversations', 'ai_enabled')) {
      await queryRunner.query('ALTER TABLE `conversations` DROP COLUMN `ai_enabled`');
    }
    if (await this.hasColumn(queryRunner, 'message_receipts', 'is_delivered')) {
      await queryRunner.query('ALTER TABLE `message_receipts` DROP COLUMN `is_delivered`');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 恢复冗余列（只有结构，数据不可恢复）
    if (!(await this.hasColumn(queryRunner, 'conversation_members', 'muted'))) {
      await queryRunner.query(
        "ALTER TABLE `conversation_members` ADD COLUMN `muted` tinyint(1) NOT NULL DEFAULT 0 AFTER `role`",
      );
    }
    if (!(await this.hasColumn(queryRunner, 'conversations', 'ai_enabled'))) {
      await queryRunner.query(
        "ALTER TABLE `conversations` ADD COLUMN `ai_enabled` tinyint(1) NOT NULL DEFAULT 0 AFTER `visibility`",
      );
    }
    if (!(await this.hasColumn(queryRunner, 'message_receipts', 'is_delivered'))) {
      await queryRunner.query(
        "ALTER TABLE `message_receipts` ADD COLUMN `is_delivered` tinyint(1) NOT NULL DEFAULT 0 AFTER `user_id`",
      );
    }

    if (await this.hasIndex(queryRunner, 'messages', 'idx_messages_burn_scan')) {
      await queryRunner.query('DROP INDEX `idx_messages_burn_scan` ON `messages`');
    }
    if (await this.hasIndex(queryRunner, 'messages', 'idx_messages_purge')) {
      await queryRunner.query('DROP INDEX `idx_messages_purge` ON `messages`');
    }
    if (await this.hasTable(queryRunner, 'message_destroy_acks')) {
      await queryRunner.query('DROP TABLE `message_destroy_acks`');
    }
    if (await this.hasTable(queryRunner, 'message_tombstones')) {
      await queryRunner.query('DROP TABLE `message_tombstones`');
    }
    if (await this.hasColumn(queryRunner, 'messages', 'destroy_reason')) {
      await queryRunner.query('ALTER TABLE `messages` DROP COLUMN `destroy_reason`');
    }
    if (await this.hasColumn(queryRunner, 'messages', 'destroyed_at')) {
      await queryRunner.query('ALTER TABLE `messages` DROP COLUMN `destroyed_at`');
    }
  }

  // ===== 幂等探测helpers =====

  private async hasColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }

  private async hasTable(queryRunner: QueryRunner, table: string): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }

  private async hasIndex(
    queryRunner: QueryRunner,
    table: string,
    index: string,
  ): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, index],
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

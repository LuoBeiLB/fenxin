import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 销毁回执表迁移（V4.0 任务书 §M5.4 / §A3）。
 * 每条阅后即焚消息被销毁时（无论到期 / 手动 / 发送方撤回），服务端都落一条签名回执，
 * 用于事后审计与对账。生产环境关 DB_SYNC 后用 `npm run migration:run` 执行。
 *
 * 字段：id / message_id / conversation_id / destroyed_at / destroy_method /
 *       server_signature（sha256 签名）/ created_at
 * 索引：message_id（按消息查）/ conversation_id（按会话查）/ destroyed_at（按时间窗查）
 *
 * 幂等（2026-10-13 加固）：用 information_schema 判断表是否已存在，重复执行不报错。
 * 注意本表与其余 4 个迁移的差异：destroy_receipts **没有对应的 entity**（全仓库仅本文件引用），
 * 所以 synchronize 永远不会替你建它，DB_SYNC=true 的库上不会出现"抢建冲突"。
 * 但仍需守卫，因为下列场景同样会撞 "Table 'destroy_receipts' already exists" 并中断整个批次：
 *   ① 从备份恢复库 / 库里有本表但 typeorm_migrations 记录丢失
 *   ② 同一台实例重复执行 migration:run
 *   ③ 手工建过本表
 */
export class AddDestroyReceipts1709000000000 implements MigrationInterface {
  name = 'AddDestroyReceipts1709000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.tableExists(queryRunner)) return; // 已存在 → 幂等跳过
    await queryRunner.query(`
      CREATE TABLE \`destroy_receipts\` (
        \`id\` varchar(36) NOT NULL,
        \`message_id\` varchar(36) NOT NULL,
        \`conversation_id\` varchar(36) NOT NULL,
        \`destroyed_at\` datetime NOT NULL,
        \`destroy_method\` varchar(20) NOT NULL,
        \`server_signature\` varchar(128) NOT NULL,
        \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_receipt_message_id\` (\`message_id\`),
        INDEX \`idx_receipt_conversation_id\` (\`conversation_id\`),
        INDEX \`idx_receipt_destroyed_at\` (\`destroyed_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.tableExists(queryRunner))) return;
    await queryRunner.query(`DROP TABLE \`destroy_receipts\``);
  }

  /** 查当前库是否已有 destroy_receipts 表 */
  private async tableExists(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = 'destroy_receipts'`,
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 销毁回执表迁移（V4.0 任务书 §M5.4 / §A3）。
 * 每条阅后即焚消息被销毁时（无论到期 / 手动 / 发送方撤回），服务端都落一条签名回执，
 * 用于事后审计与对账。生产环境关 DB_SYNC 后用 `npm run migration:run` 执行。
 *
 * 字段：id / message_id / conversation_id / destroyed_at / destroy_method /
 *       server_signature（sha256 签名）/ created_at
 * 索引：message_id（按消息查）/ conversation_id（按会话查）/ destroyed_at（按时间窗查）
 */
export class AddDestroyReceipts1709000000000 implements MigrationInterface {
  name = 'AddDestroyReceipts1709000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
    await queryRunner.query(`DROP TABLE \`destroy_receipts\``);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 删除用户级公钥表 `user_keys`（V6.2 设备级密钥退役旧方案）。
 *
 * 背景（见 docs/E2E_SECRET_CHAT.md §4.3 与 AGENTS.md §2）：
 *   - 项目不做向后兼容，产品确认聊天记录不是核心资产；
 *   - 设备级 `device_keys` 上线后，用户级密钥不再有使用场景；
 *   - 保留该表反而会让"旧加密消息可解"成为一种半残状态（只有一台设备能解）。
 *
 * 影响：
 *   - 存量加密消息（迁移前发出的）**不再可解密**，前端统一显示「旧版加密消息，已无法解密」；
 *   - `POST /keys`、`GET /keys/:userId`、`POST /keys/query` 三个接口同步下线；
 *   - **不可回滚**：down() 只能重建空表结构，数据无法恢复（需要恢复请用数据库备份）。
 *
 * 幂等：information_schema 判断表是否存在。
 */
export class DropUserKeys1768200002000 implements MigrationInterface {
  name = 'DropUserKeys1768200002000';

  public async up(qr: QueryRunner): Promise<void> {
    if (await this.hasTable(qr, 'user_keys')) {
      await qr.query('DROP TABLE `user_keys`');
    }
  }

  /**
   * ⚠️ 仅重建结构，**数据不可恢复**。
   * 旧客户端若回滚到本方案之前的版本，会看到"所有用户都没上传过公钥"的状态。
   */
  public async down(qr: QueryRunner): Promise<void> {
    if (await this.hasTable(qr, 'user_keys')) return;

    await qr.query(`
      CREATE TABLE \`user_keys\` (
        \`id\`              varchar(36)  NOT NULL,
        \`user_id\`         varchar(36)  NOT NULL,
        \`identity_pubkey\` varchar(100) NOT NULL COMMENT 'X25519 公钥 base64',
        \`created_at\`      datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\`      datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_user_keys_user_id\` (\`user_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='已废弃（V6.2 起改用 device_keys），此处仅为回滚重建空表'
    `);
  }

  private async hasTable(qr: QueryRunner, table: string): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await qr.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 设备级 identity 公钥表（V6.2 设备配对私密会话）。
 *
 * 替代 `user_keys`：
 *   - 旧表「一用户一行」，后登录设备上传会覆盖前一台，导致只有最后一台能解密；
 *   - 新表按 `(user_id, device_id)` 唯一，登录再多也互不影响。
 *
 * 只存公钥；私钥由客户端生成、仅存本地，服务端零接触。
 *
 * 幂等：information_schema 判断表是否存在。
 */
export class AddDeviceKeys1768200001000 implements MigrationInterface {
  name = 'AddDeviceKeys1768200001000';

  public async up(qr: QueryRunner): Promise<void> {
    if (await this.hasTable(qr, 'device_keys')) return;

    await qr.query(`
      CREATE TABLE \`device_keys\` (
        \`id\`              varchar(36)  NOT NULL,
        \`user_id\`         varchar(36)  NOT NULL,
        \`device_id\`       varchar(36)  NOT NULL COMMENT 'devices.id',
        \`identity_pubkey\` varchar(100) NOT NULL COMMENT 'X25519 公钥 base64（44 字符）',
        \`created_at\`      datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\`      datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_device_keys_user_device\` (\`user_id\`, \`device_id\`),
        KEY \`idx_device_keys_device\` (\`device_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='每台设备一把 X25519 identity 公钥（设备配对私密会话用）'
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    if (await this.hasTable(qr, 'device_keys')) {
      await qr.query('DROP TABLE `device_keys`');
    }
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

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 设备配对私密会话（Secret Chat）—— conversations 扩展。
 *
 * 设计要点：
 *  - `e2e_mode=1` 的会话归属于**一对设备**（e2e_device_a 发起 / e2e_device_b 接受），
 *    仅这两台设备可见；其余设备在会话列表里看不到。
 *  - 终止动作是**物理删除会话行**（见 E2E_SECRET_CHAT.md §7），
 *    因此这里不设 closed / rejected / expired 状态，也不加 closed_at / close_reason 之类字段
 *    —— 那些字段本身就是"曾经有过私密会话"的痕迹。
 *  - `e2e_pair_key` 是生成列：仅在 pending(1)/active(2) 时取值，
 *    配合唯一索引保证「同一对用户同时只能有一条进行中的私密会话」；
 *    行被删除后唯一约束自动释放，因此关闭后可立即重新发起。
 *
 * 幂等：information_schema 判断列/索引是否存在。
 */
export class AddSecretChatFields1768200000000 implements MigrationInterface {
  name = 'AddSecretChatFields1768200000000';

  public async up(qr: QueryRunner): Promise<void> {
    const cols: Array<[string, string]> = [
      ['e2e_mode', "tinyint NOT NULL DEFAULT 0 COMMENT '0=普通会话 1=设备配对私密会话'"],
      [
        'e2e_state',
        "tinyint NOT NULL DEFAULT 0 COMMENT '0=非私密 1=待接受 2=已激活（终止即删行，无 closed 状态）'",
      ],
      ['user_a', "varchar(36) NULL COMMENT '参与者1（较小 user_id）'"],
      ['user_b', "varchar(36) NULL COMMENT '参与者2（较大 user_id）'"],
      ['e2e_device_a', "varchar(36) NULL COMMENT '发起设备 devices.id'"],
      ['e2e_device_b', "varchar(36) NULL COMMENT '接受设备 devices.id'"],
    ];

    for (const [name, definition] of cols) {
      if (!(await this.hasColumn(qr, 'conversations', name))) {
        await qr.query(`ALTER TABLE \`conversations\` ADD COLUMN \`${name}\` ${definition}`);
      }
    }

    // 生成列 + 唯一约束：仅 pending/active 占用，删除行即释放
    if (!(await this.hasColumn(qr, 'conversations', 'e2e_pair_key'))) {
      await qr.query(`
        ALTER TABLE \`conversations\`
          ADD COLUMN \`e2e_pair_key\` varchar(80)
            GENERATED ALWAYS AS (
              CASE WHEN \`e2e_mode\` = 1 AND \`e2e_state\` IN (1, 2)
                   THEN CONCAT(LEAST(\`user_a\`, \`user_b\`), ':', GREATEST(\`user_a\`, \`user_b\`))
                   ELSE NULL END
            ) STORED COMMENT '同一对用户仅允许一个进行中的私密会话（NULL 不参与唯一性）'
      `);
    }

    if (!(await this.hasIndex(qr, 'conversations', 'uk_e2e_pair'))) {
      await qr.query('ALTER TABLE `conversations` ADD UNIQUE KEY `uk_e2e_pair` (`e2e_pair_key`)');
    }
    if (!(await this.hasIndex(qr, 'conversations', 'idx_e2e_state'))) {
      await qr.query('ALTER TABLE `conversations` ADD KEY `idx_e2e_state` (`e2e_mode`, `e2e_state`)');
    }
    if (!(await this.hasIndex(qr, 'conversations', 'idx_e2e_devices'))) {
      await qr.query(
        'ALTER TABLE `conversations` ADD KEY `idx_e2e_devices` (`e2e_device_a`, `e2e_device_b`)',
      );
    }
  }

  public async down(qr: QueryRunner): Promise<void> {
    for (const idx of ['uk_e2e_pair', 'idx_e2e_state', 'idx_e2e_devices']) {
      if (await this.hasIndex(qr, 'conversations', idx)) {
        await qr.query(`ALTER TABLE \`conversations\` DROP INDEX \`${idx}\``);
      }
    }
    for (const col of [
      'e2e_pair_key',
      'e2e_device_b',
      'e2e_device_a',
      'user_b',
      'user_a',
      'e2e_state',
      'e2e_mode',
    ]) {
      if (await this.hasColumn(qr, 'conversations', col)) {
        await qr.query(`ALTER TABLE \`conversations\` DROP COLUMN \`${col}\``);
      }
    }
  }

  private async hasColumn(qr: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await qr.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }

  private async hasIndex(qr: QueryRunner, table: string, index: string): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await qr.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, index],
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

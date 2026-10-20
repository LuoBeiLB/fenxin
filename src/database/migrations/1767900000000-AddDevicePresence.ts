import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 在线状态（V6.0）：给 devices 补"真实在线"所需的三个字段。
 *
 * 背景：`devices.is_online` 之前只在登录时置 true，从不置 false，
 * 也没有心跳接口 —— 管理端"在线设备/在线用户"指标必然失真，
 * 无法回答"这个人现在到底在不在线"。
 *
 * 新语义：
 *  - `socket_count`：当前活跃 WS 连接数（多标签页会 >1），连接/断开时 ±1；
 *  - `last_active_at`：客户端心跳刷新；
 *  - `online_at` / `offline_at`：上下线时间，供管理端展示"在线时长"。
 * 判定在线 = `is_online=1`，而 `is_online` 只在
 *   「socket_count>0」或「last_active_at 在 ONLINE_TTL_SECONDS 内」时为 true，
 *   由 PresenceScheduler 每分钟兜底清理过期在线态。
 *
 * 幂等：全部用 information_schema 判断。
 */
export class AddDevicePresence1767900000000 implements MigrationInterface {
  name = 'AddDevicePresence1767900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'devices', 'socket_count'))) {
      await queryRunner.query(
        "ALTER TABLE `devices` ADD COLUMN `socket_count` int NOT NULL DEFAULT 0 " +
          "COMMENT '当前活跃 WS 连接数（多标签页>1）' AFTER `is_online`",
      );
    }
    if (!(await this.hasColumn(queryRunner, 'devices', 'online_at'))) {
      await queryRunner.query(
        "ALTER TABLE `devices` ADD COLUMN `online_at` datetime NULL " +
          "COMMENT '本次上线时间' AFTER `socket_count`",
      );
    }
    if (!(await this.hasColumn(queryRunner, 'devices', 'offline_at'))) {
      await queryRunner.query(
        "ALTER TABLE `devices` ADD COLUMN `offline_at` datetime NULL " +
          "COMMENT '最近下线时间' AFTER `online_at`",
      );
    }
    if (!(await this.hasIndex(queryRunner, 'devices', 'idx_devices_online'))) {
      await queryRunner.query(
        'CREATE INDEX `idx_devices_online` ON `devices` (`is_online`, `last_active_at`)',
      );
    }

    // 存量修正：把历史上"登录即在线、永不置 false"的脏数据一律置为离线。
    // 之后由 WS 连接与心跳重新建立真实在线态（否则管理端会一直显示几十个"在线"）。
    await queryRunner.query(
      'UPDATE `devices` SET `is_online` = 0, `socket_count` = 0 WHERE `is_online` = 1',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasIndex(queryRunner, 'devices', 'idx_devices_online')) {
      await queryRunner.query('DROP INDEX `idx_devices_online` ON `devices`');
    }
    for (const col of ['offline_at', 'online_at', 'socket_count']) {
      if (await this.hasColumn(queryRunner, 'devices', col)) {
        await queryRunner.query(`ALTER TABLE \`devices\` DROP COLUMN \`${col}\``);
      }
    }
  }

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

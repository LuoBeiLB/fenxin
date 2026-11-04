import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * devices 表增加 UA 解析字段（登录时由服务端解析 User-Agent）。
 *
 * 背景：`device_name` / `device_type` 一直是**客户端自报**的，网页端与 APK 写法不统一
 * （现网真实数据里同时存在 "Web"/"web"、"MacBook Pro"/"desktop"、"Android App"/"mobile"）。
 * 管理端"登录设备"列表因此无法可靠展示"什么浏览器、什么系统"。
 *
 * 方案：登录时服务端解析 User-Agent，落库 5 个字段；
 *   · user_agent       原始 UA（排查问题用，超长截断到 512）
 *   · browser          Chrome / Safari / Edge / Firefox / WeChat / QQBrowser / UC ...
 *   · browser_version  浏览器版本（Chrome 冻结 UA 时只有大版本）
 *   · os               Windows / macOS / iOS / iPadOS / Android / HarmonyOS / Linux ...
 *   · os_version       系统版本
 * 客户端自报的 device_name 仍保留（作为"设备昵称"），不被覆盖。
 *
 * 存量数据：无法回溯（历史 UA 只在审计日志里），保持 NULL，前端回退显示 device_name。
 *
 * 幂等：information_schema 判断列是否存在。
 */
export class AddDeviceUaFields1768200004000 implements MigrationInterface {
  name = 'AddDeviceUaFields1768200004000';

  private readonly columns: Array<[string, string]> = [
    ['user_agent', "varchar(512) NULL COMMENT '登录时的原始 User-Agent（截断 512）'"],
    ['browser', "varchar(40) NULL COMMENT '解析出的浏览器：Chrome/Safari/Edge/Firefox/WeChat/...'"],
    ['browser_version', "varchar(20) NULL COMMENT '浏览器版本（Chrome UA 冻结时只有大版本）'"],
    ['os', "varchar(40) NULL COMMENT '解析出的系统：Windows/macOS/iOS/iPadOS/Android/HarmonyOS/...'"],
    ['os_version', "varchar(20) NULL COMMENT '系统版本'"],
  ];

  public async up(qr: QueryRunner): Promise<void> {
    for (const [name, definition] of this.columns) {
      if (!(await this.hasColumn(qr, 'devices', name))) {
        await qr.query(`ALTER TABLE \`devices\` ADD COLUMN \`${name}\` ${definition}`);
      }
    }
  }

  public async down(qr: QueryRunner): Promise<void> {
    for (const [name] of [...this.columns].reverse()) {
      if (await this.hasColumn(qr, 'devices', name)) {
        await qr.query(`ALTER TABLE \`devices\` DROP COLUMN \`${name}\``);
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
}

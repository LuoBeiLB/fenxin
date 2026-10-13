import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 音视频焚毁消息时长列（v5.8.9 播完才焚）。
 * 发送端上报语音/视频时长（秒），reveal 时计算消费窗口 max(ttl, 时长 + BURN_MEDIA_BUFFER_SECONDS)，
 * 防止「10s 焚毁设置导致 30s 视频没播完就被删」。
 * 老消息 NULL = 未上报，reveal 走 BURN_MEDIA_DEFAULT_WINDOW_SECONDS（默认 300s）兜底窗口。
 *
 * 迁移规范（2026-09-07 定稿）统一后第一个手写迁移：库变更只进本目录，
 * 部署固定走 npm run migration:run；FULLTEXT 等特殊 DDL 手写 queryRunner.query。
 *
 * 幂等（2026-10-13 加固）：用 information_schema 判断列是否已存在，重复执行不报错。
 * 必须如此的原因：用 DB_SYNC=true 建过表的库（开发库等）media_duration 列已由 synchronize
 * 建出，这类库首次跑 migration:run 会全量重放历史迁移，无守卫会以
 * "Duplicate column name 'media_duration'" 中断整个批次。
 */
export class AddMediaDuration1767600000000 implements MigrationInterface {
  name = 'AddMediaDuration1767600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.columnExists(queryRunner)) return; // 已存在（DB_SYNC 建过 / 重复执行）→ 幂等跳过
    await queryRunner.query(
      `ALTER TABLE \`messages\` ADD COLUMN \`media_duration\` int NULL COMMENT '音视频时长（秒），焚毁消费窗口计算用' AFTER \`file_original_url\``,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner))) return;
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`media_duration\``);
  }

  /** 查当前库 messages 是否已有 media_duration 列 */
  private async columnExists(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'messages'
          AND column_name = 'media_duration'`,
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

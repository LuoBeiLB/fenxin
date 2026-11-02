import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 补建 TypeORM 自己的元数据表 `typeorm_metadata`。
 *
 * 背景（2026-11-02 线上故障复盘）：
 *   本次新增了一条**数据库生成列** `conversations.e2e_pair_key`（见 1768200000000 迁移）。
 *   当 `DB_SYNC=true` 时，TypeORM 的 schema 同步会 loadTables 读到这个生成列，
 *   然后无条件执行：
 *
 *     SELECT * FROM `typeorm_metadata` `t`
 *      WHERE `type` = 'GENERATED_COLUMN' AND `name` = 'e2e_pair_key' ...
 *
 *   而 `typeorm_metadata` 表从来不存在（本项目只用迁移，从没触发过 TypeORM 建这张表），
 *   于是启动直接失败：`Table 'yy.typeorm_metadata' doesn't exist`，TypeOrmModule 无限重试。
 *
 * 为什么用迁移补建而不是让 TypeORM 自己建：
 *   TypeORM 只会在 `synchronize: true` **并且** 走到建元数据表那一步时才建，
 *   但它查询这张表发生在更早的 loadTables 阶段 —— 鸡生蛋问题，永远建不起来。
 *
 * 注意：
 *   - 这张表只是 TypeORM 的簿记表（记录视图/生成列的表达式），不含任何业务数据；
 *   - **建了它也仍然不应该开 `DB_SYNC=true`**（同步会删掉迁移创建的索引与生成列），
 *     这里只是保证"误开时不会启动失败"，避免排查困难；
 *   - 表结构与 TypeORM `RdbmsSchemaBuilder.createTypeormMetadataTable()` 完全一致。
 *
 * 幂等：information_schema 判断表是否存在。
 */
export class AddTypeormMetadata1768200003000 implements MigrationInterface {
  name = 'AddTypeormMetadata1768200003000';

  public async up(qr: QueryRunner): Promise<void> {
    if (!(await this.hasTable(qr, 'typeorm_metadata'))) {
      await qr.query(`
        CREATE TABLE \`typeorm_metadata\` (
          \`type\`     varchar(255) NOT NULL,
          \`database\` varchar(255) DEFAULT NULL,
          \`schema\`   varchar(255) DEFAULT NULL,
          \`table\`    varchar(255) DEFAULT NULL,
          \`name\`     varchar(255) DEFAULT NULL,
          \`value\`    text         NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          COMMENT='TypeORM 内部元数据表（视图/生成列表达式），不含业务数据'
      `);
    }

    // 把已存在的生成列登记进去（TypeORM 在 sync 模式下会按这张表比对表达式）。
    // 用 information_schema 读实际表达式，避免手写字符串与实际 DDL 不一致。
    // 单独放在建表 if 之外：表已存在（例如上一次执行中断）时也要能补齐登记。
    // 注意：别名不能用 table（MySQL 保留字）。
    const cols: Array<{ name: string; tbl: string }> = await qr.query(`
      SELECT column_name AS name, table_name AS tbl
        FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND generation_expression <> ''
    `);

    for (const col of cols) {
      const [row]: Array<{ expr: string }> = await qr.query(
        `SELECT generation_expression AS expr FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [col.tbl, col.name],
      );
      if (!row?.expr) continue;

      // 幂等：已登记则跳过（这张表没有唯一键）
      const [exists]: Array<{ c: number | string }> = await qr.query(
        `SELECT COUNT(*) AS c FROM \`typeorm_metadata\`
          WHERE \`type\` = 'GENERATED_COLUMN' AND \`schema\` = DATABASE()
            AND \`table\` = ? AND \`name\` = ?`,
        [col.tbl, col.name],
      );
      if (Number(exists?.[0]?.c ?? 0) > 0) continue;

      await qr.query(
        `INSERT INTO \`typeorm_metadata\` (\`type\`, \`database\`, \`schema\`, \`table\`, \`name\`, \`value\`)
         VALUES ('GENERATED_COLUMN', DATABASE(), DATABASE(), ?, ?, ?)`,
        [col.tbl, col.name, row.expr],
      );
    }
  }

  public async down(qr: QueryRunner): Promise<void> {
    if (await this.hasTable(qr, 'typeorm_metadata')) {
      await qr.query('DROP TABLE `typeorm_metadata`');
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

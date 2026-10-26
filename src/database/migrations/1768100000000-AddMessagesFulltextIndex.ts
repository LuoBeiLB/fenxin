import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 消息全局搜索所需的 FULLTEXT 索引（v5.8.5 的功能，之前只写在文档里要求"手工执行"，
 * 导致新环境/漏执行的环境一调 `GET /messages/search` 就 500：
 * `Can't find FULLTEXT index matching the column list`）。
 *
 * 本次把它纳入迁移链，`migration:run` 会自动补上，不再依赖人工。
 *
 * 索引定义必须与代码里的 MATCH 列清单**完全一致**：
 *   MATCH(m.content, m.file_name) AGAINST (...)
 *   → ft_messages_search (content, file_name) WITH PARSER ngram
 * 少一列、换顺序、换解析器都会继续报同样的错。
 *
 * 为什么需要 ngram：MySQL 默认分词按空格，中文整句会被当成一个词；
 * ngram 按 N 元切分（默认 ngram_token_size=2），中文才能被搜到。
 *
 * 幂等：先查 information_schema.statistics 是否已有同名索引；
 * MySQL 8 不支持 `ADD FULLTEXT IF NOT EXISTS`，所以只能这样判断。
 *
 * 性能：InnoDB 加 FULLTEXT 索引是 ONLINE DDL（INPLACE + 允许并发 DML），
 * 但大表仍会消耗 IO 与磁盘，建议低峰执行；messages 很大时用
 * `ALTER ... ALGORITHM=INPLACE, LOCK=NONE` 观察进度。
 */
export class AddMessagesFulltextIndex1768100000000 implements MigrationInterface {
  name = 'AddMessagesFulltextIndex1768100000000';

  private static readonly INDEX = 'ft_messages_search';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasIndex(queryRunner)) return;

    // MySQL 8 自带 ngram 解析器；极少数精简安装没有该插件，
    // 此时退回普通 FULLTEXT（中文搜索会失效，但至少不会再 500）。
    try {
      await queryRunner.query(
        `ALTER TABLE \`messages\`
           ADD FULLTEXT INDEX \`${AddMessagesFulltextIndex1768100000000.INDEX}\`
             (\`content\`, \`file_name\`) WITH PARSER ngram`,
      );
    } catch (err: any) {
      const msg = String(err?.message || err);
      const parserMissing = /parser|1126|Unknown/i.test(msg);
      if (!parserMissing) throw err;

      await queryRunner.query(
        `ALTER TABLE \`messages\`
           ADD FULLTEXT INDEX \`${AddMessagesFulltextIndex1768100000000.INDEX}\`
             (\`content\`, \`file_name\`)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasIndex(queryRunner))) return;
    await queryRunner.query(
      `ALTER TABLE \`messages\` DROP INDEX \`${AddMessagesFulltextIndex1768100000000.INDEX}\``,
    );
  }

  private async hasIndex(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ cnt: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'messages'
          AND index_name = ?`,
      [AddMessagesFulltextIndex1768100000000.INDEX],
    );
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * App 版本发布表迁移（V5.8 App 自更新）。
 * 管理后台发版时落一条记录；App 端 GET /app-versions/latest 比对 version_code
 * 判断是否提示更新；发布时 WS 广播 app:update。
 *
 * 字段：id / version_code（唯一，全局递增整数）/ version_name / apk_url /
 *       file_size / force / notes / published / created_by / created_at / updated_at
 * 生产环境（DB_SYNC=false）执行：npm run migration:run
 */
export class AddAppVersions1767300000000 implements MigrationInterface {
  name = 'AddAppVersions1767300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`app_versions\` (
        \`id\` varchar(36) NOT NULL,
        \`platform\` varchar(20) NOT NULL DEFAULT 'android' COMMENT '平台 android/ios',
        \`version_code\` int NOT NULL COMMENT 'versionCode/build number，同平台内递增整数',
        \`version_name\` varchar(20) NOT NULL COMMENT '展示用版本名，如 5.8',
        \`apk_url\` varchar(500) NOT NULL COMMENT '安装包下载地址 /uploads/app/xxx.apk',
        \`file_size\` int NOT NULL DEFAULT 0 COMMENT '安装包字节数',
        \`force\` tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否强制更新',
        \`notes\` text NOT NULL COMMENT '更新说明',
        \`published\` tinyint(1) NOT NULL DEFAULT 1 COMMENT '发布状态 0=撤回',
        \`created_by\` varchar(36) NOT NULL COMMENT '发布管理员 ID',
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_app_versions_platform_code\` (\`platform\`, \`version_code\`),
        KEY \`idx_app_versions_created_by\` (\`created_by\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE \`app_versions\``);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AppUser } from '../../entities/app-user.entity';
import { Message } from '../../entities/message.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Device } from '../../entities/device.entity';

@Injectable()
export class StatsService {
  private readonly logger = new Logger('Stats');

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Dashboard 概览指标。
   * - total_users：未删除账号总数
   * - today_active_users：今日活跃用户数（今日登录过的设备所属用户 ∪ 今日发过消息的用户，去重）
   * - today_messages：今日消息量（含已焚毁前的历史计数，仅按 messages 表现存行统计）
   * - storage：上传目录磁盘占用 + 数据库数据占用
   */
  async getOverview() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const userRepo = this.dataSource.getRepository(AppUser);
    const msgRepo = this.dataSource.getRepository(Message);
    const convRepo = this.dataSource.getRepository(Conversation);
    const deviceRepo = this.dataSource.getRepository(Device);

    const [
      totalUsers,
      disabledUsers,
      deletedUsers,
      todayMessages,
      totalMessages,
      totalConversations,
      totalGroups,
      onlineDevices,
    ] = await Promise.all([
      userRepo.createQueryBuilder('u').where('u.deleted_at IS NULL').getCount(),
      userRepo
        .createQueryBuilder('u')
        .where('u.deleted_at IS NULL')
        .andWhere('u.status = :s', { s: 'disabled' })
        .getCount(),
      userRepo.createQueryBuilder('u').where('u.deleted_at IS NOT NULL').getCount(),
      msgRepo.createQueryBuilder('m').where('m.created_at >= :todayStart', { todayStart }).getCount(),
      msgRepo.count(),
      convRepo.createQueryBuilder('c').where('c.dissolved_at IS NULL').getCount(),
      convRepo
        .createQueryBuilder('c')
        .where("c.type = 'group'")
        .andWhere('c.dissolved_at IS NULL')
        .getCount(),
      deviceRepo.createQueryBuilder('d').where('d.is_online = :o', { o: true }).getCount(),
    ]);

    // 今日活跃：今日登录（device.last_active_at）∪ 今日发言（messages.sender_id），原生 SQL 一次去重统计
    const activeRows = await this.dataSource.query(
      `SELECT COUNT(DISTINCT uid) AS cnt FROM (
         SELECT user_id AS uid FROM devices WHERE last_active_at >= ?
         UNION
         SELECT sender_id AS uid FROM messages WHERE created_at >= ?
       ) t`,
      [todayStart, todayStart],
    );
    const todayActiveUsers = Number(activeRows?.[0]?.cnt ?? 0);

    // 数据库占用（当前库的 data_length + index_length）
    const dbName = this.dataSource.options.database as string;
    let dbBytes = 0;
    try {
      const rows = await this.dataSource.query(
        `SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes
           FROM information_schema.tables WHERE table_schema = ?`,
        [dbName],
      );
      dbBytes = Number(rows?.[0]?.bytes ?? 0);
    } catch (err) {
      this.logger.warn(`查询数据库占用失败: ${(err as Error)?.message}`);
    }

    // 上传目录磁盘占用（递归求和；目录不存在按 0 处理）
    const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
    const upload = this.dirSize(uploadDir);

    return {
      total_users: totalUsers,
      disabled_users: disabledUsers,
      deleted_users: deletedUsers,
      today_active_users: todayActiveUsers,
      today_messages: todayMessages,
      total_messages: totalMessages,
      total_conversations: totalConversations,
      total_groups: totalGroups,
      online_devices: onlineDevices,
      storage: {
        upload_bytes: upload.bytes,
        upload_files: upload.files,
        db_bytes: dbBytes,
        total_bytes: upload.bytes + dbBytes,
      },
      generated_at: new Date().toISOString(),
    };
  }

  private dirSize(dir: string): { bytes: number; files: number } {
    let bytes = 0;
    let files = 0;
    try {
      if (!fs.existsSync(dir)) return { bytes, files };
      const walk = (p: string) => {
        for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
          const full = path.join(p, entry.name);
          try {
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
              files += 1;
              bytes += fs.statSync(full).size;
            }
          } catch {
            /* 单个文件读取失败不影响整体统计 */
          }
        }
      };
      walk(dir);
    } catch (err) {
      this.logger.warn(`统计上传目录失败: ${(err as Error)?.message}`);
    }
    return { bytes, files };
  }
}

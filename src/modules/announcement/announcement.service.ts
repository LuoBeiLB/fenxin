import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Announcement } from '../../entities/announcement.entity';
import { AnnouncementRead } from '../../entities/announcement-read.entity';
import { AppUser } from '../../entities/app-user.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class AnnouncementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
  ) {}

  /** 解析公告的部门定向名单（JSON 数组字符串 → string[]） */
  private parseDepartments(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((d) => typeof d === 'string') : [];
    } catch {
      return [];
    }
  }

  /** 当前用户是否可见该公告：全员公告人人可见；部门公告要求用户部门在定向名单内 */
  private isVisibleTo(ann: Announcement, user: AppUser): boolean {
    if (ann.target_type === 'all') return true;
    const deps = this.parseDepartments(ann.target_departments);
    return !!user.department && deps.includes(user.department);
  }

  /** 计算公告目标用户 ID 列表（仅未删除账号；urgent 推送用） */
  private async resolveTargetUserIds(ann: Announcement): Promise<string[]> {
    const userRepo = this.dataSource.getRepository(AppUser);
    const qb = userRepo
      .createQueryBuilder('u')
      .select(['u.id', 'u.department'])
      .where('u.deleted_at IS NULL')
      .andWhere("u.status = 'active'");
    if (ann.target_type === 'department') {
      const deps = this.parseDepartments(ann.target_departments);
      if (deps.length === 0) return [];
      qb.andWhere('u.department IN (:...deps)', { deps });
    }
    const users = await qb.getMany();
    return users.map((u) => u.id);
  }

  /** 管理员发布公告。urgent 公告额外走 WebSocket 实时推送到目标用户全部在线设备 */
  async createAnnouncement(params: {
    title: string;
    content: string;
    priority: 'normal' | 'urgent';
    target_type: 'all' | 'department';
    target_departments?: string[];
    operatorId: string;
    ip?: string;
  }) {
    if (params.target_type === 'department' && (!params.target_departments || params.target_departments.length === 0)) {
      throw new BadRequestException('按部门发布公告时 target_departments 不能为空');
    }

    const annRepo = this.dataSource.getRepository(Announcement);
    const saved = await annRepo.save(
      annRepo.create({
        title: params.title,
        content: params.content,
        priority: params.priority,
        target_type: params.target_type,
        target_departments:
          params.target_type === 'department' ? JSON.stringify(params.target_departments ?? []) : null,
        created_by: params.operatorId,
      }),
    );

    // 紧急公告：实时弹窗推送（普通公告仅进公告中心，不打扰）
    if (saved.priority === 'urgent') {
      const targetUserIds = await this.resolveTargetUserIds(saved);
      this.events.emitToUsers(WS_EVENTS.ANNOUNCEMENT_NEW, targetUserIds, {
        id: saved.id,
        title: saved.title,
        content: saved.content,
        priority: saved.priority,
        created_at: saved.created_at.toISOString(),
      });
    }

    await this.audit.log({
      userId: params.operatorId,
      action: 'publish_announcement',
      targetType: 'announcement',
      targetId: saved.id,
      detail: `Published ${saved.priority} announcement "${saved.title}" (target=${saved.target_type})`,
      ipAddress: params.ip,
    });

    return saved;
  }

  /** 用户端：我可见的公告列表（含已读标记），按发布时间倒序分页 */
  async listMyAnnouncements(userId: string, page = 1, pageSize = 20) {
    const user = await this.dataSource.getRepository(AppUser).findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('账号不存在');

    const annRepo = this.dataSource.getRepository(Announcement);
    // 全员公告 + 定向到本部门的公告。数据量不大，先查全部再在内存过滤分页，
    // 避免把 JSON 数组匹配写进 SQL（可读性/正确性更稳）。
    const all = await annRepo.find({ order: { created_at: 'DESC' } });
    const visible = all.filter((a) => this.isVisibleTo(a, user));

    const total = visible.length;
    const slice = visible.slice((page - 1) * pageSize, page * pageSize);

    const reads = slice.length
      ? await this.dataSource.getRepository(AnnouncementRead).find({
          where: { user_id: userId, announcement_id: In(slice.map((a) => a.id)) },
        })
      : [];
    const readSet = new Set(reads.map((r) => r.announcement_id));

    const data = slice.map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      priority: a.priority,
      target_type: a.target_type,
      is_read: readSet.has(a.id),
      created_at: a.created_at,
    }));

    return { data, total };
  }

  /** 用户端：未读公告数（公告中心角标） */
  async unreadCount(userId: string): Promise<{ unread: number }> {
    const user = await this.dataSource.getRepository(AppUser).findOne({ where: { id: userId } });
    if (!user) return { unread: 0 };

    const all = await this.dataSource.getRepository(Announcement).find({ select: ['id', 'target_type', 'target_departments'] });
    const visibleIds = all.filter((a) => this.isVisibleTo(a as Announcement, user)).map((a) => a.id);
    if (visibleIds.length === 0) return { unread: 0 };

    const readCount = await this.dataSource
      .getRepository(AnnouncementRead)
      .createQueryBuilder('r')
      .where('r.user_id = :userId', { userId })
      .andWhere('r.announcement_id IN (:...ids)', { ids: visibleIds })
      .getCount();

    return { unread: visibleIds.length - readCount };
  }

  /** 用户端：标记已读（幂等，唯一约束冲突时忽略） */
  async markRead(announcementId: string, userId: string) {
    const ann = await this.dataSource.getRepository(Announcement).findOne({ where: { id: announcementId } });
    if (!ann) throw new NotFoundException('公告不存在');

    const readRepo = this.dataSource.getRepository(AnnouncementRead);
    const existing = await readRepo.findOne({ where: { announcement_id: announcementId, user_id: userId } });
    if (!existing) {
      await readRepo
        .save(readRepo.create({ announcement_id: announcementId, user_id: userId }))
        .catch(() => undefined); // 并发重复标记时唯一约束报错，直接吞掉保持幂等
    }
  }

  /** 管理端：全部公告列表（含阅读人数统计），倒序分页 */
  async adminList(page = 1, pageSize = 20) {
    const annRepo = this.dataSource.getRepository(Announcement);
    const [rows, total] = await annRepo.findAndCount({
      order: { created_at: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const readRepo = this.dataSource.getRepository(AnnouncementRead);
    const data = await Promise.all(
      rows.map(async (a) => ({
        ...a,
        target_departments: this.parseDepartments(a.target_departments),
        read_count: await readRepo.count({ where: { announcement_id: a.id } }),
      })),
    );

    return { data, total };
  }

  /** 管理端：删除公告（连同已读记录），操作留痕 */
  async deleteAnnouncement(announcementId: string, operatorId: string, ip?: string) {
    const annRepo = this.dataSource.getRepository(Announcement);
    const ann = await annRepo.findOne({ where: { id: announcementId } });
    if (!ann) throw new NotFoundException('公告不存在');

    await this.dataSource.getRepository(AnnouncementRead).delete({ announcement_id: announcementId });
    await annRepo.delete({ id: announcementId });

    await this.audit.log({
      userId: operatorId,
      action: 'delete_announcement',
      targetType: 'announcement',
      targetId: announcementId,
      detail: `Deleted announcement "${ann.title}"`,
      ipAddress: ip,
    });
  }
}

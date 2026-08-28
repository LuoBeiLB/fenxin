import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Feedback, FeedbackStatus } from '../../entities/feedback.entity';
import { AppUser, sanitizeUser } from '../../entities/app-user.entity';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class FeedbackService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** 用户提交意见反馈 */
  async submit(params: { userId: string; content: string; contact?: string; ip?: string }) {
    const repo = this.dataSource.getRepository(Feedback);
    const saved = await repo.save({
      user_id: params.userId,
      content: params.content,
      contact: params.contact ?? null,
      status: 'pending' as FeedbackStatus,
      admin_reply: null,
      replied_by: null,
      replied_at: null,
    });

    await this.audit.log({
      userId: params.userId,
      action: 'submit_feedback',
      targetType: 'feedback',
      targetId: saved.id,
      detail: `Submitted feedback (len=${params.content.length})`,
      ipAddress: params.ip,
    });

    return { id: saved.id, created_at: saved.created_at };
  }

  /** 用户端：我的反馈列表（含管理员回复），倒序分页 */
  async listMy(userId: string, page = 1, pageSize = 20) {
    const repo = this.dataSource.getRepository(Feedback);
    const [data, total] = await repo.findAndCount({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { data, total };
  }

  /** 管理端：全量反馈列表（附提交人显示名/部门），可按状态筛选，倒序分页 */
  async adminList(params: { page?: number; pageSize?: number; status?: FeedbackStatus }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const repo = this.dataSource.getRepository(Feedback);
    const [rows, total] = await repo.findAndCount({
      where: params.status ? { status: params.status } : {},
      order: { created_at: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    // 批量取提交人信息（避免逐条查询）
    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const users = userIds.length
      ? await this.dataSource.getRepository(AppUser).find({ where: { id: In(userIds) } })
      : [];
    const userMap = new Map(users.map((u) => [u.id, sanitizeUser(u)]));

    const data = rows.map((r) => {
      const u = userMap.get(r.user_id);
      return {
        ...r,
        user_display_name: u?.display_name || 'Unknown',
        user_department: u?.department ?? null,
      };
    });
    return { data, total };
  }

  /** 管理端：回复反馈（回复即处理，状态置为 processed），操作留痕 */
  async reply(params: { feedbackId: string; reply: string; operatorId: string; ip?: string }) {
    const repo = this.dataSource.getRepository(Feedback);
    const fb = await repo.findOne({ where: { id: params.feedbackId } });
    if (!fb) throw new NotFoundException('反馈不存在');

    await repo.update(fb.id, {
      admin_reply: params.reply,
      replied_by: params.operatorId,
      replied_at: new Date(),
      status: 'processed',
    });

    await this.audit.log({
      userId: params.operatorId,
      action: 'reply_feedback',
      targetType: 'feedback',
      targetId: fb.id,
      detail: `Replied to feedback from user ${fb.user_id}`,
      ipAddress: params.ip,
    });

    return repo.findOne({ where: { id: fb.id } });
  }
}

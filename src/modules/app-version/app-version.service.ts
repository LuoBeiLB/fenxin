import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AppVersion } from '../../entities/app-version.entity';
import { AppUser } from '../../entities/app-user.entity';
import { EventsGateway } from '../events/events.gateway';
import { WS_EVENTS } from '../events/events.types';
import { AuditService } from '../audit/audit.service';
import { CreateAppVersionDto, UpdateAppVersionDto, AppPlatform } from './dto';

/** APK 上传体积上限：50MB（Capacitor 套壳 APK 实际 10~25MB，与附件限额一致，nginx 60m 配置无需调整） */
const APK_MAX_SIZE = 50 * 1024 * 1024;

/**
 * App 版本发布服务（V5.8 App 自更新）。
 *
 * 发布链路：管理员上传 APK（multipart）→ 校验扩展名 / version_code 递增 →
 * 文件落到 UPLOAD_DIR/app/ → 落库（published=true）→ WS 广播 app:update
 * 给全部在线用户 → 审计留痕。
 */
@Injectable()
export class AppVersionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
  ) {}

  /** APK 存放子目录：UPLOAD_DIR/app/（经 ServeStaticModule 以 /uploads/app/ 前缀静态可下载） */
  private apkDir(): string {
    return path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads', 'app');
  }

  /** 用户端：指定平台的最新已发布版本。currentCode 传入且已是最新的返回 null（无更新） */
  async latestForClient(platform: AppPlatform, currentCode?: number) {
    const repo = this.dataSource.getRepository(AppVersion);
    const latest = await repo.findOne({
      where: { published: true, platform },
      order: { version_code: 'DESC' },
    });
    if (!latest) return null;
    if (currentCode !== undefined && currentCode !== null && currentCode >= latest.version_code) {
      return null;
    }
    return {
      platform: latest.platform,
      version_code: latest.version_code,
      version_name: latest.version_name,
      apk_url: latest.apk_url,
      file_size: latest.file_size,
      force: !!latest.force,
      notes: latest.notes,
      published_at: latest.created_at,
    };
  }

  /** 管理端：发布新版本（multipart 上传 APK + 版本信息），成功后 WS 广播 */
  async publishVersion(params: {
    file: Express.Multer.File;
    dto: CreateAppVersionDto;
    operatorId: string;
    ip?: string;
  }): Promise<AppVersion> {
    const { file, dto, operatorId, ip } = params;
    // 1. 文件校验：只认扩展名（APK 的 mimetype 五花八门，application/octet-stream 也常见，不可靠）
    if (!file) throw new BadRequestException('未接收到 APK 文件');
    if (!/^\.apk$/i.test(path.extname(file.originalname))) {
      this.safeUnlink(file.path);
      throw new BadRequestException('仅支持上传 .apk 文件');
    }
    if (file.size > APK_MAX_SIZE) {
      this.safeUnlink(file.path);
      throw new BadRequestException('APK 体积超过 50MB 上限');
    }

    // 2. version_code 必须在该平台内全局递增（含未发布/已撤回的历史记录）
    const repo = this.dataSource.getRepository(AppVersion);
    const platform: AppPlatform = dto.platform ?? 'android';
    const maxRow = await repo.findOne({ where: { platform }, order: { version_code: 'DESC' } });
    const maxCode = maxRow ? maxRow.version_code : 0;
    if (dto.version_code <= maxCode) {
      this.safeUnlink(file.path);
      throw new BadRequestException(
        `version_code 必须大于 ${platform} 平台当前最大值 ${maxCode}（versionCode 需在同平台内全局递增）`,
      );
    }

    // 3. 文件从 multer 临时名改成带版本号的正式名（可读、可追溯）
    fs.mkdirSync(this.apkDir(), { recursive: true });
    const shortId = (file.filename || '').split('-')[0] || Date.now().toString(36);
    const finalName = `fenxin-${platform}-v${dto.version_name}-${shortId}.apk`;
    const finalPath = path.join(this.apkDir(), finalName);
    try {
      fs.renameSync(file.path, finalPath);
    } catch (err: any) {
      this.safeUnlink(file.path);
      throw new BadRequestException(`APK 落盘失败：${err?.message || 'unknown'}`);
    }

    // 4. 落库（失败时清理已落盘文件，避免磁盘残留）
    let saved: AppVersion;
    try {
      saved = await repo.save(
        repo.create({
          platform,
          version_code: dto.version_code,
          version_name: dto.version_name,
          apk_url: `/uploads/app/${finalName}`,
          file_size: file.size,
          force: dto.force ?? false,
          notes: dto.notes ?? '',
          published: true,
          created_by: operatorId,
        }),
      );
    } catch (err: any) {
      this.safeUnlink(finalPath);
      throw new BadRequestException(`版本记录保存失败：${err?.message || 'unknown'}`);
    }

    // 5. 实时广播给全部在线用户（离线用户下次启动走 latest 接口兜底）
    await this.broadcastUpdate(saved);

    await this.audit.log({
      userId: operatorId,
      action: 'publish_app_version',
      targetType: 'app_version',
      targetId: saved.id,
      detail: `Published APK v${saved.version_name} (code=${saved.version_code}, force=${!!saved.force})`,
      ipAddress: ip,
    });

    return saved;
  }

  /** 管理端：版本列表（倒序分页） */
  async adminList(page = 1, pageSize = 20) {
    const repo = this.dataSource.getRepository(AppVersion);
    const [data, total] = await repo.findAndCount({
      order: { version_code: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { data, total };
  }

  /** 管理端：修改版本（force / notes / published）。撤回恢复或强更开关变化时重新广播 */
  async updateVersion(id: string, dto: UpdateAppVersionDto, operatorId: string, ip?: string) {
    const repo = this.dataSource.getRepository(AppVersion);
    const existing = await repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('版本记录不存在');

    const forceChanged = dto.force !== undefined && !!dto.force !== !!existing.force;
    const republished = dto.published === true && existing.published !== true;

    const updated = await repo.save(
      repo.merge(existing, {
        ...(dto.force !== undefined ? { force: dto.force } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.published !== undefined ? { published: dto.published } : {}),
      }),
    );

    // 恢复发布、或已发布版本的强更开关变化 → 重新广播，让在线客户端立即感知
    if (updated.published && (republished || forceChanged)) {
      await this.broadcastUpdate(updated);
    }

    await this.audit.log({
      userId: operatorId,
      action: 'update_app_version',
      targetType: 'app_version',
      targetId: updated.id,
      detail: `Updated APK v${updated.version_name} (force=${!!updated.force}, published=${!!updated.published})`,
      ipAddress: ip,
    });

    return updated;
  }

  /** 管理端：删除版本记录。物理 APK 文件保留（已推送给用户的下载链接不立即失效） */
  async deleteVersion(id: string, operatorId: string, ip?: string) {
    const repo = this.dataSource.getRepository(AppVersion);
    const existing = await repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('版本记录不存在');

    await repo.delete({ id });

    await this.audit.log({
      userId: operatorId,
      action: 'delete_app_version',
      targetType: 'app_version',
      targetId: id,
      detail: `Deleted APK record v${existing.version_name} (code=${existing.version_code}), file kept on disk`,
      ipAddress: ip,
    });
  }

  /** 广播 app:update 给全部活跃账号（照搬紧急公告的推送范围口径） */
  private async broadcastUpdate(v: AppVersion): Promise<void> {
    const userRepo = this.dataSource.getRepository(AppUser);
    const users = await userRepo
      .createQueryBuilder('u')
      .select(['u.id'])
      .where('u.deleted_at IS NULL')
      .andWhere("u.status = 'active'")
      .getMany();
    const userIds = users.map((u) => u.id);

    this.events.emitToUsers(WS_EVENTS.APP_UPDATE, userIds, {
      platform: v.platform,
      version_code: v.version_code,
      version_name: v.version_name,
      apk_url: v.apk_url,
      file_size: v.file_size,
      force: !!v.force,
      notes: v.notes,
      published_at: v.created_at.toISOString(),
    });
  }

  /** 删除文件失败只记日志不抛错（不影响主流程） */
  private safeUnlink(p: string): void {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

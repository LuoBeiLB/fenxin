import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppVersionService } from 'src/modules/app-version/app-version.service';
import { AppVersion } from 'src/entities/app-version.entity';
import { AppUser } from 'src/entities/app-user.entity';
import { EventsGateway } from 'src/modules/events/events.gateway';
import { AuditService } from 'src/modules/audit/audit.service';
import * as fs from 'fs';

/**
 * App 版本服务单测（V5.8）。
 * 覆盖：latest 比对逻辑 / 发版校验（扩展名、version_code 递增、失败清理）/
 * WS 广播时机（发布、恢复发布、强更切换；纯改 notes 不广播）/ 删除留痕。
 */

const makeAppVersionRepo = () => ({
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  save: jest.fn((x: any) => x),
  create: jest.fn((x: any) => x),
  merge: jest.fn((...args: any[]) => Object.assign({}, ...args)),
  delete: jest.fn(),
});

describe('AppVersionService', () => {
  let service: AppVersionService;
  let versionRepo: ReturnType<typeof makeAppVersionRepo>;
  let events: { emitToUsers: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(() => {
    jest.restoreAllMocks();

    versionRepo = makeAppVersionRepo();
    const userRepo = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]),
      })),
    };
    const dataSource = {
      getRepository: jest.fn((entity: any) => (entity === AppUser ? userRepo : versionRepo)),
    } as unknown as DataSource;

    events = { emitToUsers: jest.fn() };
    audit = { log: jest.fn() };

    service = new AppVersionService(
      dataSource,
      events as unknown as EventsGateway,
      audit as unknown as AuditService,
    );

    // fs mock：rename/unlink/mkdir 全部假成功
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    jest.spyOn(fs, 'renameSync').mockImplementation(() => undefined);
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
  });

  describe('latestForClient', () => {
    it('该平台无任何已发布版本时返回 null', async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(service.latestForClient('android')).resolves.toBeNull();
    });

    it('未传 current_code 时返回该平台最新已发布版本', async () => {
      versionRepo.findOne.mockResolvedValue({
        platform: 'android',
        version_code: 58,
        version_name: '5.8',
        apk_url: '/uploads/app/a.apk',
        file_size: 100,
        force: 1,
        notes: '修复若干问题',
        created_at: new Date('2026-09-01T10:00:00Z'),
      });
      const res = await service.latestForClient('android');
      expect(res).toMatchObject({ platform: 'android', version_code: 58, version_name: '5.8', force: true });
    });

    it('current_code 已是最新时返回 null（不弹无意义提示）', async () => {
      versionRepo.findOne.mockResolvedValue({ platform: 'android', version_code: 58, created_at: new Date() });
      await expect(service.latestForClient('android', 58)).resolves.toBeNull();
      await expect(service.latestForClient('android', 59)).resolves.toBeNull();
    });

    it('current_code 落后时返回新版本信息', async () => {
      versionRepo.findOne.mockResolvedValue({
        platform: 'android',
        version_code: 58,
        version_name: '5.8',
        apk_url: '/uploads/app/a.apk',
        file_size: 100,
        force: 0,
        notes: '',
        created_at: new Date('2026-09-01T10:00:00Z'),
      });
      const res = await service.latestForClient('android', 57);
      expect(res).toMatchObject({ version_code: 58, force: false });
    });
  });

  describe('publishVersion', () => {
    const baseFile = {
      originalname: 'fenxin-release.apk',
      path: '/tmp/tmp-upload-123.apk',
      size: 20 * 1024 * 1024,
      filename: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    } as Express.Multer.File;

    it('非 .apk 文件直接拒绝并清理临时文件', async () => {
      await expect(
        service.publishVersion({
          file: { ...baseFile, originalname: 'evil.exe' },
          dto: { version_name: '5.8', version_code: 58 },
          operatorId: 'admin-1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(fs.unlinkSync).toHaveBeenCalled();
      expect(versionRepo.save).not.toHaveBeenCalled();
    });

    it('version_code 未递增时拒绝并清理临时文件', async () => {
      versionRepo.findOne.mockResolvedValue({ platform: 'android', version_code: 58 });
      await expect(
        service.publishVersion({
          file: baseFile,
          dto: { version_name: '5.9', version_code: 58 },
          operatorId: 'admin-1',
        }),
      ).rejects.toThrow('version_code 必须大于 android 平台当前最大值 58');
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('跨平台互不影响：android 已到 58，ios 首发 58 可发布', async () => {
      versionRepo.findOne.mockImplementation(async (opts: any) =>
        opts?.where?.platform === 'ios' ? null : { platform: 'android', version_code: 58 },
      );
      versionRepo.save.mockResolvedValue({
        id: 'v-ios',
        platform: 'ios',
        version_code: 58,
        version_name: '5.8',
        apk_url: '/uploads/app/fenxin-ios-v5.8-a1b2c3d4.apk',
        file_size: baseFile.size,
        force: 0,
        notes: '',
        published: 1,
        created_at: new Date('2026-09-01T10:00:00Z'),
      });

      const saved = await service.publishVersion({
        file: baseFile,
        dto: { version_name: '5.8', version_code: 58, platform: 'ios' },
        operatorId: 'admin-1',
      });

      expect(saved.platform).toBe('ios');
      expect(events.emitToUsers).toHaveBeenCalledWith(
        'app:update',
        ['u1', 'u2'],
        expect.objectContaining({ platform: 'ios', version_code: 58 }),
      );
    });

    it('发布成功：落库 + WS 广播 app:update + 审计留痕', async () => {
      versionRepo.findOne.mockResolvedValue(null); // 无历史版本
      versionRepo.save.mockResolvedValue({
        id: 'v-new',
        platform: 'android',
        version_code: 58,
        version_name: '5.8',
        apk_url: '/uploads/app/fenxin-android-v5.8-a1b2c3d4.apk',
        file_size: baseFile.size,
        force: 0,
        notes: '首发',
        published: 1,
        created_at: new Date('2026-09-01T10:00:00Z'),
      });

      const saved = await service.publishVersion({
        file: baseFile,
        dto: { version_name: '5.8', version_code: 58, force: false, notes: '首发' },
        operatorId: 'admin-1',
        ip: '1.2.3.4',
      });

      expect(saved.version_code).toBe(58);
      expect(fs.renameSync).toHaveBeenCalled(); // 临时文件改名为带版本号正式名
      expect(events.emitToUsers).toHaveBeenCalledWith(
        'app:update',
        ['u1', 'u2'],
        expect.objectContaining({ platform: 'android', version_code: 58, version_name: '5.8', force: false }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'publish_app_version', ipAddress: '1.2.3.4' }),
      );
    });

    it('落库失败时清理已 rename 的正式文件', async () => {
      versionRepo.findOne.mockResolvedValue(null);
      versionRepo.save.mockRejectedValue(new Error('db down'));

      await expect(
        service.publishVersion({
          file: baseFile,
          dto: { version_name: '5.8', version_code: 58 },
          operatorId: 'admin-1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(fs.unlinkSync).toHaveBeenCalled();
      expect(events.emitToUsers).not.toHaveBeenCalled();
    });
  });

  describe('updateVersion', () => {
    const existing = {
      id: 'v1',
      version_code: 58,
      version_name: '5.8',
      force: 0,
      notes: '旧说明',
      published: 0,
      created_at: new Date('2026-09-01T10:00:00Z'),
    };

    it('记录不存在时抛 404', async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(service.updateVersion('nope', { force: true }, 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('撤回 → 恢复发布（published false→true）触发广播', async () => {
      versionRepo.findOne.mockResolvedValue({ ...existing });
      versionRepo.save.mockImplementation(async (x: any) => x);

      await service.updateVersion('v1', { published: true }, 'admin-1');

      expect(events.emitToUsers).toHaveBeenCalledWith(
        'app:update',
        ['u1', 'u2'],
        expect.objectContaining({ version_code: 58 }),
      );
    });

    it('已发布版本切换强更开关触发广播', async () => {
      versionRepo.findOne.mockResolvedValue({ ...existing, published: 1 });
      versionRepo.save.mockImplementation(async (x: any) => x);

      await service.updateVersion('v1', { force: true }, 'admin-1');

      expect(events.emitToUsers).toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'update_app_version' }),
      );
    });

    it('仅修改 notes 不广播（避免打扰在线用户）', async () => {
      versionRepo.findOne.mockResolvedValue({ ...existing, published: 1 });
      versionRepo.save.mockImplementation(async (x: any) => x);

      await service.updateVersion('v1', { notes: '改文案' }, 'admin-1');

      expect(events.emitToUsers).not.toHaveBeenCalled();
    });
  });

  describe('deleteVersion', () => {
    it('删除记录 + 审计留痕（磁盘 APK 文件保留）', async () => {
      versionRepo.findOne.mockResolvedValue({
        id: 'v1',
        version_code: 58,
        version_name: '5.8',
      });

      await service.deleteVersion('v1', 'admin-1', '1.2.3.4');

      expect(versionRepo.delete).toHaveBeenCalledWith({ id: 'v1' });
      expect(fs.unlinkSync).not.toHaveBeenCalled(); // 不删物理文件
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'delete_app_version' }),
      );
    });
  });
});

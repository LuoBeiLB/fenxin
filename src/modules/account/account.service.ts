import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import * as XLSX from 'xlsx';
import { AppUser, sanitizeUser, SAFE_USER_FIELDS } from '../../entities/app-user.entity';
import { Device } from '../../entities/device.entity';
import { AuditService } from '../audit/audit.service';
import { generateRandomPassword } from '../../common/utils/password.util';

export interface BatchResult {
  phone: string;
  display_name: string;
  password: string;
  success: boolean;
  error?: string;
}

@Injectable()
export class AccountService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async createAccount(params: {
    phone: string;
    displayName: string;
    department?: string;
    password?: string;
    operatorId: string;
    ip?: string;
  }) {
    const userRepo = this.dataSource.getRepository(AppUser);

    const existing = await userRepo.findOne({ where: { phone: params.phone } });
    if (existing) throw new ConflictException('该手机号已开通账号');

    const initialPassword = params.password || generateRandomPassword(12);

    const saved = await userRepo.save(
      userRepo.create({
        phone: params.phone,
        password_hash: await argon2.hash(initialPassword),
        display_name: params.displayName,
        department: params.department ?? null,
        role: 'user',
        status: 'active',
        force_change_pwd: true,
      }),
    );

    await this.audit.log({
      userId: params.operatorId,
      action: 'create_account',
      targetType: 'user',
      targetId: saved.id,
      detail: `Created account for ${params.phone} (${params.displayName})`,
      ipAddress: params.ip,
    });

    return { user: sanitizeUser(saved), initial_password: initialPassword };
  }

  async batchCreateAccounts(
    accounts: Array<{ phone: string; display_name: string; department?: string }>,
    operatorId: string,
    ip?: string,
  ): Promise<BatchResult[]> {
    const results: BatchResult[] = [];
    for (const account of accounts) {
      try {
        const result = await this.createAccount({
          phone: account.phone,
          displayName: account.display_name,
          department: account.department,
          operatorId,
          ip,
        });
        results.push({
          phone: account.phone,
          display_name: account.display_name,
          password: result.initial_password,
          success: true,
        });
      } catch (err) {
        results.push({
          phone: account.phone,
          display_name: account.display_name,
          password: '',
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    await this.audit.log({
      userId: operatorId,
      action: 'batch_import_accounts',
      detail: `Imported ${accounts.length} accounts, ${results.filter((r) => r.success).length} succeeded`,
      ipAddress: ip,
    });

    return results;
  }

  /** 解析 Excel（xlsx）批量导入。支持列名：phone/手机号, display_name/姓名, department/部门, password/密码 */
  async importFromExcel(buffer: Buffer, operatorId: string, ip?: string): Promise<BatchResult[]> {
    let rows: any[];
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } catch {
      throw new ConflictException('Excel 文件解析失败，请检查文件格式');
    }

    const accounts = rows
      .map((r) => ({
        phone: String(r.phone ?? r['手机号'] ?? '').trim(),
        display_name: String(r.display_name ?? r['姓名'] ?? '').trim(),
        department: String(r.department ?? r['部门'] ?? '').trim() || undefined,
      }))
      .filter((a) => /^1\d{10}$/.test(a.phone) && a.display_name);

    if (accounts.length === 0) {
      throw new ConflictException('Excel 中无有效账号行（需要列：phone/手机号, display_name/姓名, department/部门）');
    }

    return this.batchCreateAccounts(accounts, operatorId, ip);
  }

  async resetPassword(targetUserId: string, operatorId: string, newPassword?: string, ip?: string) {
    const userRepo = this.dataSource.getRepository(AppUser);
    const target = await userRepo.findOne({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('账号不存在');

    const password = newPassword || generateRandomPassword(12);
    await userRepo.update(targetUserId, {
      password_hash: await argon2.hash(password),
      force_change_pwd: true,
    });

    await this.audit.log({
      userId: operatorId,
      action: 'reset_password',
      targetType: 'user',
      targetId: targetUserId,
      ipAddress: ip,
    });

    return { new_password: password };
  }

  async toggleAccountStatus(
    targetUserId: string,
    status: 'active' | 'disabled',
    operatorId: string,
    ip?: string,
  ) {
    const userRepo = this.dataSource.getRepository(AppUser);
    const target = await userRepo.findOne({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('账号不存在');
    if (target.deleted_at) throw new BadRequestException('账号已删除，不能修改状态');

    await userRepo.update(targetUserId, { status });

    if (status === 'disabled') {
      // 删除设备记录 = 立即吊销该账号所有已签发 token（JWT 守卫每请求校验设备存在性）
      await this.dataSource.getRepository(Device).delete({ user_id: targetUserId });
    }

    await this.audit.log({
      userId: operatorId,
      action: status === 'active' ? 'enable_account' : 'disable_account',
      targetType: 'user',
      targetId: targetUserId,
      ipAddress: ip,
    });
  }

  /** 软删除账号：保留数据合规留痕，立即吊销全部 token。禁删自己、禁删管理员、不可重复删除 */
  async softDeleteAccount(targetUserId: string, operatorId: string, ip?: string) {
    const userRepo = this.dataSource.getRepository(AppUser);
    const target = await userRepo.findOne({ where: { id: targetUserId } });
    if (!target || target.deleted_at) throw new NotFoundException('账号不存在或已删除');
    if (targetUserId === operatorId) throw new BadRequestException('不能删除自己的账号');
    if (target.role === 'admin') throw new BadRequestException('不能删除管理员账号');

    await userRepo.update(targetUserId, {
      deleted_at: () => 'NOW()',
      status: 'disabled',
    });
    // 删除设备记录 = 立即吊销该账号所有已签发 token（JWT 守卫每请求校验设备存在性）
    await this.dataSource.getRepository(Device).delete({ user_id: targetUserId });

    await this.audit.log({
      userId: operatorId,
      action: 'delete_account',
      targetType: 'user',
      targetId: targetUserId,
      detail: `Soft-deleted account ${target.phone} (${target.display_name})`,
      ipAddress: ip,
    });

    return { success: true };
  }

  async listAccounts(params: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    department?: string;
    status?: string;
    showDeleted?: boolean;
  }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;

    const qb = this.dataSource
      .getRepository(AppUser)
      .createQueryBuilder('u')
      .select(SAFE_USER_FIELDS.map((f) => `u.${String(f)}`));

    if (params.keyword) {
      qb.andWhere('(u.phone = :keyword OR u.display_name LIKE :keywordLike)', {
        keyword: params.keyword,
        keywordLike: `%${params.keyword}%`,
      });
    }
    if (params.department) qb.andWhere('u.department = :department', { department: params.department });
    if (params.status) qb.andWhere('u.status = :status', { status: params.status });
    if (params.showDeleted) {
      qb.andWhere('u.deleted_at IS NOT NULL');
    } else {
      qb.andWhere('u.deleted_at IS NULL');
    }

    qb.orderBy('u.created_at', 'DESC').skip((page - 1) * pageSize).take(pageSize);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  async getAccount(userId: string) {
    const user = await this.dataSource.getRepository(AppUser).findOne({ where: { id: userId } });
    if (!user || user.deleted_at) throw new NotFoundException('账号不存在');
    return sanitizeUser(user);
  }

  async listDepartments(): Promise<string[]> {
    const result = await this.dataSource
      .getRepository(AppUser)
      .createQueryBuilder('u')
      .select('DISTINCT u.department', 'department')
      .where('u.department IS NOT NULL')
      .andWhere('u.deleted_at IS NULL')
      .orderBy('u.department', 'ASC')
      .getRawMany();

    return result.map((r: { department: string }) => r.department).filter(Boolean);
  }
}

import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import { AppUser } from '../entities/app-user.entity';
import { generateRandomPassword } from '../common/utils/password.util';

/**
 * 初始管理员 Seed：
 * 系统内不存在任何 admin 时（首次部署），按环境变量创建初始管理员。
 * INITIAL_ADMIN_PASSWORD 留空则自动生成随机密码并打印到启动日志（仅打印一次）。
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Seed');

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap() {
    const userRepo = this.dataSource.getRepository(AppUser);
    const adminCount = await userRepo.count({ where: { role: 'admin' } });
    if (adminCount > 0) return;

    const phone = process.env.INITIAL_ADMIN_PHONE || '13800000000';
    const password = process.env.INITIAL_ADMIN_PASSWORD || generateRandomPassword(14);

    const existing = await userRepo.findOne({ where: { phone } });
    if (existing) {
      await userRepo.update(existing.id, { role: 'admin' });
      this.logger.log(`已将已有账号 ${phone} 提升为 admin`);
      return;
    }

    await userRepo.save(
      userRepo.create({
        phone,
        password_hash: await argon2.hash(password),
        display_name: '系统管理员',
        role: 'admin',
        status: 'active',
        force_change_pwd: true,
      }),
    );
    this.logger.log(`初始管理员已创建 phone=${phone} 初始密码=${password}（请立即登录修改，此密码仅显示一次）`);
  }
}

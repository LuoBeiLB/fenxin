import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppUser, SAFE_USER_FIELDS } from '../../entities/app-user.entity';

@Injectable()
export class ContactService {
  constructor(private readonly dataSource: DataSource) {}

  /** 通讯录：全员列表。只 select 白名单字段，绝不返回 password_hash 等敏感信息 */
  async listContacts(params: {
    userId: string;
    keyword?: string;
    department?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 50;

    const qb = this.dataSource
      .getRepository(AppUser)
      .createQueryBuilder('u')
      .select(SAFE_USER_FIELDS.map((f) => `u.${String(f)}`))
      .where('u.status = :status', { status: 'active' })
      .andWhere('u.id != :userId', { userId: params.userId });

    if (params.keyword) {
      qb.andWhere('(u.phone = :keyword OR u.display_name LIKE :keywordLike)', {
        keyword: params.keyword,
        keywordLike: `%${params.keyword}%`,
      });
    }
    if (params.department) {
      qb.andWhere('u.department = :department', { department: params.department });
    }

    qb.orderBy('u.display_name', 'ASC').skip((page - 1) * pageSize).take(pageSize);
    // console.log(`qb结果是：${qb}`)
    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  async searchContacts(userId: string, keyword: string) {
    return this.dataSource
      .getRepository(AppUser)
      .createQueryBuilder('u')
      .select(SAFE_USER_FIELDS.map((f) => `u.${String(f)}`))
      .where('u.status = :status', { status: 'active' })
      .andWhere('u.id != :userId', { userId })
      .andWhere('(u.phone = :keyword OR u.display_name LIKE :keywordLike)', {
        keyword,
        keywordLike: `%${keyword}%`,
      })
      .limit(20)
      .getMany();
  }
}

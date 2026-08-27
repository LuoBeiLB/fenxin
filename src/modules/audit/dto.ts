import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** GET /audit-logs 查询参数（仅管理员） */
export class ListAuditLogsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 20;

  /** 按操作人筛选（用户 ID） */
  @IsOptional()
  @IsString()
  user_id?: string;

  /** 按动作筛选，如 login / create_account / reset_password / enable_account / disable_account / remove_device / change_password / batch_import_accounts */
  @IsOptional()
  @IsString()
  action?: string;

  /** 按目标类型筛选，如 user / device */
  @IsOptional()
  @IsString()
  target_type?: string;

  /** 起始时间（含），ISO 8601 或 YYYY-MM-DD */
  @IsOptional()
  @IsString()
  start_time?: string;

  /** 结束时间（含），ISO 8601 或 YYYY-MM-DD */
  @IsOptional()
  @IsString()
  end_time?: string;

  /** 模糊搜索操作详情 detail */
  @IsOptional()
  @IsString()
  keyword?: string;
}

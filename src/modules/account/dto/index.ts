import {
  IsString,
  Matches,
  IsOptional,
  IsIn,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAccountDto {
  @ApiProperty({ example: '13900139001' })
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' })
  phone: string;

  @ApiProperty({ example: '张三' })
  @IsString()
  @MaxLength(100)
  display_name: string;

  @ApiPropertyOptional({ example: '工程部' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @ApiPropertyOptional({ description: '初始密码；留空则自动生成随机密码' })
  @IsOptional()
  @IsString()
  password?: string;
}

export class BatchAccountItemDto {
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' })
  phone: string;

  @IsString()
  @MaxLength(100)
  display_name: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;
}

export class BatchCreateDto {
  @ApiProperty({ type: [BatchAccountItemDto] })
  @ValidateNested({ each: true })
  @Type(() => BatchAccountItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  accounts: BatchAccountItemDto[];
}

export class ResetPasswordDto {
  @ApiPropertyOptional({ description: '指定新密码；留空则自动生成随机密码' })
  @IsOptional()
  @IsString()
  new_password?: string;
}

export class ToggleStatusDto {
  @ApiProperty({ enum: ['active', 'disabled'] })
  @IsIn(['active', 'disabled'])
  status: 'active' | 'disabled';
}

export class ListAccountsQuery {
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

  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: string;
}

import { IsString, Matches, MinLength, IsIn, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: '13800138000' })
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' })
  phone: string;

  @ApiProperty({ example: 'Admin@123456' })
  @IsString()
  @MinLength(1, { message: '密码不能为空' })
  password: string;

  @ApiProperty({ example: 'iPhone 15' })
  @IsString()
  device_name: string;

  @ApiProperty({ example: 'mobile', enum: ['mobile', 'desktop', 'tablet', 'web'] })
  @IsIn(['mobile', 'desktop', 'tablet', 'web'])
  device_type: string;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description:
      '客户端生成并持久化的设备唯一标识（localStorage）。重复登录传相同值则复用已有设备记录，不产生重复设备条目；不传则由服务端随机生成（兼容旧客户端）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  device_id?: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  old_password: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: '新密码长度不能少于8位' })
  new_password: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  refresh_token: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signature?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar_url?: string;

  /** 主题色标识（值域由前端定义，如 default/dark/blue，或 20 字符内的任意标识），不传则不修改 */
  @ApiPropertyOptional({ description: '用户自选主题色标识（值域由前端定义），用于前端换肤', example: 'dark' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  topic?: string;
}

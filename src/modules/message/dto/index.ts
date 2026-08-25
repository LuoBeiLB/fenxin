import { IsString, IsUUID, IsIn, IsOptional, IsNumber, IsDateString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessageDto {
  @ApiProperty()
  @IsUUID()
  conversation_id: string;

  @ApiProperty({ enum: ['text', 'image', 'voice', 'video', 'file'] })
  @IsIn(['text', 'image', 'voice', 'video', 'file'])
  type: 'text' | 'image' | 'voice' | 'video' | 'file';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  file_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  file_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  file_size?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  reply_to_id?: string;

  @ApiPropertyOptional({ description: '阅后即焚销毁时间（ISO8601），到期后服务端自动销毁' })
  @IsOptional()
  @IsDateString()
  destroy_at?: string;
}

export class EditMessageDto {
  @ApiProperty()
  @IsString()
  content: string;
}

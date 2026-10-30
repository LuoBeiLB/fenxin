import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** 发起私密聊天请求 */
export class RequestSecretChatDto {
  @ApiProperty({
    description: '对方用户 ID（必须已有共同会话关系）',
    example: '3f9a2b8e-1111-4222-8333-444455556666',
  })
  @IsUUID('4', { message: 'target_user_id 必须是合法 UUID' })
  target_user_id: string;
}

import { IsIn, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** B-3：批量结束我名下全部私密会话 */
export class CloseAllSecretChatsDto {
  @ApiProperty({
    description:
      '关闭原因：logout=退出登录 / device_change=换设备后清理旧会话 / user=主动结束（默认）',
    enum: ['user', 'logout', 'device_change'],
    required: false,
    default: 'user',
  })
  @IsOptional()
  @IsIn(['user', 'logout', 'device_change'], { message: 'reason 只能是 user / logout / device_change' })
  reason?: 'user' | 'logout' | 'device_change';

  @ApiProperty({
    description:
      'true = 只结束绑在「其它设备」上的会话（当前设备正在用的不动）；默认 false = 全部结束',
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  only_other_devices?: boolean;
}

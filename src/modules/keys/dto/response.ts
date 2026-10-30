import { ApiProperty } from '@nestjs/swagger';

/** POST /keys/device 的返回 */
export class DeviceKeyUploadResult {
  @ApiProperty({ description: '是否发生了写入（相同公钥重复上传返回 false）' })
  updated: boolean;
}

/** GET /keys/device/:conversationId 的返回：对方的绑定设备公钥 */
export class PeerDeviceKeyView {
  @ApiProperty({ description: '公钥所属用户（对方）' })
  user_id: string;

  @ApiProperty({ description: '公钥所属设备（对方绑定的那台）' })
  device_id: string;

  @ApiProperty({ description: 'X25519 公钥 base64（44 字符）' })
  identity_pubkey: string;

  @ApiProperty({ description: '公钥最后更新时间' })
  updated_at: Date;
}

/** 本设备公钥（用于前端自检"我上传的和本地是否一致"） */
export class MyDeviceKeyView {
  @ApiProperty({ description: '是否已上传' })
  exists: boolean;

  @ApiProperty({ description: '本设备 ID', required: false })
  device_id?: string;

  @ApiProperty({ description: 'X25519 公钥 base64', required: false })
  identity_pubkey?: string;

  @ApiProperty({ description: '最后更新时间', required: false })
  updated_at?: Date;
}

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KeysService } from './keys.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { UploadIdentityKeyDto, QueryIdentityKeysDto } from './dto';

@ApiTags('加密密钥')
@ApiBearerAuth()
@Controller('keys')
export class KeysController {
  constructor(private readonly keysService: KeysService) {}

  /**
   * 上传/更新自己的 X25519 identity 公钥。
   * 收紧限流：每用户每分钟 5 次（公钥少有变动；限流防脚本暴力覆盖）。
   * 1 用户 1 公钥：相同公钥幂等不写。
   */
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post()
  @ResponseMessage('公钥已上传')
  async upload(
    @CurrentUser() user: AuthPayload,
    @Body() dto: UploadIdentityKeyDto,
  ): Promise<{ updated: boolean }> {
    return this.keysService.uploadIdentityKey(user.userId, dto.identity_pubkey);
  }

  /**
   * 批量查询公钥（TOFU 前端比对用）：App 启动 / 进群时一次拉一组联系人的公钥+更新时间，
   * 与本地钉住的公钥缓存比对。权限同单个查询：自己 + 共同会话成员；
   * 未上传公钥 / 无共同会话的用户不出现在结果里。单次上限 500 个。
   */
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('query')
  @ResponseMessage('公钥批量查询成功')
  query(@CurrentUser() user: AuthPayload, @Body() dto: QueryIdentityKeysDto) {
    return this.keysService.getIdentityKeysBatch(user.userId, dto.user_ids);
  }

  /**
   * 查询对方公钥。权限：必须是同 conversation 成员（详见 KeysService.getIdentityKey）。
   * 不返回 phone / display_name 等 PII —— 该接口是纯 E2E 元数据通道。
   */
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get(':userId')
  get(@CurrentUser() user: AuthPayload, @Param('userId') targetUserId: string) {
    return this.keysService.getIdentityKey(user.userId, targetUserId);
  }
}

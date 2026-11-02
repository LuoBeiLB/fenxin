import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { DeviceKey } from '../../entities/device-key.entity';
import { Conversation } from '../../entities/conversation.entity';
import { ConversationMember } from '../../entities/conversation-member.entity';
import { DeviceKeyUploadResult, MyDeviceKeyView, PeerDeviceKeyView } from './dto/response';

/** 去掉 base64 尾部填充：43 位无填充是服务端唯一存储形态 */
export function normalizePubkey(pubkey: string): string {
  return (pubkey || '').replace(/=+$/, '');
}

/**
 * 设备级加密密钥（V6.2 设备配对私密会话）。
 *
 * 与旧 `user_keys` 的区别：
 *   - 旧：一用户一行，后登录设备上传会覆盖前一台 → 只有最后一台能解密；
 *   - 新：`(user_id, device_id)` 唯一，每台设备独立，登录再多互不影响。
 *
 * 服务端只做三件事：
 *   ① 存/更新本设备公钥（device_id 取自 JWT，不信任 body）；
 *   ② 按会话返回**对方绑定设备**的公钥（仅绑定设备可读）；
 *   ③ 设备下线时删除该设备的公钥（由 AuthService 调用）。
 *
 * 不做的：曲线点合法性校验（解密失败由客户端回流）、私钥托管（绝对不做）。
 */
@Injectable()
export class KeysService {
  private readonly logger = new Logger('KeysService');

  constructor(private readonly dataSource: DataSource) {}

  /**
   * 上传/更新本设备公钥（幂等：相同公钥不写）。
   */
  async uploadDeviceKey(
    userId: string,
    deviceId: string,
    identityPubkey: string,
  ): Promise<DeviceKeyUploadResult> {
    if (!deviceId) throw new BadRequestException('缺少设备上下文，请重新登录');

    // B3：统一去掉 base64 尾部的 '='（43 位无填充存储）。
    // 不同语言的标准库行为不同（JS btoa 带 '='，RawURLEncoding 不带），
    // 服务端只认一种形态，否则同一把公钥会因为 padding 差异被当成"密钥轮换"，
    // 触发 TOFU 告警（"对方安全密钥已变更"）。
    const pubkey = normalizePubkey(identityPubkey);

    const repo = this.dataSource.getRepository(DeviceKey);
    const existing = await repo.findOne({
      where: { user_id: userId, device_id: deviceId },
      select: ['id', 'identity_pubkey'],
    });

    if (existing) {
      if (normalizePubkey(existing.identity_pubkey) === pubkey) return { updated: false };
      await repo.update(existing.id, { identity_pubkey: pubkey });
      this.logger.log(`device key rotated user=${userId} device=${deviceId}`);
      return { updated: true };
    }

    await repo.save(repo.create({ user_id: userId, device_id: deviceId, identity_pubkey: pubkey }));
    this.logger.log(`device key created user=${userId} device=${deviceId}`);
    return { updated: true };
  }

  /** 查本设备已上传的公钥（前端自检用） */
  async getMyDeviceKey(userId: string, deviceId: string): Promise<MyDeviceKeyView> {
    if (!deviceId) return { exists: false };
    const row = await this.dataSource
      .getRepository(DeviceKey)
      .findOne({ where: { user_id: userId, device_id: deviceId } });
    if (!row) return { exists: false };
    return {
      exists: true,
      device_id: row.device_id,
      identity_pubkey: row.identity_pubkey,
      updated_at: row.updated_at,
    };
  }

  /**
   * 取私密会话中**对方绑定设备**的公钥。
   *
   * 权限：调用者必须是该会话的绑定设备之一；pending 状态下没有对方设备，返回 404。
   * 这样客户端只需要一个 conversation_id 就能拿到唯一的对端公钥，
   * 不需要知道对方的 device_id（也避免在 URL 里暴露对方设备）。
   */
  async getPeerDeviceKey(
    userId: string,
    deviceId: string,
    conversationId: string,
  ): Promise<PeerDeviceKeyView> {
    const conv = await this.dataSource
      .getRepository(Conversation)
      .findOne({ where: { id: conversationId } });

    if (!conv) throw new NotFoundException('会话不存在');
    if (conv.e2e_mode !== 1) throw new BadRequestException('该会话不是端到端加密会话');
    if (conv.e2e_state !== 2) throw new NotFoundException('私密会话尚未建立');

    const bound = conv.e2e_device_a === deviceId || conv.e2e_device_b === deviceId;
    if (!bound) throw new ForbiddenException('本设备不是该私密会话的绑定设备');

    const peerDeviceId = conv.e2e_device_a === deviceId ? conv.e2e_device_b : conv.e2e_device_a;
    const peerUserId = conv.user_a === userId ? conv.user_b : conv.user_a;
    if (!peerDeviceId || !peerUserId) throw new NotFoundException('对方设备信息缺失');

    const row = await this.dataSource
      .getRepository(DeviceKey)
      .findOne({ where: { user_id: peerUserId, device_id: peerDeviceId } });

    if (!row) throw new NotFoundException('对方尚未上传设备公钥，无法加密发送');

    return {
      user_id: row.user_id,
      device_id: row.device_id,
      identity_pubkey: row.identity_pubkey,
      updated_at: row.updated_at,
    };
  }

  /** 设备下线/被踢：删除该设备公钥（可顺便清理，失败不影响主流程） */
  async deleteDeviceKey(userId: string, deviceId: string): Promise<void> {
    if (!deviceId) return;
    await this.dataSource.getRepository(DeviceKey).delete({ user_id: userId, device_id: deviceId });
  }

  /**
   * 删除某台设备的所有公钥（按 device_id，用于管理员强制下线 / 会话策略踢人）。
   * 只按 device_id 删是因为 device_id 本身全局唯一。
   */
  async deleteDeviceKeyByDeviceId(deviceId: string): Promise<number> {
    if (!deviceId) return 0;
    const r = await this.dataSource.getRepository(DeviceKey).delete({ device_id: deviceId });
    return r.affected ?? 0;
  }

  /**
   * 判断两个用户是否有业务关系（共同会话）——发起私密会话前的关系校验。
   * 保留在 keys 服务里是因为它原本就属于"密钥可见性"的判定逻辑。
   */
  async assertPeerRelation(currentUserId: string, targetUserId: string): Promise<void> {
    const qb: SelectQueryBuilder<ConversationMember> = this.dataSource
      .getRepository(ConversationMember)
      .createQueryBuilder('m1');
    qb.innerJoin(ConversationMember, 'm2', 'm2.conversation_id = m1.conversation_id');
    qb.where('m1.user_id = :me', { me: currentUserId });
    qb.andWhere('m2.user_id = :target', { target: targetUserId });
    qb.limit(1);
    const shared = await qb.getOne();
    if (!shared) throw new ForbiddenException('对方不在你的会话中，不能发起私密聊天');
  }
}

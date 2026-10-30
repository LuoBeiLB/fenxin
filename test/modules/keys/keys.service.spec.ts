import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { KeysService } from 'src/modules/keys/keys.service';
import { DeviceKey } from 'src/entities/device-key.entity';
import { Conversation } from 'src/entities/conversation.entity';

/**
 * 设备级密钥（V6.2）。
 *
 * 覆盖：
 *  - 上传：首次创建 / 相同公钥幂等 / 变更更新 / 缺 deviceId 报错
 *  - 查本设备：不存在 → exists=false
 *  - 查对方：非私密会话 400 / pending 404 / 非绑定设备 403 / 对方无公钥 404 / 正常返回
 *  - 设备下线：按 device_id 删除
 *
 * 不接 DB：用 jest.fn 替身 repository 撑过去，目的就是验证服务层分支逻辑。
 */

function makeService(
  opts: {
    deviceKey?: any; // 本设备公钥行
    conversation?: any; // 会话行
    peerKey?: any; // 对方设备公钥行
  } = {},
) {
  const store: any = { deviceKey: opts.deviceKey ?? null, peerKey: opts.peerKey ?? null };
  const created: any[] = [];
  const updated: any[] = [];
  const deleted: any[] = [];

  const deviceKeyRepo: any = {
    findOne: jest.fn(async ({ where }: any) => {
      if (
        store.deviceKey &&
        store.deviceKey.user_id === where.user_id &&
        store.deviceKey.device_id === where.device_id
      ) {
        return store.deviceKey;
      }
      if (
        store.peerKey &&
        store.peerKey.user_id === where.user_id &&
        store.peerKey.device_id === where.device_id
      ) {
        return store.peerKey;
      }
      return null;
    }),
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (v: any) => {
      created.push(v);
      return { id: 'new-id', ...v };
    }),
    update: jest.fn(async (id: any, patch: any) => {
      updated.push({ id, patch });
      return { affected: 1 };
    }),
    delete: jest.fn(async (criteria: any) => {
      deleted.push(criteria);
      return { affected: 1 };
    }),
  };

  const convRepo: any = {
    findOne: jest.fn(async () => opts.conversation ?? null),
  };

  const dataSource: any = {
    getRepository: (entity: any) => {
      if (entity === DeviceKey) return deviceKeyRepo;
      if (entity === Conversation) return convRepo;
      return {};
    },
  };

  const service = new KeysService(dataSource as DataSource);
  return { service, deviceKeyRepo, convRepo, created, updated, deleted };
}

const USER = 'u-1';
const DEVICE = 'd-1';

describe('KeysService（V6.2 设备级密钥）', () => {
  describe('上传设备公钥', () => {
    it('首次上传 → 创建一行，updated=true', async () => {
      const { service, created } = makeService({ deviceKey: null });
      const r = await service.uploadDeviceKey(USER, DEVICE, 'p'.repeat(43));
      expect(r.updated).toBe(true);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ user_id: USER, device_id: DEVICE });
    });

    it('相同公钥重复上传 → 幂等，不写库', async () => {
      const { service, created, updated } = makeService({
        deviceKey: { id: 'k-1', user_id: USER, device_id: DEVICE, identity_pubkey: 'p'.repeat(43) },
      });
      const r = await service.uploadDeviceKey(USER, DEVICE, 'p'.repeat(43));
      expect(r.updated).toBe(false);
      expect(created).toHaveLength(0);
      expect(updated).toHaveLength(0);
    });

    it('公钥变更 → 覆盖本行（不影响其它设备）', async () => {
      const { service, updated } = makeService({
        deviceKey: { id: 'k-1', user_id: USER, device_id: DEVICE, identity_pubkey: 'a'.repeat(43) },
      });
      const r = await service.uploadDeviceKey(USER, DEVICE, 'b'.repeat(43));
      expect(r.updated).toBe(true);
      expect(updated[0]).toMatchObject({ id: 'k-1' });
    });

    it('缺少 deviceId → 400', async () => {
      const { service } = makeService();
      await expect(service.uploadDeviceKey(USER, '', 'p'.repeat(43))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('查询', () => {
    it('本设备未上传 → exists=false', async () => {
      const { service } = makeService({ deviceKey: null });
      const r = await service.getMyDeviceKey(USER, DEVICE);
      expect(r).toEqual({ exists: false });
    });

    it('本设备已上传 → 返回公钥', async () => {
      const { service } = makeService({
        deviceKey: {
          id: 'k-1',
          user_id: USER,
          device_id: DEVICE,
          identity_pubkey: 'p'.repeat(43),
          updated_at: new Date(),
        },
      });
      const r = await service.getMyDeviceKey(USER, DEVICE);
      expect(r.exists).toBe(true);
      expect(r.identity_pubkey).toBe('p'.repeat(43));
    });

    it('非私密会话 → 400', async () => {
      const { service } = makeService({
        conversation: { id: 'c-1', e2e_mode: 0, e2e_state: 0 },
      });
      await expect(service.getPeerDeviceKey(USER, DEVICE, 'c-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('pending 会话 → 404（对方设备尚未绑定）', async () => {
      const { service } = makeService({
        conversation: { id: 'c-1', e2e_mode: 1, e2e_state: 1, e2e_device_a: DEVICE },
      });
      await expect(service.getPeerDeviceKey(USER, DEVICE, 'c-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('非绑定设备 → 403', async () => {
      const { service } = makeService({
        conversation: {
          id: 'c-1',
          e2e_mode: 1,
          e2e_state: 2,
          e2e_device_a: 'other-device',
          e2e_device_b: 'another-device',
          user_a: USER,
          user_b: 'u-2',
        },
      });
      await expect(service.getPeerDeviceKey(USER, DEVICE, 'c-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('绑定设备但对方未上传公钥 → 404', async () => {
      const { service } = makeService({
        conversation: {
          id: 'c-1',
          e2e_mode: 1,
          e2e_state: 2,
          e2e_device_a: DEVICE,
          e2e_device_b: 'peer-device',
          user_a: USER,
          user_b: 'u-2',
        },
        peerKey: null,
      });
      await expect(service.getPeerDeviceKey(USER, DEVICE, 'c-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('绑定设备 + 对方已上传 → 返回对方设备公钥', async () => {
      const { service } = makeService({
        conversation: {
          id: 'c-1',
          e2e_mode: 1,
          e2e_state: 2,
          e2e_device_a: DEVICE,
          e2e_device_b: 'peer-device',
          user_a: USER,
          user_b: 'u-2',
        },
        peerKey: {
          user_id: 'u-2',
          device_id: 'peer-device',
          identity_pubkey: 'q'.repeat(43),
          updated_at: new Date(),
        },
      });
      const r = await service.getPeerDeviceKey(USER, DEVICE, 'c-1');
      expect(r).toMatchObject({ user_id: 'u-2', device_id: 'peer-device' });
      expect(r.identity_pubkey).toBe('q'.repeat(43));
    });
  });

  describe('设备下线', () => {
    it('按 device_id 删除设备公钥', async () => {
      const { service, deleted } = makeService();
      const n = await service.deleteDeviceKeyByDeviceId('d-9');
      expect(n).toBe(1);
      expect(deleted[0]).toMatchObject({ device_id: 'd-9' });
    });

    it('deviceId 为空 → 不执行删除', async () => {
      const { service, deviceKeyRepo } = makeService();
      await service.deleteDeviceKey('', '');
      expect(deviceKeyRepo.delete).not.toHaveBeenCalled();
    });
  });
});

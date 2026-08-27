import { BadRequestException } from '@nestjs/common';
import { MessageService } from 'src/modules/message/message.service';
import { Message } from 'src/entities/message.entity';
import { Conversation } from 'src/entities/conversation.entity';
import { ConversationMember } from 'src/entities/conversation-member.entity';
import { MessageReceipt } from 'src/entities/message-receipt.entity';

/**
 * 验证"sendMessage 加密路径"链路（V4.0 §E2E 方案 B）。
 *
 * 覆盖 6 个关键路径：
 *   1. 明文（无 3 加密字段）→ 老路：is_encrypted=false、content 是真明文
 *   2. 全填加密字段 → 加密路：is_encrypted=true、content='[加密消息]'、3 字段透传
 *   3. 半填（只填 1 字段） → BadRequestException
 *   4. 半填（只填 2 字段） → BadRequestException
 *   5. 加密 + destroyAt（5s 后）阅后即焚 → 组合：destroy_at 落库 + 加密字段都在
 *   6. 加密路径 content 不传 → 不抛错（占位由 service 强制填 '[加密消息]'）
 *
 * 不接 DB：jest.fn 替身 repository + dataSource.transaction 走回调；
 * 目的就是验证 sendMessage 的"加密字段强校验 + 透传"逻辑，跟其他模块隔离。
 */
describe('MessageService.sendMessage（V4.0 §E2E 加密路径）', () => {
  let svc: MessageService;
  let dataSource: any;
  let realtime: any;
  let savedMessages: any[];

  // 32 字节 X25519 pubkey base64 占位（43-44 字符内）
  const VALID_EPK = 'EPK_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=';
  // 12 字节 AES-GCM nonce base64 占位（16 字符）
  const VALID_NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
  // 密文占位
  const VALID_CIPHER = 'CIPHERTEXT_BASE64_PLACEHOLDER_NOT_DECRYPTED';

  const buildSvc = (members: { user_id: string }[] = [{ user_id: 'u1' }, { user_id: 'u2' }]) => {
    savedMessages = [];
    const messageRepo = {
      create: jest.fn((data: any) => ({ id: 'm-generated', ...data })),
      save: jest.fn(async (entity: any) => {
        savedMessages.push(entity);
        return { id: 'm-generated', ...entity };
      }),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    const convRepo = {
      findOne: jest.fn(async () => ({ id: 'c1', type: 'private' })),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    const memberRepo = {
      find: jest.fn(async (opts: any) => {
        if (opts?.where?.conversation_id) {
          return members.filter((m) => opts.where.user_id && opts.where.user_id._value
            ? false  // 走 mentioned 校验
            : members);
        }
        return members;
      }),
      findOne: jest.fn(async () => ({ user_id: 'u1' })),
    };
    const receiptRepo = {
      create: jest.fn((data: any) => data),
      save: jest.fn(async (rows: any) => rows),
    };

    dataSource = {
      getRepository: (entity: any) => {
        const name = entity?.name || '';
        if (name === 'Message') return messageRepo;
        if (name === 'Conversation') return convRepo;
        if (name === 'ConversationMember') return memberRepo;
        if (name === 'MessageReceipt') return receiptRepo;
        return {};
      },
      transaction: async (cb: any) =>
        cb({
          getRepository: dataSource.getRepository,
        }),
    };

    realtime = {
      emitToUsers: jest.fn().mockReturnValue(1),
      isReady: () => true,
    };

    svc = new MessageService(dataSource, realtime);
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===== Case 1: 明文老路 =====
  it('明文（无 3 加密字段）→ 老路：is_encrypted=false、content 是真明文', async () => {
    buildSvc();
    const res = await svc.sendMessage({
      conversationId: 'c1',
      senderId: 'u1',
      type: 'text',
      content: 'Hello world 明文',
    });

    expect(savedMessages).toHaveLength(1);
    expect(savedMessages[0].is_encrypted).toBe(false);
    expect(savedMessages[0].content).toBe('Hello world 明文');
    expect(savedMessages[0].cipher_text).toBeNull();
    expect(savedMessages[0].cipher_nonce).toBeNull();
    expect(savedMessages[0].sender_ephemeral_pubkey).toBeNull();
    // master events 网关签名：emitToUsers(event, userIds, payload)，事件名 message:new
    expect(realtime.emitToUsers).toHaveBeenCalledWith(
      'message:new',
      expect.any(Array),
      expect.objectContaining({ message: expect.objectContaining({ is_encrypted: false }) }),
    );
  });

  // ===== Case 2: 加密路径全填 =====
  it('全填加密字段 → 加密路：is_encrypted=true、content 强制占位、3 字段透传', async () => {
    buildSvc();
    const res = await svc.sendMessage({
      conversationId: 'c1',
      senderId: 'u1',
      type: 'text',
      // 加密路径下 content 可传可不传（service 强制覆盖）
      content: '明文 - 服务端不应存',
      senderEphemeralPubkey: VALID_EPK,
      cipherNonce: VALID_NONCE,
      cipherText: VALID_CIPHER,
    });

    expect(savedMessages).toHaveLength(1);
    const saved = savedMessages[0];
    expect(saved.is_encrypted).toBe(true);
    expect(saved.content).toBe('[加密消息]'); // 强制覆盖
    expect(saved.cipher_text).toBe(VALID_CIPHER);
    expect(saved.cipher_nonce).toBe(VALID_NONCE);
    expect(saved.sender_ephemeral_pubkey).toBe(VALID_EPK);
    // WS 推送完整 payload（master events 网关签名：emitToUsers(event, userIds, payload)）
    expect(realtime.emitToUsers).toHaveBeenCalledWith(
      'message:new',
      expect.any(Array),
      expect.objectContaining({
        message: expect.objectContaining({
          is_encrypted: true,
          cipher_text: VALID_CIPHER,
        }),
      }),
    );
  });

  // ===== Case 3: 半填 1 字段 =====
  it('半填（只填 sender_ephemeral_pubkey）→ BadRequestException', async () => {
    buildSvc();
    await expect(
      svc.sendMessage({
        conversationId: 'c1',
        senderId: 'u1',
        type: 'text',
        content: '明文',
        senderEphemeralPubkey: VALID_EPK,
        // 缺 cipherNonce + cipherText
      }),
    ).rejects.toThrow(BadRequestException);
    expect(savedMessages).toHaveLength(0);
  });

  // ===== Case 4: 半填 2 字段 =====
  it('半填（填了 nonce + cipher 但缺 epk）→ BadRequestException', async () => {
    buildSvc();
    await expect(
      svc.sendMessage({
        conversationId: 'c1',
        senderId: 'u1',
        type: 'text',
        content: '明文',
        cipherNonce: VALID_NONCE,
        cipherText: VALID_CIPHER,
        // 缺 senderEphemeralPubkey
      }),
    ).rejects.toThrow('加密字段不完整');
    expect(savedMessages).toHaveLength(0);
  });

  // ===== Case 5: 加密 + 阅后即焚组合（master 方案：destroyAt 绝对时间，fbs 九档 expiresIn 未采纳）=====
  it('加密 + destroyAt=5s 后 阅后即焚 → destroy_at 落库 + 加密字段都在', async () => {
    buildSvc();
    const before = Date.now();
    const res = await svc.sendMessage({
      conversationId: 'c1',
      senderId: 'u1',
      type: 'text',
      senderEphemeralPubkey: VALID_EPK,
      cipherNonce: VALID_NONCE,
      cipherText: VALID_CIPHER,
      destroyAt: new Date(before + 5000).toISOString(),
    });

    expect(savedMessages).toHaveLength(1);
    const saved = savedMessages[0];
    expect(saved.is_encrypted).toBe(true);
    expect(saved.cipher_text).toBe(VALID_CIPHER);
    // destroy_at 应该是 5s 后（±1s 容差）
    expect(saved.destroy_at).toBeInstanceOf(Date);
    const delta = saved.destroy_at.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(4000);
    expect(delta).toBeLessThanOrEqual(6000);
  });

  // ===== Case 6: 加密路径不传 content =====
  it('加密路径 content 不传 → 不抛错，content 强制占位', async () => {
    buildSvc();
    const res = await svc.sendMessage({
      conversationId: 'c1',
      senderId: 'u1',
      type: 'text',
      // content 故意不传
      senderEphemeralPubkey: VALID_EPK,
      cipherNonce: VALID_NONCE,
      cipherText: VALID_CIPHER,
    });

    expect(savedMessages).toHaveLength(1);
    expect(savedMessages[0].is_encrypted).toBe(true);
    expect(savedMessages[0].content).toBe('[加密消息]');
  });
});

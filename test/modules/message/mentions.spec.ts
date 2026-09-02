import { MessageService } from 'src/modules/message/message.service';
import { Message } from 'src/entities/message.entity';
import { Conversation } from 'src/entities/conversation.entity';
import { ConversationMember } from 'src/entities/conversation-member.entity';
import { MessageReceipt } from 'src/entities/message-receipt.entity';

/**
 * @提及（V5.8 前端「有人@我」）单测。
 * 覆盖：
 *   1. 传 mentions：仅会话成员保留、重复 uid 去重后落库
 *   2. 非成员 uid 被过滤（防伪造）；全部非法时落库为 []
 *   3. 不传 mentions：落库为 []（存量行为兼容）
 *   4. WS message:new 推送体携带 mentions（前端判定依据）
 *   5. 焚毁消息马赛克化推送仍保留 mentions（「有人@我」提醒不受马赛克影响，uid 非内容）
 *
 * 不接 DB：jest.fn 替身 repository，与 encrypted-send.spec.ts 同范式。
 */
describe('MessageService.sendMessage（@提及 mentions）', () => {
  let svc: MessageService;
  let dataSource: any;
  let realtime: any;
  let savedMessages: any[];

  const buildSvc = (members: { user_id: string }[] = [
    { user_id: 'u1' },
    { user_id: 'u2' },
    { user_id: 'u3' },
  ]) => {
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
      findOne: jest.fn(async () => ({ id: 'c1', type: 'group' })),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    const memberRepo = {
      find: jest.fn(async () => members),
      findOne: jest.fn(async () => ({ user_id: 'u1' })), // assertMember：任意调用者算成员
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
    };
    realtime = { emitToUsers: jest.fn().mockReturnValue(3), isReady: () => true };
    svc = new MessageService(dataSource, realtime);
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('传 mentions：仅会话成员保留、去重后落库，WS 推送体携带', async () => {
    buildSvc();
    const res = await svc.sendMessage({
      conversationId: 'c1',
      senderId: 'u1',
      type: 'text',
      content: '@萝卜 看一下 @李长荣',
      // 含重复 u2、非成员 u-not-member：期望落库 ['u2','u3']
      mentions: ['u2', 'u2', 'u-not-member', 'u3'],
    });

    expect(savedMessages).toHaveLength(1);
    expect(savedMessages[0].mentions).toEqual(['u2', 'u3']);
    expect(res.mentions).toEqual(['u2', 'u3']);
    // 推给全体成员（含发送者其他设备），message 对象带 mentions
    expect(realtime.emitToUsers).toHaveBeenCalledWith(
      'message:new',
      ['u1', 'u2', 'u3'],
      expect.objectContaining({
        conversation_id: 'c1',
        message: expect.objectContaining({ mentions: ['u2', 'u3'] }),
      }),
    );
  });

  it('mentions 全是非成员：落库为 []（防伪造 uid 挂靠到消息上）', async () => {
    buildSvc();
    await svc.sendMessage({
      conversationId: 'c1',
      senderId: 'u1',
      type: 'text',
      content: '@不存在的人',
      mentions: ['u-ghost-1', 'u-ghost-2'],
    });

    expect(savedMessages[0].mentions).toEqual([]);
  });

  it('不传 mentions：落库为 []（与存量消息/旧客户端兼容）', async () => {
    buildSvc();
    const res = await svc.sendMessage({
      conversationId: 'c1',
      senderId: 'u1',
      type: 'text',
      content: '普通消息',
    });

    expect(savedMessages[0].mentions).toEqual([]);
    expect(res.mentions).toEqual([]);
  });

  it('焚毁消息马赛克化推送：内容字段全 null 但 mentions 保留（「有人@我」提醒仍可判定）', async () => {
    buildSvc();
    await svc.sendMessage({
      conversationId: 'c1',
      senderId: 'u1',
      type: 'text',
      content: '@萝卜 阅后即焚',
      burnTtlSeconds: 5,
      mentions: ['u2'],
    });

    expect(realtime.emitToUsers).toHaveBeenCalledWith(
      'message:new',
      ['u1', 'u2', 'u3'],
      expect.objectContaining({
        message: expect.objectContaining({
          is_blurred: true,
          content: null,
          cipher_text: null,
          mentions: ['u2'],
        }),
      }),
    );
  });

  it('E2E 加密消息 + mentions 组合：mentions 照常透传（uid 为成员关系元数据，不在加密范围）', async () => {
    buildSvc();
    const res = await svc.sendMessage({
      conversationId: 'c1',
      senderId: 'u1',
      type: 'text',
      senderEphemeralPubkey: 'EPK_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=',
      cipherNonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
      cipherText: 'CIPHERTEXT_BASE64_PLACEHOLDER_NOT_DECRYPTED',
      mentions: ['u2', 'u3'],
    });

    expect(savedMessages[0].is_encrypted).toBe(true);
    expect(savedMessages[0].content).toBe('[加密消息]');
    expect(savedMessages[0].mentions).toEqual(['u2', 'u3']);
    expect(res.mentions).toEqual(['u2', 'u3']);
  });
});

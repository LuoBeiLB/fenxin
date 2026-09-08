import { MessageService } from 'src/modules/message/message.service';
import { Message } from 'src/entities/message.entity';
import { ConversationMember } from 'src/entities/conversation-member.entity';
import { MessageReceipt } from 'src/entities/message-receipt.entity';

/**
 * v5.8.9「播完才焚」（音视频 consume）单测（对齐前端 is_media_burn 契约修订版）。
 * 覆盖：
 *   1. reveal 音视频焚毁消息（带 duration）：消费窗口 = max(ttl, duration+缓冲)；
 *      返回 media_burn_pending=true + consume_deadline（ISO8601）
 *   2. reveal 音视频不带 duration：窗口退到 BURN_MEDIA_DEFAULT_WINDOW_SECONDS（300s）
 *   3. 用户 ttl > 窗口：窗口 = ttl（用户保护期不被缩短）
 *   4. reveal 文本焚毁消息：逻辑不变（burn_at = now + ttl；media_burn_pending=false）
 *   5. type='file' + 视频扩展名（mp4）：等同音视频（前端发送视频实际走 file）
 *   6. type='file' + 非视频扩展名（pdf）：不吃窗口、consume 400
 *   7. reveal 优先用发送时存库的 media_duration，其次请求参数
 *   8. consume 正常流：burn_at 置为当下、广播 message:consumed、返回焚毁视图（already=false）
 *   9. consume 幂等：自己 burn_at 已过期（已消费过/窗口烧完）→ already=true，不再 update
 *   10. consume 消息已被调度器物理删除（竞态）→ already=true
 *   11. consume 未 reveal 过 → 400
 *   12. consume 文本焚毁消息 / 非焚毁消息 → 400
 *
 * 不接 DB：jest.fn 替身 repository，与 mentions.spec.ts 同范式。
 */
describe('MessageService 音视频播完才焚（v5.8.9）', () => {
  let svc: MessageService;
  let dataSource: any;
  let realtime: any;
  let receiptUpdate: jest.Mock;

  const baseMsg = {
    id: 'm1',
    conversation_id: 'c1',
    sender_id: 'u1',
    type: 'video',
    content: null,
    file_url: '/uploads/v.mp4',
    is_recalled: false,
    is_destroyed: false,
    destroy_at: null,
    burn_ttl_seconds: 10,
  };

  const buildSvc = (opts: { msg?: any; receipt?: any; member?: any } = {}) => {
    const messageRepo = {
      findOne: jest.fn(async () => (opts.msg === undefined ? baseMsg : opts.msg)),
      create: jest.fn((d: any) => d),
      save: jest.fn(async (m: any) => m),
    };
    receiptUpdate = jest.fn(async () => ({ affected: 1 }));
    const receiptRepo = {
      findOne: jest.fn(async () => opts.receipt ?? null),
      update: receiptUpdate,
      create: jest.fn((d: any) => ({ id: 'r-new', ...d })),
      save: jest.fn(async (r: any) => r),
    };
    const memberRepo = {
      findOne: jest.fn(async () => opts.member ?? { user_id: 'u2' }), // assertMember：默认任意调用者算成员
      find: jest.fn(async () => [{ user_id: 'u1' }, { user_id: 'u2' }]), // getMemberUserIds
    };
    dataSource = {
      getRepository: (entity: any) => {
        const name = entity?.name || '';
        if (name === 'Message') return messageRepo;
        if (name === 'ConversationMember') return memberRepo;
        if (name === 'MessageReceipt') return receiptRepo;
        return {};
      },
    };
    realtime = { emitToUsers: jest.fn().mockReturnValue(2), isReady: () => true };
    // v5.9.0 OSS 基线：构造函数第三个参数 OssService（焚毁文件清理用，本测试路径不触发，给替身即可）
    const oss: any = { deleteByUrl: jest.fn(async () => true) };
    svc = new MessageService(dataSource, realtime, oss);
  };

  beforeAll(() => {
    // 固定窗口参数，保证断言确定性（外部 .env 不影响本测试）
    process.env.BURN_MEDIA_BUFFER_SECONDS = '30';
    process.env.BURN_MEDIA_DEFAULT_WINDOW_SECONDS = '300';
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** 断言 burn_at ≈ 参考时刻 ± expectedSeconds 秒（容忍执行耗时） */
  const expectBurnAtAround = (burnAt: Date, expectedSeconds: number, t0: number, t1: number) => {
    expect(burnAt.getTime()).toBeGreaterThanOrEqual(t0 + expectedSeconds * 1000 - 50);
    expect(burnAt.getTime()).toBeLessThanOrEqual(t1 + expectedSeconds * 1000 + 50);
  };

  // ===== reveal：音视频消费窗口 =====

  it('reveal 音视频焚毁消息（ttl=10s，视频 30s）：窗口 = 30+30=60s，返回 media_burn_pending + deadline', async () => {
    buildSvc({ receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: null, burn_at: null } });
    const t0 = Date.now();
    const res: any = await svc.revealMessage('m1', 'u2', 30);
    const t1 = Date.now();

    expect(receiptUpdate).toHaveBeenCalledTimes(1);
    const [, updated] = receiptUpdate.mock.calls[0];
    expect(updated.revealed_at).toBeInstanceOf(Date);
    expectBurnAtAround(updated.burn_at, 60, t0, t1); // max(10, 30+30) = 60
    // 返回值：音视频标志 + 窗口截止（对齐前端契约字段名 media_burn_pending）
    expect(res.media_burn_pending).toBe(true);
    expect(typeof res.consume_deadline).toBe('string');
    expect(new Date(res.consume_deadline).getTime()).toBe(updated.burn_at.getTime());
  });

  it('reveal 音视频不带 duration：窗口退到默认 300s（max(10, 300)）', async () => {
    buildSvc({ receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: null, burn_at: null } });
    const t0 = Date.now();
    await svc.revealMessage('m1', 'u2');
    const t1 = Date.now();
    const [, updated] = receiptUpdate.mock.calls[0];
    expectBurnAtAround(updated.burn_at, 300, t0, t1);
  });

  it('用户 ttl 大于窗口（ttl=3600，视频 30s）：窗口 = ttl，保护期不被缩短', async () => {
    buildSvc({
      msg: { ...baseMsg, burn_ttl_seconds: 3600 },
      receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: null, burn_at: null },
    });
    const t0 = Date.now();
    await svc.revealMessage('m1', 'u2', 30);
    const t1 = Date.now();
    const [, updated] = receiptUpdate.mock.calls[0];
    expectBurnAtAround(updated.burn_at, 3600, t0, t1); // max(3600, 60) = 3600
  });

  it('reveal 文本焚毁消息：逻辑不变（burn_at = now + ttl，media_burn_pending=false）', async () => {
    buildSvc({
      msg: { ...baseMsg, type: 'text', content: '阅后即焚' },
      receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: null, burn_at: null },
    });
    const t0 = Date.now();
    const res: any = await svc.revealMessage('m1', 'u2', 30);
    const t1 = Date.now();
    const [, updated] = receiptUpdate.mock.calls[0];
    expectBurnAtAround(updated.burn_at, 10, t0, t1); // 文本：严格 = ttl，不吃 duration 参数
    expect(res.media_burn_pending).toBe(false);
    expect(res.consume_deadline).toBeUndefined();
  });

  it('reveal type=file + mp4 扩展名（前端发送视频实际走 file）：等同音视频，吃消费窗口', async () => {
    buildSvc({
      msg: { ...baseMsg, type: 'file', file_name: '团队周会.mp4', media_duration: 45 },
      receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: null, burn_at: null },
    });
    const t0 = Date.now();
    const res: any = await svc.revealMessage('m1', 'u2');
    const t1 = Date.now();
    const [, updated] = receiptUpdate.mock.calls[0];
    // 窗口 = max(10, 存库 media_duration 45 + 30 缓冲) = 75s；请求没传 duration 也吃存库值
    expectBurnAtAround(updated.burn_at, 75, t0, t1);
    expect(res.media_burn_pending).toBe(true);
  });

  it('reveal type=file + 非视频扩展名（pdf）：不吃窗口（burn_at = ttl），media_burn_pending=false', async () => {
    buildSvc({
      msg: { ...baseMsg, type: 'file', file_name: '合同扫描.pdf', media_duration: 45 },
      receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: null, burn_at: null },
    });
    const t0 = Date.now();
    const res: any = await svc.revealMessage('m1', 'u2', 45);
    const t1 = Date.now();
    const [, updated] = receiptUpdate.mock.calls[0];
    expectBurnAtAround(updated.burn_at, 10, t0, t1); // 普通文件焚毁：严格 = ttl
    expect(res.media_burn_pending).toBe(false);
  });

  it('reveal 优先用发送时存库的 media_duration，其次请求参数（存库 45 vs 请求 10 → 窗口按 45 算）', async () => {
    buildSvc({
      msg: { ...baseMsg, type: 'voice', media_duration: 45 },
      receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: null, burn_at: null },
    });
    const t0 = Date.now();
    await svc.revealMessage('m1', 'u2', 10);
    const t1 = Date.now();
    const [, updated] = receiptUpdate.mock.calls[0];
    // 存库 45 优先：max(10, 45+30) = 75s（若误用请求参数 10 则为 40s，断言能抓住）
    expectBurnAtAround(updated.burn_at, 75, t0, t1);
  });

  // ===== consume =====

  it('consume 正常流：burn_at 置为当下，广播 message:consumed，返回焚毁视图（already=false）', async () => {
    const future = new Date(Date.now() + 60 * 1000);
    buildSvc({ receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: new Date(), burn_at: future } });

    const t0 = Date.now();
    const res: any = await svc.consumeMessage('m1', 'u2');
    const t1 = Date.now();

    // 焚毁视图（对齐前端契约）：is_blurred=true、内容字段置 null、burned=true
    expect(res.id).toBe('m1');
    expect(res.conversation_id).toBe('c1');
    expect(res.is_blurred).toBe(true);
    expect(res.content).toBeNull();
    expect(res.file_url).toBeNull();
    expect(res.file_original_url).toBeNull();
    expect(res.burned).toBe(true);
    expect(res.already).toBe(false);
    expect(new Date(res.burn_at).getTime()).toBeGreaterThanOrEqual(t0 - 50);
    expect(new Date(res.burn_at).getTime()).toBeLessThanOrEqual(t1 + 50);
    expect(receiptUpdate).toHaveBeenCalledTimes(1);
    const [receiptId, updated] = receiptUpdate.mock.calls[0];
    expect(receiptId).toBe('r1');
    expectBurnAtAround(updated.burn_at, 0, t0, t1); // 拨到现在
    // 广播给会话全体成员（对端与本人其他设备实时切「已焚毁」态）
    expect(realtime.emitToUsers).toHaveBeenCalledWith(
      'message:consumed',
      ['u1', 'u2'],
      expect.objectContaining({ conversation_id: 'c1', message_id: 'm1', user_id: 'u2' }),
    );
  });

  it('consume 幂等：自己 burn_at 已过期（已消费过）→ already=true，不再 update、不再广播', async () => {
    const past = new Date(Date.now() - 1000);
    buildSvc({ receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: new Date(), burn_at: past } });

    const res: any = await svc.consumeMessage('m1', 'u2');
    expect(res.burned).toBe(true);
    expect(res.already).toBe(true);
    expect(res.content).toBeNull();
    expect(res.file_url).toBeNull();
    expect(receiptUpdate).not.toHaveBeenCalled();
    expect(realtime.emitToUsers).not.toHaveBeenCalled();
  });

  it('consume 消息已被调度器物理删除（竞态）→ already=true，不炸', async () => {
    buildSvc({ msg: null });
    const res = await svc.consumeMessage('m-gone', 'u2');
    expect(res).toEqual({ burned: true, already: true });
    expect(receiptUpdate).not.toHaveBeenCalled();
  });

  it('consume 未 reveal 过（无 receipt）→ 400「请先点开查看后再消费」', async () => {
    buildSvc({ receipt: null });
    await expect(svc.consumeMessage('m1', 'u2')).rejects.toThrow('请先点开查看后再消费');
  });

  it('consume 文本焚毁消息 → 400（仅音视频支持播完才焚）', async () => {
    buildSvc({
      msg: { ...baseMsg, type: 'text', content: '阅后即焚' },
      receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: new Date(), burn_at: new Date(Date.now() + 5000) },
    });
    await expect(svc.consumeMessage('m1', 'u2')).rejects.toThrow('仅音视频焚毁消息支持播完才焚');
  });

  it('consume type=file + mp4 扩展名 → 允许（等同音视频）', async () => {
    const future = new Date(Date.now() + 60 * 1000);
    buildSvc({
      msg: { ...baseMsg, type: 'file', file_name: '团队周会.mp4' },
      receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: new Date(), burn_at: future },
    });
    const res: any = await svc.consumeMessage('m1', 'u2');
    expect(res.burned).toBe(true);
    expect(res.already).toBe(false);
  });

  it('consume type=file + 非视频扩展名（pdf）→ 400', async () => {
    buildSvc({
      msg: { ...baseMsg, type: 'file', file_name: '合同扫描.pdf' },
      receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: new Date(), burn_at: new Date(Date.now() + 5000) },
    });
    await expect(svc.consumeMessage('m1', 'u2')).rejects.toThrow('仅音视频焚毁消息支持播完才焚');
  });

  it('consume 非焚毁消息（burn_ttl_seconds=null）→ 400', async () => {
    buildSvc({
      msg: { ...baseMsg, burn_ttl_seconds: null },
      receipt: { id: 'r1', message_id: 'm1', user_id: 'u2', revealed_at: new Date(), burn_at: null },
    });
    await expect(svc.consumeMessage('m1', 'u2')).rejects.toThrow('该消息不是焚毁消息');
  });
});

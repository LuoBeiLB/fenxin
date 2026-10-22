import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DataSource } from 'typeorm';
import { TokenService } from '../auth/token.service';
import { AppUser } from '../../entities/app-user.entity';
import { Device } from '../../entities/device.entity';
import { WsEventPayloadMap, WsServerEvent, WS_EVENTS, userRoom, deviceRoom } from './events.types';

/**
 * 实时事件网关（socket.io）。
 *
 * - 路径与 REST 全局前缀对齐：/api/v1/socket.io（不与任何 REST 路由冲突）。
 * - 握手鉴权：客户端在 handshake auth 里传 { token: '<access token>' }
 *   （兼容 Authorization: Bearer <token> 请求头）。校验逻辑与 JwtAuthGuard 完全一致：
 *   JWT 验签 + 账号仍为 active + 签发设备记录仍存在，任一失败立即断开连接。
 *   因此「停用账号 / 下线设备」对已建立的 WS 连接同样具备吊销语义（重连时会被拒）。
 * - 鉴权通过后 socket 加入房间 user:{userId}，业务侧（消息/会话/群组服务）
 *   通过 emitToUsers 定向推送到目标用户的全部在线设备。
 * - 本网关只做「服务端 → 客户端」单向推送，客户端不提交任何业务事件，
 *   所有写操作仍走 REST（享受校验管道 / 限流 / 审计）。
 */
@WebSocketGateway({
  namespace: '/',
  path: '/api/v1/socket.io',
  serveClient: false,
  cors: {
    credentials: true,
    // 与 main.ts 的 REST CORS 白名单语义保持一致：
    // 原生 App（RN）握手不带 Origin 直接放行；浏览器按 CORS_ORIGINS 白名单。
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      if (!origin) return callback(null, true);
      const list = (process.env.CORS_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.includes('*') || list.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('EventsGateway');

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly tokenService: TokenService,
    private readonly dataSource: DataSource,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      // 验签失败会 throw（与 JwtAuthGuard 的 verifyAccessToken 同一逻辑）
      const payload = this.tokenService.verifyAccessToken(token);

      const [user, device] = await Promise.all([
        this.dataSource.getRepository(AppUser).findOne({ where: { id: payload.userId } }),
        this.dataSource.getRepository(Device).findOne({
          where: { id: payload.deviceId, user_id: payload.userId },
        }),
      ]);
      if (!user || user.status !== 'active' || user.deleted_at) {
        throw new Error('账号已被停用或不存在');
      }
      if (!device) {
        throw new Error('设备已下线，请重新登录');
      }

      client.data.userId = payload.userId;
      client.data.deviceId = payload.deviceId;
      await client.join(userRoom(payload.userId));
      // 设备房间：供"只推给某一台设备"使用（登录冲突踢人）
      await client.join(deviceRoom(payload.deviceId));

      // V6.0 在线状态：连接数 +1，并刷新最后活跃时间（同一设备多标签页会累加）
      const deviceRepo = this.dataSource.getRepository(Device);
      await deviceRepo.increment({ id: payload.deviceId }, 'socket_count', 1);
      const now = new Date();
      await deviceRepo.update(
        { id: payload.deviceId },
        { is_online: true, online_at: now, last_active_at: now },
      );

      // 通知同账号其他设备"这台设备上线了"（设备管理页/在线状态展示用）
      this.emitToUsers(WS_EVENTS.DEVICE_ONLINE, [payload.userId], {
        device_id: payload.deviceId,
        online_at: now.toISOString(),
      });

      this.logger.log(`WS connected user=${payload.userId} sid=${client.id}`);
    } catch (err: any) {
      this.logger.warn(`WS handshake rejected: ${err?.message || 'invalid token'}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const userId = client.data?.userId;
    const deviceId = client.data?.deviceId;
    this.logger.log(`WS disconnected user=${userId ?? 'unknown'} sid=${client.id}`);
    if (!deviceId) return;

    // 连接数 -1（GREATEST 防并发下减成负数）
    const repo = this.dataSource.getRepository(Device);
    repo
      .createQueryBuilder()
      .update()
      .set({
        socket_count: () => 'GREATEST(socket_count - 1, 0)',
        last_active_at: new Date(),
      })
      .where('id = :deviceId', { deviceId })
      .execute()
      .catch((err: any) =>
        this.logger.warn(`WS disconnect update failed: ${err?.message || err}`),
      );

    // V6.2：连接数归 0 时**立即置离线**，不再等心跳超时。
    //
    // 为什么改：离线推送只对 `is_online = 0` 的用户发；而原先离线判定要等
    // PresenceScheduler 每分钟扫一次、且 last_active_at 超过 ONLINE_TTL_SECONDS(150s)，
    // 于是"App 切后台断连 → 最多约 210 秒后才判离线"，这期间的消息完全不推，
    // 表现为「控制台能收到、业务消息收不到」。
    //
    // 这里保留 socket_count 的保护：多标签页/多设备下只有最后一个连接断开才置离线，
    // 不会误判；PresenceScheduler 仍作为兜底（覆盖"断连事件丢失"的情况）。
    //
    // 两条 UPDATE 分开执行，避免 MySQL「SET 子句左到右求值」导致的 count 语义歧义。
    repo
      .createQueryBuilder()
      .update()
      .set({ is_online: false, offline_at: new Date() })
      .where('id = :deviceId', { deviceId })
      .andWhere('socket_count = 0')
      .andWhere('is_online = 1')
      .execute()
      .then((result) => {
        if ((result.affected ?? 0) > 0 && userId) {
          this.emitToUsers(WS_EVENTS.DEVICE_OFFLINE, [userId], {
            device_id: deviceId,
            offline_at: new Date().toISOString(),
          });
        }
      })
      .catch((err: any) =>
        this.logger.warn(`WS disconnect offline update failed: ${err?.message || err}`),
      );
  }

  /**
   * 向一组用户（及其全部在线设备）广播服务端事件。
   * 推送失败只记日志、绝不抛错，保证不影响 REST 业务主流程。
   */
  emitToUsers<E extends WsServerEvent>(
    event: E,
    userIds: string[],
    payload: WsEventPayloadMap[E],
  ): void {
    try {
      if (!userIds || userIds.length === 0 || !this.server) return;
      this.server.to(userIds.map(userRoom)).emit(event, payload);
    } catch (err: any) {
      this.logger.error(`emit ${event} failed: ${err?.message}`);
    }
  }

  /**
   * 只推给指定设备（V6.0）。
   * 用于登录冲突踢人：必须精准命中被踢设备，不能推给同账号新登录的那台。
   */
  emitToDevices<E extends WsServerEvent>(
    event: E,
    deviceIds: string[],
    payload: WsEventPayloadMap[E],
  ): void {
    try {
      if (!deviceIds || deviceIds.length === 0 || !this.server) return;
      this.server.to(deviceIds.map(deviceRoom)).emit(event, payload);
    } catch (err: any) {
      this.logger.error(`emit ${event} failed: ${err?.message}`);
    }
  }

  /** 从 handshake auth 或 Authorization 头中提取 access token */
  private extractToken(client: Socket): string {
    const auth = client.handshake.auth as { token?: string } | undefined;
    if (auth?.token && typeof auth.token === 'string') {
      return auth.token;
    }
    const header: string | undefined = client.handshake.headers?.authorization;
    if (header && header.startsWith('Bearer ')) {
      return header.slice(7);
    }
    throw new Error('handshake 未携带 access token');
  }
}

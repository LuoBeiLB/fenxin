// loadtest/e2e-send.js
// 压 E2E 加密消息发送路径（V4.0 §E2E 方案 B）
//
// 跑法：k6 run -e PHONE_A=13800000000 -e PASSWORD_A='Test@123456' -e PHONE_B=13800000001 -e PASSWORD_B='Test@123456' loadtest/e2e-send.js
// 流程：
//   1. setup：分别 login A 和 B + 双方上传假公钥（占位 base64，服务端只校验格式不验 X25519 point）
//           + 创建 A-B 私聊拿 conversationId
//   2. default：5 VU 30s，A 不断往 conversation 发密文（每条都带 cipher_text + nonce + ephemeral_pubkey）
//
// 观察指标：
//   - http_req_duration p(95) 期望 < 300ms（比明文多 2-3 个字段 + 强校验 + 阅后即焚定时任务轻微干扰）
//   - http_req_failed rate 期望 < 0.1（限流 60/min/user，5 VU 间隔 2s ≈ 75 req/min 略超，预期少量 429）
//   - 服务端日志 [MessageService] 不报错、密文字段都落库
//
// 注意：k6 不做真 X25519 加密（生成/协商密钥需要客户端 Web Crypto API），本脚本只压服务端
//       "接收密文 + 落库 + 强校验" 协议通道，跟加解密正确性无关。

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5s', target: 5 },
    { duration: '30s', target: 5 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.2'], // 允许少量 429（限流 60/min/user）
    http_req_duration: ['p(95)<400'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:9091';
const PHONE_A = __ENV.PHONE_A || '13800000000';
const PASSWORD_A = __ENV.PASSWORD_A || 'Test@123456';
const PHONE_B = __ENV.PHONE_B || '13800000001';
const PASSWORD_B = __ENV.PASSWORD_B || 'Test@123456';

const PUBKEY_A = 'PUBA' + 'A'.repeat(39) + '='; // 43 字符合法 base64
const PUBKEY_B = 'PUBB' + 'B'.repeat(39) + '='; // 43 字符合法 base64

function login(phone, password) {
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({
      phone,
      password,
      device_name: `k6-e2e-${phone}-${Date.now()}`,
      device_type: 'web', // 必须是 mobile/desktop/tablet/web 之一
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  // login 接口返回 201 Created（不是 200），都接受
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login ${phone} failed: ${res.status} ${res.body}`);
  }
  const body = JSON.parse(res.body);
  return {
    token: body.data.access_token,
    userId: body.data.user?.id,
  };
}

function uploadKey(token, pubkey) {
  const res = http.post(
    `${BASE}/api/v1/keys`,
    JSON.stringify({ identity_pubkey: pubkey }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
  );
  if (res.status !== 200) {
    throw new Error(`upload key failed: ${res.status} ${res.body}`);
  }
}

export function setup() {
  // 1. 双端登录
  const a = login(PHONE_A, PASSWORD_A);
  const b = login(PHONE_B, PASSWORD_B);

  // 2. 双端上传公钥
  uploadKey(a.token, PUBKEY_A);
  uploadKey(b.token, PUBKEY_B);

  // 3. 创建/拿 A-B 私聊
  const convRes = http.post(
    `${BASE}/api/v1/conversations/private`,
    JSON.stringify({ user_id: b.userId }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${a.token}`,
      },
    },
  );
  if (convRes.status !== 200 && convRes.status !== 201) {
    throw new Error(`create private conv failed: ${convRes.status} ${convRes.body}`);
  }
  const convBody = JSON.parse(convRes.body);
  const conversationId = convBody.data?.id || convBody.id;

  return {
    aToken: a.token,
    bUserId: b.userId,
    conversationId,
  };
}

export default function (data) {
  // 每条密文用不同 ephemeral pubkey（模拟客户端真实场景）
  const epk = 'EPK_' + Math.random().toString(36).slice(2).padEnd(39, 'x').slice(0, 39) + '=';
  // 12 字节 nonce 用时间戳后 12 字符 base64
  const nonceRaw = Date.now().toString().padStart(12, '0').slice(-12);
  const nonce = Buffer.from(nonceRaw).toString('base64').slice(0, 16).padEnd(16, 'A');
  // 假密文
  const cipher = 'CIPHER_' + Math.random().toString(36).slice(2).padEnd(80, 'x').slice(0, 80);

  const res = http.post(
    `${BASE}/api/v1/messages`,
    JSON.stringify({
      conversation_id: data.conversationId,
      type: 'text',
      content: '[加密消息]',
      sender_ephemeral_pubkey: epk,
      cipher_nonce: nonce,
      cipher_text: cipher,
      expires_in: '5s', // 加密 + 阅后即焚组合
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.aToken}`,
      },
    },
  );

  const ok = check(res, {
    'send encrypted 200/201': (r) => r.status === 200 || r.status === 201,
    'is_encrypted=true in response': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.data?.is_encrypted === true;
      } catch {
        return false;
      }
    },
  });

  // sleep 2s 错开：60/min/user 限流，5 VU 间隔 2s ≈ 150 req/min 略超（预期少量 429 落在 fail rate 上）
  sleep(2);
}

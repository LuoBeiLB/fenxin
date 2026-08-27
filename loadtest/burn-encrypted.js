// loadtest/burn-encrypted.js
// 端到端：E2E 加密消息 + 阅后即焚 → 验证 destroyMessages 链路
//
// 跑法：k6 run -e PHONE_A=13800000000 -e PASSWORD_A='Test@123456' -e PHONE_B=13800000001 -e PASSWORD_B='Test@123456' loadtest/burn-encrypted.js
// 流程（每个 VU）：
//   1. 发密文 + expiresIn='5s'（加密 + 阅后即焚组合）
//   2. sleep 70s（5s destroy_at + 60s burn scheduler tick 间隔 + 5s 兜底）
//   3. GET /messages/:convId 拉历史，验证：
//        - 该消息存在（没被硬删，destroyMessages 只置 is_destroyed=true）
//        - is_encrypted=true（保留标记，前端用这个判断"这条是密文但已销毁"）
//        - is_destroyed=true
//        - cipher_text === null（V4.0 §E2E 阅后即焚后密文 + ephemeral key 必须清掉）
//        - cipher_nonce === null
//        - sender_ephemeral_pubkey === null
//
// 观察指标：
//   - checks pass rate 期望 100%
//   - http_req_failed rate 期望 < 0.05（中间 sleep 70s 期间没流量）
//
// 跑完一次大概 80s/iter，10 VU parallel 会 80s 跑完；VU 数小一些（5 个）避免 device/会话过多。

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    burn_encrypted: {
      // per-vu-iterations：每个 VU 跑 1 次，3 VU 并行共 3 次 total（跟 "3 VU × 1 iter" 1:1 匹配）
      // shared-iterations 要求 iterations >= vus，3 VU × 1 iter 会报 configuration error
      executor: 'per-vu-iterations',
      vus: 3,
      iterations: 1,
      maxDuration: '180s',
    },
  },
  thresholds: {
    checks: ['rate>0.95'],
    http_req_failed: ['rate<0.1'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:9091';
const PHONE_A = __ENV.PHONE_A || '13800000000';
const PASSWORD_A = __ENV.PASSWORD_A || 'Test@123456';
const PHONE_B = __ENV.PHONE_B || '13800000001';
const PASSWORD_B = __ENV.PASSWORD_B || 'Test@123456';

const PUBKEY_A = 'PUBA' + 'A'.repeat(39);
const PUBKEY_B = 'PUBB' + 'B'.repeat(39);

function login(phone, password) {
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({
      phone,
      password,
      device_name: `k6-burn-${phone}-${Date.now()}`,
      device_type: 'web', // 必须是 mobile/desktop/tablet/web 之一
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  // login 接口返回 201 Created（不是 200），都接受
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login ${phone} failed: ${res.status} ${res.body}`);
  }
  const body = JSON.parse(res.body);
  return { token: body.data.access_token, userId: body.data.user?.id };
}

function uploadKey(token, pubkey) {
  const res = http.post(
    `${BASE}/api/v1/keys`,
    JSON.stringify({ identity_pubkey: pubkey }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`upload key failed: ${res.status} ${res.body}`);
  }
}

export function setup() {
  const a = login(PHONE_A, PASSWORD_A);
  const b = login(PHONE_B, PASSWORD_B);
  uploadKey(a.token, PUBKEY_A);
  uploadKey(b.token, PUBKEY_B);

  const convRes = http.post(
    `${BASE}/api/v1/conversations/private`,
    JSON.stringify({ user_id: b.userId }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` },
    },
  );
  if (convRes.status !== 200 && convRes.status !== 201) {
    throw new Error(`create private conv failed: ${convRes.status} ${convRes.body}`);
  }
  const convBody = JSON.parse(convRes.body);
  const conversationId = convBody.data?.id || convBody.id;
  return { aToken: a.token, conversationId };
}

export default function (data) {
  // 1. 发密文 + expiresIn='5s'
  const epk = 'EPK_' + Math.random().toString(36).slice(2).padEnd(39, 'x').slice(0, 39) + '=';
  const nonceRaw = Date.now().toString().padStart(12, '0').slice(-12);
  const nonce = Buffer.from(nonceRaw).toString('base64').slice(0, 16).padEnd(16, 'A');
  const cipher = 'CIPHER_' + Math.random().toString(36).slice(2).padEnd(80, 'x').slice(0, 80);

  const sendRes = http.post(
    `${BASE}/api/v1/messages`,
    JSON.stringify({
      conversation_id: data.conversationId,
      type: 'text',
      content: '[加密消息]',
      sender_ephemeral_pubkey: epk,
      cipher_nonce: nonce,
      cipher_text: cipher,
      expires_in: '5s',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.aToken}`,
      },
    },
  );
  const sentOk = check(sendRes, {
    'send encrypted 200/201': (r) => r.status === 200 || r.status === 201,
  });
  if (!sentOk) {
    console.error(`send failed: ${sendRes.status} ${sendRes.body}`);
    return;
  }
  const sentBody = JSON.parse(sendRes.body);
  const messageId = sentBody.data?.id || sentBody.id;
  if (!messageId) {
    console.error(`send response missing id: ${sendRes.body}`);
    return;
  }

  // 2. sleep 70s：5s destroy_at + 60s BurnScheduler tick + 5s 兜底
  sleep(70);

  // 3. GET /messages/:convId 拉历史（带 include_destroyed=true 才能查到已销毁消息，验 cipher 清空）
  const listRes = http.get(
    `${BASE}/api/v1/messages/${data.conversationId}?limit=50&include_destroyed=true`,
    { headers: { Authorization: `Bearer ${data.aToken}` } },
  );

  check(listRes, {
    'GET history 200': (r) => r.status === 200,
    'target message found': (r) => {
      try {
        const body = JSON.parse(r.body);
        const list = body.data || body;
        if (!Array.isArray(list)) return false;
        const target = list.find((m) => m.id === messageId);
        if (!target) return false;
        // 销毁后字段验证
        const ok =
          target.is_encrypted === true &&
          target.is_destroyed === true &&
          target.cipher_text === null &&
          target.cipher_nonce === null &&
          target.sender_ephemeral_pubkey === null;
        if (!ok) {
          console.error(`message state wrong: ${JSON.stringify(target)}`);
        }
        return ok;
      } catch (e) {
        console.error(`parse error: ${e}`);
        return false;
      }
    },
  });
}

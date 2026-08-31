// loadtest/burn-encrypted.js
// 端到端：E2E 加密消息 + 点开才焚 v2 → 验证「马赛克 → reveal → 全员到期物理删除」链路
//
// 跑法：k6 run -e PHONE_A=13800000000 -e PASSWORD_A='Test@123456' -e PHONE_B=13800000001 -e PASSWORD_B='Test@123456' loadtest/burn-encrypted.js
// 流程（每个 VU）：
//   1. 发密文 + burn_ttl_seconds=5（加密 + 点开才焚组合）
//   2. GET 列表验证马赛克：is_blurred=true 且 cipher_text 等内容字段全 null（未点开前服务端不下发内容）
//   3. B（接收方）+ A（发送方）都调 POST /messages/:id/reveal —— 全员点开才满足「全员看完」物理删除条件
//      验证 reveal 响应：is_blurred=false、密文字段齐全、remain_seconds≈5
//   4. sleep 70s（5s burn_at 倒计时 + 60s BurnScheduler tick + 5s 余量）
//   5. GET 列表验证：该消息已不存在（全员倒计时到期 → 整行物理删除，不回收到列表）
//
// 观察指标：
//   - checks pass rate 期望 100%
//   - http_req_failed rate 期望 < 0.1（中间 sleep 70s 期间没流量）
//
// 跑完一次大概 80s/iter，3 VU × 1 iter 约 80s 跑完。

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    burn_encrypted: {
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
  return { aToken: a.token, bToken: b.token, conversationId };
}

function findMessage(listRes, messageId) {
  try {
    const body = JSON.parse(listRes.body);
    const list = body.data || body;
    if (!Array.isArray(list)) return undefined;
    return list.find((m) => m.id === messageId);
  } catch {
    return undefined;
  }
}

export default function (data) {
  // 1. 发密文 + burn_ttl_seconds=5
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
      burn_ttl_seconds: 5,
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

  // 2. 未点开前拉列表：必须是马赛克（is_blurred=true，内容字段全 null）
  const beforeList = http.get(`${BASE}/api/v1/messages/${data.conversationId}?limit=50`, {
    headers: { Authorization: `Bearer ${data.bToken}` },
  });
  check(beforeList, {
    'blurred before reveal': (r) => {
      const target = findMessage(r, messageId);
      if (!target) return false;
      return (
        target.is_blurred === true &&
        target.cipher_text === null &&
        target.cipher_nonce === null &&
        target.sender_ephemeral_pubkey === null
      );
    },
  });

  // 3. 双方 reveal（全员点开 → 才能触发「全员看完」物理删除）
  for (const [who, token] of [['B', data.bToken], ['A', data.aToken]]) {
    const revealRes = http.post(
      `${BASE}/api/v1/messages/${messageId}/reveal`,
      null,
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
    );
    check(revealRes, {
      [`reveal ${who} 200`]: (r) => r.status === 200 || r.status === 201,
      [`reveal ${who} full content`]: (r) => {
        try {
          const body = JSON.parse(r.body);
          const d = body.data || body;
          return (
            d.is_blurred === false &&
            d.cipher_text !== null &&
            d.cipher_nonce !== null &&
            d.sender_ephemeral_pubkey !== null &&
            typeof d.remain_seconds === 'number' &&
            d.remain_seconds >= 1 &&
            d.remain_seconds <= 5
          );
        } catch {
          return false;
        }
      },
    });
  }

  // 4. sleep 70s：5s burn_at 倒计时 + 60s BurnScheduler tick + 5s 余量
  sleep(70);

  // 5. 拉列表验证：消息已物理删除（整行 DELETE，列表里找不到）
  const afterList = http.get(`${BASE}/api/v1/messages/${data.conversationId}?limit=50`, {
    headers: { Authorization: `Bearer ${data.aToken}` },
  });
  check(afterList, {
    'GET history 200': (r) => r.status === 200,
    'message physically deleted': (r) => findMessage(r, messageId) === undefined,
  });
}

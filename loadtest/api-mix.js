// loadtest/api-mix.js
// 压鉴权缓存命中后的业务读接口（验证 V4.0 §M7 性能优化效果）
//
// 跑法：k6 run loadtest/api-mix.js
// 流程：
//   1. setup：单点 login 拿 1 个 token，所有 VU 共用（避免 5/min login 限流干扰）
//   2. default：30s 内 10 VU 并发跑业务读为主 + 少量写，验证 cache 命中后 p95
//
// 观察指标：
//   - http_req_duration p(95) 期望 < 200ms（cache 命中：JWT 守卫 0 SQL）
//   - http_req_failed 期望 < 0.01（只可能是限流或 token 过期）
//
// 关闭缓存对比：把 .env 的 AUTH_CACHE_TTL_MS=0，p(95) 应该涨到 300-500ms

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5s', target: 10 },
    { duration: '30s', target: 10 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<200'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:9091';
const PHONE = __ENV.PHONE || '13800000000';
const PASSWORD = __ENV.PASSWORD || 'Test@123456';

export function setup() {
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({
      phone: PHONE,
      password: PASSWORD,
      device_name: 'k6-mix-setup',
      device_type: 'k6',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const body = JSON.parse(res.body);
  if (!body.data?.access_token) {
    throw new Error(`setup login failed: ${res.status} ${res.body}`);
  }
  return { token: body.data.access_token, deviceId: body.data.device?.id };
}

export default function (data) {
  const headers = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.token}`,
    },
  };

  // 80% 读 / 20% 写（写只有心跳，不刷缓存）
  if (Math.random() < 0.8) {
    const reads = [
      '/api/v1/auth/profile',
      '/api/v1/auth/devices',
      '/api/v1/contacts',
    ];
    const path = reads[Math.floor(Math.random() * reads.length)];
    const res = http.get(`${BASE}${path}`, headers);
    check(res, { 'GET 200': (r) => r.status === 200 });
  } else {
    // 心跳：路径里有 deviceId，setup 已经拿到
    const res = http.post(
      `${BASE}/api/v1/auth/devices/${data.deviceId}/heartbeat`,
      '{}',
      headers,
    );
    check(res, { 'heartbeat 200': (r) => r.status === 200 });
  }
  sleep(1);
}

// loadtest/login-burst.js
// 压 /api/v1/auth/login —— 验证鉴权限流（5/min/IP） + 登录路径数据库负担
//
// 跑法：k6 run loadtest/login-burst.js
// 自定义：k6 run -e BASE_URL=http://localhost:9091 -e PHONE=13800000000 -e PASSWORD='Test@123456' loadtest/login-burst.js
//
// 观察指标：
//   - http_req_failed 期望 0（除非触发了 5/min 限流）
//   - http_req_duration p(95)：首次登录 ~150-300ms（含 argon2 verify + 2 次 SQL 写）

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 5 }, // ramp up
    { duration: '30s', target: 5 }, // steady 5 VU
    { duration: '5s', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.1'],
    http_req_duration: ['p(95)<800'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:9091';
const PHONE = __ENV.PHONE || '13800000000';
const PASSWORD = __ENV.PASSWORD || 'Test@123456';

export default function () {
  // 每次不同 deviceName，避免 1 个用户堆 N 台 device
  const deviceName = `k6-vu${__VU}-iter${__ITER}-${Date.now()}`;
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({
      phone: PHONE,
      password: PASSWORD,
      device_name: deviceName,
      device_type: 'k6',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, {
    'login 200': (r) => r.status === 200,
    'has access_token': (r) => {
      try {
        return !!JSON.parse(r.body).data?.access_token;
      } catch {
        return false;
      }
    },
  });
  // sleep 15s 错开：单 IP 5/min 限流，间隔要够长
  sleep(15);
}

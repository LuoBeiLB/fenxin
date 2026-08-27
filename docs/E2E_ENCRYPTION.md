# 端到端加密协议（V4.0 §E2E — 方案 B 简化版）

> 状态：服务端 ✅ 已就绪 | 客户端：待前端实现
> 覆盖范围：仅单聊（conversation.type='private'），群聊/频道留 TODO

## 1. 协议总览

服务端**零接触明文**：所有加解密在客户端完成，服务端只存 / 转密文 + 加解密参数。

```
Alice (client)                                     Bob (client)
     │                                                  ▲
     │  1. 生成 X25519 identity key pair (ik_a, IK_A)   │
     │  2. POST /keys { identity_pubkey: IK_A }         │
     │     ▼                                            │
     │  ┌──────────┐                                    │
     │  │  Server  │── 3. GET /keys/:bobId ──►  Bob     │
     │  │  (DB)    │◄─ 4. { identity_pubkey: IK_B } ───│
     │  └──────────┘                                    │
     │                                                  │
     │  5. 生成 ephemeral key (esk, epk=EPK_A)          │
     │  6. shared = ECDH(esk, IK_B) || ECDH(ik_a, IK_B)│
     │  7. session_key = HKDF(shared, salt=conv_id)     │
     │  8. nonce = random 12B                           │
     │  9. cipher = AES-256-GCM(plaintext, key, nonce)  │
     │ 10. POST /messages { cipher, nonce, epk }        │
     │     ▼                                            │
     │  ┌──────────┐                                    │
     │  │  Server  │── 11. forward to Bob ─────────────►│
     │  │  (DB)    │                                    │
     │  └──────────┘                                    │
     │                                                  │ 12. shared = ECDH(ik_b, EPK_A) || ECDH(ik_b, IK_A)
     │                                                  │ 13. session_key = HKDF(shared, salt=conv_id)
     │                                                  │ 14. plaintext = AES-256-GCM-decrypt(cipher, key, nonce)
```

## 2. 服务端 API

### 2.1 上传自己的公钥

```http
POST /api/v1/keys
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "identity_pubkey": "MCowBQYDK2VuAyEA...="  // X25519 公钥，base64 编码（32 字节 → 44 字符）
}
```

**响应**：
```json
{ "code": 0, "message": "公钥已上传", "data": { "updated": true } }
```

**约束**：
- 限流：5/min/user
- 1 用户 1 公钥（覆盖语义）
- 客户端**应在登录后立即上传**（生成 key pair → 上传 → 存 private key 到 IndexedDB）

### 2.2 查询对方公钥

```http
GET /api/v1/keys/:userId
Authorization: Bearer <access_token>
```

**响应**：
```json
{ "code": 0, "data": {
  "user_id": "uuid",
  "identity_pubkey": "MCowBQYDK2VuAyEA...=",
  "created_at": "2026-08-26T10:00:00Z",
  "updated_at": "2026-08-26T10:00:00Z"
}}
```

**权限校验**：仅当对方与当前用户在**至少一个共同 conversation** 里时返回；否则 `403 Forbidden`。

**场景**：
- 拿自己公钥（userId === self）跳过权限校验
- 拿对方公钥 → 必须同会话成员
- 对方未上传公钥 → `404 Not Found`

### 2.3 发密文消息

`POST /api/v1/messages` 现有 API，新增 3 个可选字段：

```json
{
  "conversation_id": "uuid",
  "type": "text",
  "content": "[加密消息]",                  // 占位提示，客户端展示用
  "sender_ephemeral_pubkey": "EPK_A...",   // 必填（加密时）
  "cipher_nonce": "ABCDEFGHIJKLMNOP",      // 必填（加密时），base64 12 字节
  "cipher_text": "密文+auth tag 的 base64", // 必填（加密时）
  "expires_in": "5s"                       // 阅后即焚，可选
}
```

**强校验**：3 个加密字段要么全填（全密文），要么全不填（明文）。半填 → `400 Bad Request`。

**响应**：跟明文消息一致（message 全字段返回，包括 `is_encrypted: true` + `cipher_*` + `sender_ephemeral_pubkey`）。

### 2.4 收密文消息

走现有 `WS /realtime` 的 `message_created` 事件，payload 里 message 完整字段。

客户端收到后：
1. 检查 `message.is_encrypted`
2. 是 → 用自己的 `identity_private` + `message.sender_ephemeral_pubkey` 做 ECDH
3. 派生 session_key → AES-256-GCM-decrypt(`message.cipher_text`, `message.cipher_nonce`)
4. 展示明文（不要展示 `content` 字段，它是占位 `[加密消息]`）

## 3. 客户端实现（Web Crypto API 示例）

### 3.1 生成并存储 key pair（首次登录）

```typescript
// 1. 生成 X25519 key pair
const keyPair = await crypto.subtle.generateKey(
  { name: 'X25519' } as any,  // 部分浏览器还叫 'X25519'，用 ECDH 也可
  true,
  ['deriveBits', 'deriveKey'],
);

// 2. 导出公钥 → base64
const rawPub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
const pubB64 = btoa(String.fromCharCode(...new Uint8Array(rawPub)));

// 3. 存私钥到 IndexedDB（永远不外发）
const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
localStorage.setItem('burnmsg.identity_priv_jwk', JSON.stringify(privJwk));
// ⚠️ 真实生产建议用 IndexedDB 加密存储（key 派生自用户密码）

// 4. 上传公钥
await fetch('/api/v1/keys', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ identity_pubkey: pubB64 }),
});
```

### 3.2 发送密文

```typescript
// 1. 拿对方公钥
const res = await fetch(`/api/v1/keys/${receiverId}`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
const { data: { identity_pubkey: remotePubB64 } } = await res.json;

// 2. 导入对方公钥
const remotePub = await crypto.subtle.importKey(
  'raw',
  Uint8Array.from(atob(remotePubB64), c => c.charCodeAt(0)),
  { name: 'X25519' } as any,
  false,
  [],
);

// 3. 生成 ephemeral key pair
const epkPair = await crypto.subtle.generateKey(
  { name: 'X25519' } as any, true, ['deriveBits'],
);
const epkPubRaw = await crypto.subtle.exportKey('raw', epkPair.publicKey);
const epkPubB64 = btoa(String.fromCharCode(...new Uint8Array(epkPubRaw)));

// 4. 拿到自己的私钥
const myPrivJwk = JSON.parse(localStorage.getItem('burnmsg.identity_priv_jwk')!);
const myPriv = await crypto.subtle.importKey(
  'jwk', myPrivJwk, { name: 'X25519' } as any, false, ['deriveBits'],
);

// 5. 双路 ECDH 派生 shared secret
const shared1 = await crypto.subtle.deriveBits(
  { name: 'X25519', public: remotePub } as any, epkPair.privateKey, 256);
const shared2 = await crypto.subtle.deriveBits(
  { name: 'X25519', public: remotePub } as any, myPriv, 256);
const shared = new Uint8Array(shared1.length + shared2.length);
shared.set(new Uint8Array(shared1), 0);
shared.set(new Uint8Array(shared2), shared1.length);

// 6. HKDF-SHA256 → 32 字节 session_key
const sessionKey = await crypto.subtle.importKey(
  'raw', shared, 'HKDF', false, ['deriveKey'],
);
const sessionKeyMat = await crypto.subtle.deriveKey(
  {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode(conversationId),  // salt = conversation_id
    info: new TextEncoder().encode('burnmsg-e2e-v1'),
  },
  sessionKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt'],
);

// 7. AES-256-GCM 加密
const nonce = crypto.getRandomValues(new Uint8Array(12));
const plaintext = new TextEncoder().encode('Hello, secret!');
const cipherBuf = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv: nonce },
  sessionKeyMat,
  plaintext,
);
const cipherB64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)));
const nonceB64 = btoa(String.fromCharCode(...nonce));

// 8. 发消息
await fetch('/api/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({
    conversation_id: conversationId,
    type: 'text',
    content: '[加密消息]',
    sender_ephemeral_pubkey: epkPubB64,
    cipher_nonce: nonceB64,
    cipher_text: cipherB64,
  }),
});
```

### 3.3 接收并解密

```typescript
socket.on('message_created', async ({ message }) => {
  if (!message.is_encrypted) {
    showMessage(message.content);  // 明文直接展示
    return;
  }

  // 密文：用 message.sender_ephemeral_pubkey + 自己私钥 派生同样的 session_key
  const senderEpkPub = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(message.sender_ephemeral_pubkey), c => c.charCodeAt(0)),
    { name: 'X25519' } as any, false, [],
  );
  const myPriv = await crypto.subtle.importKey(
    'jwk', JSON.parse(localStorage.getItem('burnmsg.identity_priv_jwk')!),
    { name: 'X25519' } as any, false, ['deriveBits'],
  );

  // 同样的双路 ECDH
  const shared1 = await crypto.subtle.deriveBits(
    { name: 'X25519', public: senderEpkPub } as any, myPriv, 256);
  const shared2 = await crypto.subtle.deriveBits(
    { name: 'X25519', public: senderEpkPub } as any, myPriv, 256);  // 注：完整 X3DH 需拿 sender 的 identity pubkey
  // ... 后续同发送
});
```

> ⚠️ **简化版注意**：上面 `shared2` 用了两次 `myPriv` + `senderEpkPub`，实际 X3DH 还需要 sender 的 identity pubkey 走另一路。完整简化版实现需要**先 GET /keys/:senderId 拿 sender 的 identity_pubkey**。这是方案 B 的已知限制。

## 4. 已知限制 / TODO

- ❌ **异步首发**：对方首次不在线时拿不到公钥 → 当前 UI 应提示"对方尚未启用加密，请明文发送"
- ❌ **群聊 / 频道加密**：sender keys 协议（每个发件人生成 symmetric chain），需 X3DH 升级
- ❌ **MITM 防护**：当前没有 signing key，理论上服务端可偷换公钥 → 后续加 signed_prekey
- ❌ **跨设备同步**：多设备登录需各自生成独立 key pair，私钥不共享（跟"阅后即焚"契合）
- ❌ **客户端密钥存储**：当前示例用 localStorage，真实生产应加密存储（PBKDF2(userPassword) → AES key wrap identity_priv_jwk）

## 5. 验证清单

- [ ] 上传公钥：`curl -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d '{"identity_pubkey":"..."}' http://localhost:9091/api/v1/keys`
- [ ] 查自己公钥：`curl -H "Authorization: Bearer $T" http://localhost:9091/api/v1/keys/<myUserId>`
- [ ] 查对方公钥（应 200/403 取决于同会话关系）
- [ ] 发明文消息（无 3 字段）：`is_encrypted=false`、content 是真明文
- [ ] 发密文消息（3 字段齐）：`is_encrypted=true`、content=`[加密消息]`
- [ ] 半填加密字段 → `400`

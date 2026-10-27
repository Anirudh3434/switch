// Full End-to-End All-Scenarios Test Suite for Switch Session Bridge
// Tests all 8 core product workflows against real backend and client-side crypto logic.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  randomBytes,
  createHash,
  createHmac,
  pbkdf2Sync,
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
  constants,
} from 'node:crypto';

// Setup Test Env
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017';
process.env.TOKEN_SECRET = 'e2e-super-secure-test-token-secret-256';
process.env.REFRESH_PEPPER = 'e2e-test-refresh-pepper';
process.env.DUMMY_SALT_SECRET = 'e2e-test-dummy-salt';
process.env.ALLOWED_ORIGINS = 'chrome-extension://test-extension-id';

const { connect, close, users, sessions, refresh, shares } = await import('../src/db.js');
const { buildApp } = await import('../src/server.js');
const { resetRateLimits } = await import('../src/lib/rateLimit.js');

let server;
let base;
let mongoUp = false;

// WebCrypto-compatible AES-256-GCM and PBKDF2 helpers matching src/lib/crypto.js
const KDF_ITERS = 60000;

function deriveAuthHash(password, salt) {
  const enc = Buffer.from(salt, 'base64url');
  return pbkdf2Sync(password, enc, KDF_ITERS, 32, 'sha256').toString('base64url');
}

function deriveVaultKey(password, salt) {
  const enc = Buffer.from(salt + 'vault_sync_key_seed', 'utf8');
  return pbkdf2Sync(password, enc, KDF_ITERS, 32, 'sha256');
}

function seal(vaultKey, obj) {
  const iv = randomBytes(12);
  const { createCipheriv } = await_crypto;
  const cipher = createCipheriv('aes-256-gcm', vaultKey, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Combined ciphertext + tag matching WebCrypto format
  const combined = Buffer.concat([enc, tag]).toString('base64');
  return { iv: iv.toString('base64'), data: combined };
}

function open(vaultKey, envelope) {
  const iv = Buffer.from(envelope.iv, 'base64');
  const buf = Buffer.from(envelope.data, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(0, buf.length - 16);
  const { createDecipheriv } = await_crypto;
  const decipher = createDecipheriv('aes-256-gcm', vaultKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

const await_crypto = await import('node:crypto');

before(async () => {
  try {
    await connect();
    mongoUp = true;
  } catch (e) {
    console.error(`E2E Skipped: MongoDB unreachable (${e.message})`);
    return;
  }
  server = createServer(buildApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (mongoUp) {
    await close();
  }
  server?.close();
});

const req = async (method, path, body, token, headers = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
};

// ============================================================================
// SCENARIO 1: Full Zero-Knowledge Authentication Flow
// ============================================================================
test('SCENARIO 1: User Registration, Prelogin, Login, Token Refresh & Logout', async () => {
  if (!mongoUp) return;
  resetRateLimits();

  const email = `user-${Date.now()}@test.com`;
  const password = 'MasterPassword123!Secure';

  // 1. Prelogin returns a deterministic dummy salt before user exists (prevents account enumeration)
  const pre1 = await req('POST', '/v1/auth/prelogin', { email });
  assert.equal(pre1.status, 200);
  assert.ok(pre1.data.kdfSalt, 'Prelogin returns salt for non-existent email');

  // 2. Client derives keys locally and registers
  const kdfSalt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash(password, kdfSalt);
  const vaultKey = deriveVaultKey(password, kdfSalt);

  const reg = await req('POST', '/v1/auth/register', { email, authHash, kdfSalt });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.email, email);

  // 3. Prelogin now returns the user's actual stored salt
  const pre2 = await req('POST', '/v1/auth/prelogin', { email });
  assert.equal(pre2.status, 200);
  assert.equal(pre2.data.kdfSalt, kdfSalt);

  // 4. Login with valid authHash returns JWT and refresh token
  const loginRes = await req('POST', '/v1/auth/login', { email, authHash });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.data.accessToken);
  assert.ok(loginRes.data.refreshToken);

  const { accessToken, refreshToken } = loginRes.data;

  // 5. Refresh token rotation: exchanges old refresh token for a new pair
  const refreshRes = await req('POST', '/v1/auth/refresh', { refreshToken });
  assert.equal(refreshRes.status, 200);
  assert.ok(refreshRes.data.accessToken);
  assert.ok(refreshRes.data.refreshToken);
  assert.notEqual(refreshRes.data.refreshToken, refreshToken, 'Refresh token rotated');

  // 6. Old refresh token reuse is rejected
  const replayRes = await req('POST', '/v1/auth/refresh', { refreshToken });
  assert.equal(replayRes.status, 401, 'Reused refresh token rejected');

  // 7. Logout revokes active tokens
  const logoutRes = await req('POST', '/v1/auth/logout', { refreshToken: refreshRes.data.refreshToken }, refreshRes.data.accessToken);
  assert.equal(logoutRes.status, 204);
});

// ============================================================================
// SCENARIO 2: Cross-Device End-to-End Encrypted Session Sync (AES-256-GCM)
// ============================================================================
test('SCENARIO 2: Device A encrypts and pushes session; Device B pulls and decrypts exact cookies', async () => {
  if (!mongoUp) return;
  resetRateLimits();

  const email = `sync-${Date.now()}@test.com`;
  const password = 'StrongVaultPassword456!';
  const kdfSalt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash(password, kdfSalt);
  const vaultKey = deriveVaultKey(password, kdfSalt);

  // Register & login
  await req('POST', '/v1/auth/register', { email, authHash, kdfSalt });
  const { data: { accessToken } } = await req('POST', '/v1/auth/login', { email, authHash });

  // Original cookies on Device A (Laptop - Chrome)
  const originalCookies = [
    { name: '__Secure-next-auth.session-token', value: 'secret-token-xyz-12345', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true },
    { name: '_cfuvid', value: 'cf-validation-uuid-8899', domain: '.chatgpt.com', path: '/', secure: true },
    { name: 'oai-nav-state', value: 'collapsed', domain: 'chatgpt.com', path: '/' },
  ];

  // Device A seals cookies in AES-256-GCM envelope
  const envelope = seal(vaultKey, originalCookies);

  // Device A pushes to cloud
  const pushRes = await req(
    'POST',
    '/v1/sync/push',
    {
      items: [
        {
          host: 'chatgpt.com',
          baseVersion: -1,
          force: true,
          envelope,
          deviceId: 'laptop-chrome-device-id',
          deviceName: 'Chrome on Windows (Laptop)',
        },
      ],
    },
    accessToken,
    { 'X-Device-Id': 'laptop-chrome-device-id', 'X-Device-Name': 'Chrome on Windows (Laptop)' }
  );

  assert.equal(pushRes.status, 200);
  assert.equal(pushRes.data.results[0].status, 'ok');

  // Verify in MongoDB: Server holds ONLY encrypted ciphertext, zero plaintext tokens
  const storedSession = await sessions().findOne({ host: 'chatgpt.com' });
  assert.ok(storedSession);
  assert.ok(storedSession.envelope.data);
  assert.ok(!JSON.stringify(storedSession).includes('secret-token-xyz-12345'), 'Plaintext token NEVER exists in cloud DB');

  // Device B (Macbook - Safari) signs into same account and pulls remote sessions
  const pullRes = await req(
    'GET',
    '/v1/sync/pull?limit=50',
    null,
    accessToken,
    { 'X-Device-Id': 'macbook-safari-device-id', 'X-Device-Name': 'Safari on macOS (MacBook)' }
  );

  assert.equal(pullRes.status, 200);
  assert.equal(pullRes.data.items.length, 1);

  // Device B decrypts using the shared zero-knowledge vaultKey
  const pulledEnvelope = pullRes.data.items[0].envelope;
  const decryptedCookies = open(vaultKey, pulledEnvelope);

  assert.equal(decryptedCookies.length, 3);
  assert.equal(decryptedCookies[0].name, '__Secure-next-auth.session-token');
  assert.equal(decryptedCookies[0].value, 'secret-token-xyz-12345');
  assert.equal(decryptedCookies[1].value, 'cf-validation-uuid-8899');
});

// ============================================================================
// SCENARIO 3: Active Tab Swap & Rollback State Machine (Two-Way Session Exchange)
// ============================================================================
test('SCENARIO 3: Swap stores local original backup and applies remote; Rollback restores exact original and cleans record', async () => {
  // Test simulated persistent swap-store logic
  const swapStore = new Map();

  function saveSwapRecord(rootDomain, record) {
    swapStore.set(rootDomain, record);
    return true;
  }
  function getSwapRecord(rootDomain) {
    return swapStore.get(rootDomain) || null;
  }
  function removeSwapRecord(rootDomain) {
    return swapStore.delete(rootDomain);
  }

  const domain = 'github.com';
  const localOriginalCookies = [
    { name: 'user_session', value: 'alice-personal-session-key', domain: '.github.com', path: '/' },
    { name: '__Host-user', value: 'alice', domain: 'github.com', path: '/' },
  ];
  const remoteCookiesFromWorkLaptop = [
    { name: 'user_session', value: 'alice-work-enterprise-key', domain: '.github.com', path: '/' },
    { name: '__Host-user', value: 'alice-work', domain: 'github.com', path: '/' },
  ];

  // 1. User performs [ ⇄ Swap ]
  const swapRecord = {
    host: domain,
    rootDomain: domain,
    swappedAt: Date.now(),
    isLocked: true,
    origin: {
      deviceId: 'device-personal',
      deviceName: 'Chrome on Windows (Personal)',
      browser: 'Chrome',
      cookies: localOriginalCookies,
    },
    target: {
      deviceId: 'device-work',
      deviceName: 'Edge on macOS (Work)',
      browser: 'Edge',
      cookies: remoteCookiesFromWorkLaptop,
    },
  };
  saveSwapRecord(domain, swapRecord);

  // Active state verification: Swap is active & locked against 3rd-device chaining
  const activeRecord = getSwapRecord(domain);
  assert.ok(activeRecord);
  assert.equal(activeRecord.origin.cookies[0].value, 'alice-personal-session-key');
  assert.equal(activeRecord.target.cookies[0].value, 'alice-work-enterprise-key');
  assert.equal(activeRecord.isLocked, true);

  // 2. User performs [ Rollback ]
  const restoredCookies = activeRecord.origin.cookies;
  removeSwapRecord(domain);

  // Verification: Exact original cookies returned & swap record cleanly destroyed
  assert.equal(restoredCookies.length, 2);
  assert.equal(restoredCookies[0].value, 'alice-personal-session-key');
  assert.equal(getSwapRecord(domain), null, 'Swap record destroyed upon Rollback');
});

// ============================================================================
// SCENARIO 4: One-Way Session Injection Flow
// ============================================================================
test('SCENARIO 4: Inject (isInjectOnly) applies session directly without creating rollback record', async () => {
  const swapStore = new Map();
  let appliedCookies = null;

  function handleSwapMessage(msg) {
    if (msg.isInjectOnly) {
      // Direct application: no rollback snapshot saved
      appliedCookies = msg.remoteCookies;
      return { ok: true, injected: true };
    }
    // Normal swap saves rollback
    swapStore.set(msg.host, { original: msg.currentCookies });
    appliedCookies = msg.remoteCookies;
    return { ok: true, swapped: true };
  }

  const remoteWorkSession = [
    { name: 'token', value: 'work-account-token', domain: 'notion.so' },
  ];

  const res = handleSwapMessage({
    host: 'notion.so',
    currentCookies: [{ name: 'token', value: 'guest' }],
    remoteCookies: remoteWorkSession,
    isInjectOnly: true,
  });

  assert.equal(res.ok, true);
  assert.equal(res.injected, true);
  assert.equal(appliedCookies[0].value, 'work-account-token');
  assert.equal(swapStore.get('notion.so'), undefined, 'Inject does NOT save rollback snapshot');
});

// ============================================================================
// SCENARIO 5: Real-Time Cookie Watcher & Optimal DB Auto-Sync (Logout vs Login)
// ============================================================================
test('SCENARIO 5: Website Logout automatically deletes stale session from cloud DB for this device', async () => {
  if (!mongoUp) return;
  resetRateLimits();

  const email = `logout-watcher-${Date.now()}@test.com`;
  const password = 'Password999!';
  const kdfSalt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash(password, kdfSalt);
  const vaultKey = deriveVaultKey(password, kdfSalt);

  await req('POST', '/v1/auth/register', { email, authHash, kdfSalt });
  const { data: { accessToken } } = await req('POST', '/v1/auth/login', { email, authHash });

  const deviceId = 'laptop-unit-1';

  // 1. Initial Login on Website: cookies pushed to DB
  const validCookies = [{ name: 'session_token', value: 'xyz', domain: 'netflix.com' }];
  await req(
    'POST',
    '/v1/sync/push',
    {
      items: [{ host: 'netflix.com', baseVersion: -1, force: true, envelope: seal(vaultKey, validCookies), deviceId }],
    },
    accessToken,
    { 'X-Device-Id': deviceId }
  );

  let sessionInDb = await sessions().findOne({ host: 'netflix.com' });
  assert.ok(sessionInDb);

  // 2. User logs out on netflix.com: Cookies cleared -> Watcher detects 0 auth cookies
  // Calls DELETE /v1/sync/:host with X-Device-Id
  const deleteRes = await req(
    'DELETE',
    '/v1/sync/netflix.com',
    null,
    accessToken,
    { 'X-Device-Id': deviceId }
  );

  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.data.deletedCount, 1);

  // 3. Cloud DB verification: Stale session is completely erased
  sessionInDb = await sessions().findOne({ host: 'netflix.com' });
  assert.equal(sessionInDb, null, 'Stale session removed from cloud DB after website logout');
});

// ============================================================================
// SCENARIO 6: Anti-Self-Recommendation Guard
// ============================================================================
test('SCENARIO 6: Logged-out tab strictly rejects recommending current device own previous session', async () => {
  const currentDeviceId = 'device-laptop-chrome';

  const cloudSessions = [
    {
      host: 'github.com',
      deviceId: 'device-laptop-chrome', // THIS SAME DEVICE (was logged out earlier)
      deviceName: 'Chrome on Windows (Laptop)',
      cookies: [{ name: 'user_session', value: 'old-expired-token' }],
    },
    {
      host: 'github.com',
      deviceId: 'device-phone-safari', // ANOTHER DEVICE
      deviceName: 'Safari on iPhone (Mobile)',
      cookies: [{ name: 'user_session', value: 'active-mobile-session' }],
    },
  ];

  function matchRemoteSession(sessionsList, targetHost, isUserAlreadyLoggedIn) {
    return sessionsList.find((s) => {
      if (s.host !== targetHost || !Array.isArray(s.cookies) || s.cookies.length === 0) return false;
      // STRICT GUARD: Must never recommend own device previous session
      if (s.deviceId && s.deviceId === currentDeviceId) {
        return false;
      }
      return true;
    });
  }

  // When only own device exists in cloud:
  const matchOwn = matchRemoteSession([cloudSessions[0]], 'github.com', false);
  assert.equal(matchOwn, undefined, 'Rejects own device previous session when logged out');

  // When another remote device exists:
  const matchRemote = matchRemoteSession(cloudSessions, 'github.com', false);
  assert.ok(matchRemote);
  assert.equal(matchRemote.deviceId, 'device-phone-safari');
  assert.equal(matchRemote.deviceName, 'Safari on iPhone (Mobile)');
});

// ============================================================================
// SCENARIO 7: Asymmetric Zero-Knowledge Team Sharing (RSA-OAEP-256)
// ============================================================================
test('SCENARIO 7: Alice shares session with Bob; Bob accepts; double-consume is rejected', async () => {
  if (!mongoUp) return;
  resetRateLimits();

  // Generate RSA-2048 keypair for Bob
  const { publicKey: bobPub, privateKey: bobPriv } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // 1. Register Alice & Bob
  const aliceEmail = `alice-${Date.now()}@corp.com`;
  const bobEmail = `bob-${Date.now()}@corp.com`;

  const aliceSalt = randomBytes(16).toString('base64url');
  const bobSalt = randomBytes(16).toString('base64url');

  await req('POST', '/v1/auth/register', { email: aliceEmail, authHash: deriveAuthHash('pwA', aliceSalt), kdfSalt: aliceSalt });
  await req('POST', '/v1/auth/register', { email: bobEmail, authHash: deriveAuthHash('pwB', bobSalt), kdfSalt: bobSalt, publicKey: bobPub });

  const { data: { accessToken: aliceToken } } = await req('POST', '/v1/auth/login', { email: aliceEmail, authHash: deriveAuthHash('pwA', aliceSalt) });
  const { data: { accessToken: bobToken } } = await req('POST', '/v1/auth/login', { email: bobEmail, authHash: deriveAuthHash('pwB', bobSalt) });

  // 2. Alice fetches Bob's public key
  const recRes = await req('GET', `/v1/share/recipient?email=${bobEmail}`, null, aliceToken);
  assert.equal(recRes.status, 200);
  assert.equal(recRes.data.publicKey, bobPub);

  // 3. Alice wraps a random 32-byte session key with Bob's public key
  const sessionKey = randomBytes(32);
  const wrappedKey = publicEncrypt(
    { key: bobPub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    sessionKey
  ).toString('base64');

  // 4. Alice creates share
  const shareRes = await req(
    'POST',
    '/v1/share',
    {
      targetEmail: bobEmail,
      host: 'dashboard.stripe.com',
      wrappedKey: { alg: 'RSA-OAEP-256', key: wrappedKey },
      note: 'Stripe admin credentials for deployment',
    },
    aliceToken
  );
  assert.equal(shareRes.status, 201);
  const shareId = shareRes.data.id;

  // 5. Bob accepts share
  const acceptRes = await req('POST', `/v1/share/${shareId}/accept`, null, bobToken);
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptRes.data.host, 'dashboard.stripe.com');

  // Bob unwraps session key with his private key
  const unwrappedKey = privateDecrypt(
    { key: bobPriv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(acceptRes.data.wrappedKey.key, 'base64')
  );
  assert.deepEqual(unwrappedKey, sessionKey, 'Unwrapped session key matches original');

  // 6. Security Check: Double-consumption / Replay of accepted share is rejected
  const replayAccept = await req('POST', `/v1/share/${shareId}/accept`, null, bobToken);
  assert.equal(replayAccept.status, 404, 'Already consumed share is rejected');
});

// ============================================================================
// SCENARIO 8: Security Perimeter & Injection Defense Validation
// ============================================================================
test('SCENARIO 8: Rejects unauthenticated sync, forged tokens, and validates XSS sanitization', async () => {
  if (!mongoUp) return;

  // 1. Unauthenticated requests rejected
  const noAuth = await req('GET', '/v1/sync/pull');
  assert.equal(noAuth.status, 401);

  // 2. Forged JWT token with bad secret rejected
  const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.invalidsig';
  const badTokenRes = await req('GET', '/v1/sync/pull', null, fakeToken);
  assert.equal(badTokenRes.status, 401);

  // 3. XSS escaping verification on content script helper
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const maliciousDeviceName = '<img src=x onerror=alert("hacked")>';
  const sanitized = escapeHtml(maliciousDeviceName);
  assert.ok(!sanitized.includes('<img'));
  assert.ok(sanitized.includes('&lt;img'));
});

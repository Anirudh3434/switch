// End-to-end smoke test against a real MongoDB.
//
// Exercises the actual zero-knowledge path: client-side PBKDF2 -> authHash,
// login, push/pull with version conflicts, tombstones, and key handoff.
// Skips cleanly when MongoDB is unreachable.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createHash,
  pbkdf2Sync,
  randomBytes,
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
  constants,
} from 'node:crypto';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017';
process.env.TOKEN_SECRET ||= 'test-secret';
process.env.ALLOWED_ORIGINS ||= '';

const { connect, close } = await import('../src/db.js');
const { buildApp } = await import('../src/server.js');
const { resetRateLimits } = await import('../src/lib/rateLimit.js');

let server;
let base;
let mongoUp = false;

before(async () => {
  try {
    await connect();
    mongoUp = true;
  } catch (e) {
    console.log(`SKIPPING: MongoDB unreachable (${e.message})`);
    return;
  }
  server = createServer(buildApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await close();
  server?.close();
});

// Each test gets a fresh rate-limit window so the suite doesn't depend on
// ordering (all tests share one source IP).
beforeEach(() => resetRateLimits());

const post = (path, body, token) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (path, token, headers = {}) =>
  fetch(base + path, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });

// --- client-side crypto simulation -----------------------------------------

// Mirrors what the extension derives: authHash = PBKDF2(password, salt||"auth")
const deriveAuthHash = (password, salt) =>
  pbkdf2Sync(password, salt + 'auth', 60000, 32, 'sha256').toString('base64url');

const fakeEnvelope = (secret) => ({
  iv: randomBytes(12).toString('base64url'),
  data: createHash('sha256').update(secret).digest('base64url'),
});

test('prelogin returns a stable salt even for unknown accounts', async () => {
  if (!mongoUp) return;
  const a = await (await post('/v1/auth/prelogin', { email: 'ghost@example.com' })).json();
  const b = await (await post('/v1/auth/prelogin', { email: 'ghost@example.com' })).json();
  assert.equal(a.kdfSalt, b.kdfSalt);
  assert.ok(a.kdfSalt.length >= 16);
});

test('register -> login -> push -> pull, full cycle', async () => {
  if (!mongoUp) return;

  const email = `user-${Date.now()}@example.com`;
  const salt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash('correct horse battery staple', salt);

  const reg = await post('/v1/auth/register', { email, authHash, kdfSalt: salt });
  assert.equal(reg.status, 201);
  const { accessToken } = await reg.json();

  const login = await post('/v1/auth/login', { email, authHash });
  assert.equal(login.status, 200);
  const { accessToken: token2 } = await login.json();
  assert.ok(token2);

  const push = await post(
    '/v1/sync/push',
    { items: [{ host: 'github.com', baseVersion: 0, envelope: fakeEnvelope('gh') }] },
    token2,
  );
  assert.equal(push.status, 200);
  const pushBody = await push.json();
  assert.equal(pushBody.results[0].status, 'ok');
  assert.equal(pushBody.results[0].version, 1);

  const pull = await get('/v1/sync/pull?since=0', token2);
  const pullBody = await pull.json();
  const gh = pullBody.items.find((i) => i.host === 'github.com');
  assert.ok(gh, 'pulled item should exist');
  assert.equal(gh.version, 1);
  assert.ok(accessToken);
});

test('refresh rotates the token and rejects reuse (regression: $oid crash)', async () => {
  if (!mongoUp) return;

  const email = `refresh-${Date.now()}@example.com`;
  const salt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash('refresh-pw', salt);

  await post('/v1/auth/register', { email, authHash, kdfSalt: salt });
  const login = await (await post('/v1/auth/login', { email, authHash })).json();
  assert.ok(login.refreshToken, 'login issues a refresh token');

  // This call crashed the entire server before the fix: the handler looked the
  // user up with `{ _id: { $oid: record.userId } }`, and MongoDB rejects `$oid`
  // as an unknown query operator.
  const refreshed = await post('/v1/auth/refresh', { refreshToken: login.refreshToken });
  assert.equal(refreshed.status, 200, 'refresh must succeed');
  const rotated = await refreshed.json();
  assert.ok(rotated.accessToken, 'refresh returns a new access token');
  assert.ok(rotated.refreshToken, 'refresh returns a rotated refresh token');
  assert.notEqual(rotated.refreshToken, login.refreshToken, 'refresh token must rotate');

  // The spent token must be dead (rotation, not reuse).
  const reuse = await post('/v1/auth/refresh', { refreshToken: login.refreshToken });
  assert.equal(reuse.status, 401, 'reusing a spent refresh token must fail');

  // A garbage userId in the record must 401, not throw.
  const garbage = await post('/v1/auth/refresh', { refreshToken: 'not-a-real-token' });
  assert.equal(garbage.status, 401);

  // The server is still alive after all of that.
  assert.equal((await get('/healthz')).status, 200);
});

test('stale baseVersion is rejected as a conflict, not silently overwritten', async () => {
  if (!mongoUp) return;

  const email = `conflict-${Date.now()}@example.com`;
  const salt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash('pw', salt);
  await post('/v1/auth/register', { email, authHash, kdfSalt: salt });
  const { accessToken: token } = await (await post('/v1/auth/login', { email, authHash })).json();

  // Device A writes v1, then v2.
  await post('/v1/sync/push', { items: [{ host: 'bank.example', baseVersion: 0, envelope: fakeEnvelope('a') }] }, token);
  await post('/v1/sync/push', { items: [{ host: 'bank.example', baseVersion: 1, envelope: fakeEnvelope('b') }] }, token);

  // Device B still thinks it's at v0 — its write must NOT clobber A's.
  const stale = await post(
    '/v1/sync/push',
    { items: [{ host: 'bank.example', baseVersion: 0, envelope: fakeEnvelope('c') }] },
    token,
  );
  const body = await stale.json();
  assert.equal(body.results[0].status, 'conflict');
  assert.equal(body.results[0].version, 2);
  assert.ok(body.results[0].envelope, 'conflict returns the winning envelope');
});

test('wrong password cannot log in', async () => {
  if (!mongoUp) return;

  const email = `wrongpw-${Date.now()}@example.com`;
  const salt = randomBytes(16).toString('base64url');
  await post('/v1/auth/register', {
    email,
    authHash: deriveAuthHash('right-pw', salt),
    kdfSalt: salt,
  });

  const bad = await post('/v1/auth/login', { email, authHash: deriveAuthHash('wrong-pw', salt) });
  assert.equal(bad.status, 401);
});

test('unauthenticated sync is rejected', async () => {
  if (!mongoUp) return;
  const res = await get('/v1/sync/list');
  assert.equal(res.status, 401);
});

test('sharing wraps with the recipient public key the server cannot unwrap', async () => {
  if (!mongoUp) return;

  // Generate real RSA keypairs the way the extension would.
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const a = `alice-${Date.now()}@example.com`;
  const b = `bob-${Date.now()}@example.com`;
  const saltA = randomBytes(16).toString('base64url');
  const saltB = randomBytes(16).toString('base64url');

  await post('/v1/auth/register', {
    email: a,
    authHash: deriveAuthHash('pwA', saltA),
    kdfSalt: saltA,
    publicKey: kp.publicKey,
  });
  await post('/v1/auth/register', {
    email: b,
    authHash: deriveAuthHash('pwB', saltB),
    kdfSalt: saltB,
  });

  const { accessToken: alice } = await (await post('/v1/auth/login', {
    email: a,
    authHash: deriveAuthHash('pwA', saltA),
  })).json();
  const { accessToken: bob } = await (await post('/v1/auth/login', {
    email: b,
    authHash: deriveAuthHash('pwB', saltB),
  })).json();

  // Bob publishes his public key; Alice fetches it to wrap the session for him.
  const bobKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const putKey = await fetch(base + '/v1/user/public-key', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${bob}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: bobKey.publicKey }),
  });
  assert.equal(putKey.status, 204);

  const recip = await (await get(`/v1/share/recipient?email=${b}`, alice)).json();
  assert.ok(recip.publicKey, 'recipient lookup returns the published key');

  const sessionKey = randomBytes(32);
  const wrapped = publicEncrypt(
    { key: recip.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    sessionKey,
  ).toString('base64url');

  const share = await post(
    '/v1/share',
    { targetEmail: b, host: 'shop.example', wrappedKey: { alg: 'RSA-OAEP-256', key: wrapped } },
    alice,
  );
  assert.equal(share.status, 201);

  const inbox = await (await get('/v1/share/incoming', bob)).json();
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].host, 'shop.example');

  // Bob can unwrap what Alice sent — the courier delivered without reading it.
  const unwrapped = privateDecrypt(
    { key: bobKey.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(inbox.items[0].wrappedKey.key, 'base64url'),
  );
  assert.deepEqual(unwrapped, sessionKey);
});

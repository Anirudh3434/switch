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
process.env.REFRESH_PEPPER ||= 'test-refresh-pepper';
process.env.DUMMY_SALT_SECRET ||= 'test-dummy-salt';
process.env.ALLOWED_ORIGINS ||= '';
process.env.ALLOW_UNVERIFIED_REGISTRATION ||= 'true';

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
    if (process.env.ALLOW_DB_TEST_SKIP === '1') {
      console.log(`SKIPPING: MongoDB unreachable (${e.message})`);
      return;
    }
    // A green suite that never ran is worse than a red suite. Opt into
    // skipping explicitly with ALLOW_DB_TEST_SKIP=1.
    throw new Error(
      `MongoDB unreachable (${e.message}). Start MongoDB or set ALLOW_DB_TEST_SKIP=1 to skip DB tests.`,
    );
  }
  server = createServer(buildApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (mongoUp) await close();
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

const postAsDevice = (path, body, token, deviceId) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(deviceId ? { 'X-Device-Id': deviceId } : {}),
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

  // The spent token must be dead (rotation, not reuse). A concurrent refresh
  // race returns 409 so the client can retry; a later replay is 401.
  const reuse = await post('/v1/auth/refresh', { refreshToken: login.refreshToken });
  assert.ok([401, 409].includes(reuse.status), 'reusing a spent refresh token must fail');

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

test('admin API is closed without an allowlisted caller', async () => {
  if (!mongoUp) return;

  const anonymous = await get('/v1/admin/overview');
  assert.equal(anonymous.status, 401, 'admin requires a bearer token');

  const email = `notadmin-${Date.now()}@example.com`;
  const salt = randomBytes(16).toString('base64url');
  await post('/v1/auth/register', {
    email,
    authHash: deriveAuthHash('pw', salt),
    kdfSalt: salt,
  });
  const { accessToken } = await (await post('/v1/auth/login', {
    email,
    authHash: deriveAuthHash('pw', salt),
  })).json();

  const forbidden = await get('/v1/admin/overview', accessToken);
  assert.equal(forbidden.status, 403, 'ordinary users cannot read admin telemetry');
});

test('logout ends this browser only and preserves synced sessions', async () => {
  if (!mongoUp) return;

  const email = `logout-${Date.now()}@example.com`;
  const salt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash('pw', salt);
  await post('/v1/auth/register', { email, authHash, kdfSalt: salt });

  const first = await (await post('/v1/auth/login', { email, authHash })).json();
  const second = await (await post('/v1/auth/login', { email, authHash })).json();

  await post(
    '/v1/sync/push',
    { items: [{ host: 'keep.example', baseVersion: 0, envelope: fakeEnvelope('keep') }] },
    first.accessToken,
  );

  const out = await post('/v1/auth/logout', { refreshToken: first.refreshToken }, first.accessToken);
  assert.equal(out.status, 204);

  // The session must still be there.
  const list = await (await get('/v1/sync/list', first.accessToken)).json();
  assert.ok(list.items.some((i) => i.host === 'keep.example'));

  // The other browser's refresh token must still work.
  const other = await post('/v1/auth/refresh', { refreshToken: second.refreshToken });
  assert.equal(other.status, 200, 'signing out one browser must not sign out the others');
});

test('reinstall can merge an old device record instead of leaving a duplicate', async () => {
  if (!mongoUp) return;

  const email = `adopt-${Date.now()}@example.com`;
  const salt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash('pw', salt);

  // Simulate the previous install: its refresh token is bound to the old id.
  const oldId = 'dev_oldinstall000000000001';
  const newId = 'dev_newinstall000000000001';
  const reg = await postAsDevice(
    '/v1/auth/register',
    { email, authHash, kdfSalt: salt },
    null,
    oldId,
  );
  assert.equal(reg.status, 201);
  const { accessToken, refreshToken: oldRefresh } = await reg.json();

  for (const deviceId of [oldId, newId]) {
    const r = await postAsDevice(
      '/v1/user/devices',
      { deviceId, name: 'Chrome on Windows 10/11', browserInfo: { browser: 'Chrome', os: 'Windows 10/11' } },
      accessToken,
      deviceId,
    );
    assert.equal(r.status, 200);
  }

  // A device cannot adopt itself, and the target id must be well formed.
  const self = await postAsDevice(
    '/v1/user/devices/adopt',
    { deviceId: newId },
    accessToken,
    newId,
  );
  assert.equal(self.status, 400);
  const malformed = await postAsDevice(
    '/v1/user/devices/adopt',
    { deviceId: 'bad id with spaces' },
    accessToken,
    newId,
  );
  assert.equal(malformed.status, 400);

  // Old install has a sole host and a newer copy of a shared host.
  for (let v = 0; v < 3; v++) {
    await postAsDevice(
      '/v1/sync/push',
      { items: [{ host: 'shared.example', baseVersion: v, envelope: fakeEnvelope(`old-${v}`) }] },
      accessToken,
      oldId,
    );
  }
  await postAsDevice(
    '/v1/sync/push',
    { items: [{ host: 'old-only.example', baseVersion: 0, envelope: fakeEnvelope('old-only') }] },
    accessToken,
    oldId,
  );
  await postAsDevice(
    '/v1/sync/push',
    { items: [{ host: 'shared.example', baseVersion: 0, envelope: fakeEnvelope('new-0') }] },
    accessToken,
    newId,
  );

  // A different account must not be able to adopt this device.
  const otherEmail = `adopt-other-${Date.now()}@example.com`;
  const otherSalt = randomBytes(16).toString('base64url');
  const otherReg = await post('/v1/auth/register', {
    email: otherEmail,
    authHash: deriveAuthHash('pw', otherSalt),
    kdfSalt: otherSalt,
  });
  const { accessToken: otherToken } = await otherReg.json();
  const foreign = await postAsDevice(
    '/v1/user/devices/adopt',
    { deviceId: oldId },
    otherToken,
    'dev_attacker0000000000001',
  );
  assert.equal(foreign.status, 404, 'adoption is scoped to the authenticated account');

  const adopt = await postAsDevice(
    '/v1/user/devices/adopt',
    { deviceId: oldId, name: 'Chrome on Windows 10/11', browserInfo: { browser: 'Chrome', os: 'Windows 10/11' } },
    accessToken,
    newId,
  );
  assert.equal(adopt.status, 200);
  const adopted = await adopt.json();
  assert.equal(adopted.deviceId, newId);
  assert.equal(adopted.adoptedDeviceId, oldId);
  assert.equal(adopted.movedSessions, 1, 'old-only host moves across');
  assert.equal(adopted.mergedSessions, 1, 'newer copy on the old install wins');
  assert.equal(adopted.revokedRefreshTokens, 1, 'dead install refresh token is deleted');

  // The duplicate device row is gone; only the current install remains.
  const deviceList = await (await get('/v1/user/devices', accessToken)).json();
  assert.equal(deviceList.items.length, 1);
  assert.equal(deviceList.items[0].deviceId, newId);
  assert.ok(deviceList.items[0].createdAt, 'merge keeps a first-seen timestamp');

  // Both hosts now belong to the current device, and the newer version won.
  const list = await (await get('/v1/sync/list', accessToken, { 'X-Device-Id': newId })).json();
  const oldOnly = list.items.find((i) => i.host === 'old-only.example');
  const shared = list.items.find((i) => i.host === 'shared.example');
  assert.ok(oldOnly, 'adopted host survives');
  assert.equal(oldOnly.deviceId, newId);
  assert.equal(shared.version, 3);
  assert.equal(shared.deviceId, newId);

  // The old install's credentials were revoked, not silently carried over.
  const dead = await post('/v1/auth/refresh', { refreshToken: oldRefresh });
  assert.equal(dead.status, 401);

  // Adoption is not idempotent: the record is already gone.
  const again = await postAsDevice(
    '/v1/user/devices/adopt',
    { deviceId: oldId },
    accessToken,
    newId,
  );
  assert.equal(again.status, 404);
});

test('deletes are tombstones and force cannot bypass a version conflict', async () => {
  if (!mongoUp) return;

  const email = `tombstone-${Date.now()}@example.com`;
  const salt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash('pw', salt);
  await post('/v1/auth/register', { email, authHash, kdfSalt: salt });
  const { accessToken: token } = await (await post('/v1/auth/login', { email, authHash })).json();

  await post(
    '/v1/sync/push',
    { items: [{ host: 'github.com', baseVersion: 0, envelope: fakeEnvelope('v1') }] },
    token,
  );

  const del = await fetch(base + '/v1/sync/github.com', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(del.status, 200);

  const pulled = await (await get('/v1/sync/pull?since=0', token)).json();
  const tomb = pulled.items.find((i) => i.host === 'github.com');
  assert.ok(tomb, 'tombstone is visible to other devices');
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.envelope, null);

  // A stale writer using the old baseVersion (and force:true) must lose.
  const stale = await post(
    '/v1/sync/push',
    {
      items: [
        {
          host: 'github.com',
          baseVersion: 1,
          force: true,
          envelope: fakeEnvelope('resurrect'),
        },
      ],
    },
    token,
  );
  const staleBody = await stale.json();
  assert.equal(staleBody.results[0].status, 'conflict');
  assert.equal(staleBody.results[0].deleted, true);

  // Adopting the tombstone's version allows a deliberate re-save.
  const fresh = await post(
    '/v1/sync/push',
    { items: [{ host: 'github.com', baseVersion: 2, envelope: fakeEnvelope('v3') }] },
    token,
  );
  const freshBody = await fresh.json();
  assert.equal(freshBody.results[0].status, 'ok');
  assert.equal(freshBody.results[0].version, 3);
});

test('account deletion erases the account and invalidates live tokens', async () => {
  if (!mongoUp) return;

  const email = `erase-${Date.now()}@example.com`;
  const salt = randomBytes(16).toString('base64url');
  const authHash = deriveAuthHash('pw', salt);
  await post('/v1/auth/register', { email, authHash, kdfSalt: salt });
  const { accessToken } = await (await post('/v1/auth/login', { email, authHash })).json();

  await post(
    '/v1/sync/push',
    { items: [{ host: 'erase.example', baseVersion: 0, envelope: fakeEnvelope('x') }] },
    accessToken,
  );

  const exported = await (await get('/v1/user/export', accessToken)).json();
  assert.equal(exported.user.email, email);
  assert.ok(exported.sessions.some((s) => s.host === 'erase.example'));

  const del = await fetch(base + '/v1/user/account', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(del.status, 204);

  assert.equal((await get('/v1/sync/list', accessToken)).status, 401);
  assert.equal((await post('/v1/auth/login', { email, authHash })).status, 401);
});

test('OTP responses never contain the code and reset requests do not enumerate accounts', async () => {
  if (!mongoUp) return;

  const send = await post('/v1/auth/otp/send', {
    email: `otp-${Date.now()}@example.com`,
    purpose: 'account verification',
  });
  assert.equal(send.status, 200);
  const body = await send.json();
  assert.equal(body.devOtp, undefined);
  assert.equal(body.otp, undefined);

  const unknown = await post('/v1/auth/forgot-password', {
    email: `missing-${Date.now()}@example.com`,
  });
  assert.equal(unknown.status, 200);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.error, undefined);
  assert.ok(!JSON.stringify(unknownBody).includes('not found'));
});

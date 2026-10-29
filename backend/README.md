# Switch Backend

Zero-knowledge sync server for the Switch session bridge. Node 20+ / Express /
MongoDB.

**The server cannot read your sessions.** It stores opaque ciphertext and
routing metadata. There is no decryption path anywhere in this codebase — if
you ever find one, that is a bug, not a feature.

---

## Run it

```bash
cd backend
cp .env.example .env          # set MONGODB_URI
npm install
npm start                     # http://localhost:8080
```

Or with Docker:

```bash
docker compose up -d          # starts mongo + api
```

Smoke and E2E tests need a reachable MongoDB. They **fail loudly** if it is not
available, so a missing database cannot look like a passing suite. Set
`ALLOW_DB_TEST_SKIP=1` only when you deliberately want to skip them:

```bash
npm run smoke
npm test
```

---

## Architecture

```
Client (extension)                        Server
─────────────────────────────             ─────────────────────────────
master password
   ├─ PBKDF2(pw, salt‖"auth") ─────────► authHash   (stored as scrypt hash)
   ├─ PBKDF2(pw, salt‖"enc")            enc key    ✗ never leaves client
   └─ random 32B vault key
        wrapped by enc key ────────────► envelope   (AES-256-GCM ciphertext)
```

Because the auth and enc derivations use **different PBKDF2 labels**, a stolen
`authHash` does not yield the vault key. The server additionally scrypts
`authHash` at rest, so a DB dump isn't even a reusable login credential.

### Key handoff (team sharing)

Alice wants to hand Bob a logged-in session:

1. `GET /v1/share/recipient?email=bob` → Bob's **public** key
2. Alice wraps the session's vault key with Bob's key (`RSA-OAEP-256`)
3. `POST /v1/share` → server stores the wrapped blob
4. Bob's client unwraps it with his **private** key, which never left his device

The server is a courier: it can prove *who sent what to whom*, but cannot read
any of it.

---

## API

Base: `/v1`. Auth: `Authorization: Bearer <accessToken>`.
Device tracking: optional `X-Device-Id` / `X-Device-Name` headers.

### Auth & Email OTP Verification

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/otp/send` | `{email, purpose?}` | `{ok, message, expiresIn, cooldown}` |
| POST | `/auth/otp/verify` | `{email, otp, purpose?}` | `{ok, verified, email, verificationToken}` |
| POST | `/auth/prelogin` | `{email}` | `{kdfSalt, kdfIterations}` |
| POST | `/auth/register` | `{email, authHash, kdfSalt, kdfIterations, publicKey?, verificationToken?, otp?}` | `{user, accessToken, refreshToken, expiresIn}` |
| POST | `/auth/login` | `{email, authHash}` | `{user, accessToken, refreshToken, expiresIn}` |
| POST | `/auth/refresh` | `{refreshToken}` | `{accessToken, refreshToken, expiresIn}` (rotates; one concurrent retry returns 409) |
| POST | `/auth/logout` | `{refreshToken, deviceId?}` | `204` (local sign-out; revokes only that refresh token) |
| GET | `/auth/me` | — | `{user}` |

`prelogin` returns a **deterministic dummy salt** and the default iteration count
for unknown accounts, so its response cannot be used to enumerate users.

In production, registration requires a verified email (`verificationToken` or
`otp`). `ALLOW_UNVERIFIED_REGISTRATION=true` is a **non-production test escape
hatch only** and is ignored when `NODE_ENV=production`. OTPs are never returned
in API responses; in non-production with SMTP unconfigured they are only logged
to the server console.

#### Gmail SMTP Setup
To send real verification emails via Gmail SMTP, configure your Google App Password in `.env`:
1. Enable 2-Step Verification on your Google Account: [https://myaccount.google.com/security](https://myaccount.google.com/security)
2. Generate an App Password under Security → 2-Step Verification → App passwords: [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Set in `.env`:
   ```bash
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=your-address@your-domain.example
   SMTP_PASS=xxxx xxxx xxxx xxxx  # 16-character Google App Password
   SMTP_FROM="Switch Vault <no-reply@switch.local>"
   ```
*If `SMTP_USER` or `SMTP_PASS` is empty, a **non-production** server runs in
simulation mode and logs the 6-digit OTP to its console. Production refuses to
rely on that: OTPs are never written to API responses.*


### Sync

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| POST | `/sync/push` | `{items:[{host, baseVersion, envelope}]}` | Max 100 per batch |
| GET | `/sync/pull` | `?since=<epochMs>&limit=<1-500>` | Returns `{items, cursor, hasMore}` |
| GET | `/sync/list` | — | Index only, no payloads |
| DELETE | `/sync/:host` | — | Tombstone, propagates on pull |

**Envelope shape:** `{ v: 2, iv: base64url, data: base64url }` — output of the
extension's `seal()`. `v:2` binds the ciphertext to the host through AES-GCM
additional authenticated data; legacy `v:1` envelopes without AAD remain
readable, and clients re-seal them on the next write. Max 8 MB each.

**Conflict resolution — last-writer-wins with explicit versions.** Each item
carries a `version`. Clients send the version they last saw as `baseVersion`:

- matches → write applies, `version` increments
- mismatch → response is `{status:'conflict', version, envelope}` with the
  **winning** record, so the client can reconcile instead of clobbering

This is what stops a laptop that was offline for a week from silently
overwriting a fresher session on your phone.

Pull uses a **5-second overlap window** on `since` to tolerate clock skew.

### Sharing

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/share/recipient?email=` | — | Their public key |
| POST | `/share` | `{targetEmail, host, wrappedKey:{alg:'RSA-OAEP-256', key}, note?}` | |
| GET | `/share/incoming` | — | Pending shares + wrapped keys |
| POST | `/share/:id/accept` | — | Marks consumed; client then pushes its own sealed copy |
| DELETE | `/share/:id` | — | Decline / revoke before acceptance |
| DELETE | `/share/sent/:id` | — | Sender pulls it back |

> Revoking a share does **not** retract a session the recipient already
> imported. Say so in the UI — this surprises people.

### User

| Method | Path | Notes |
|---|---|---|
| GET | `/user/devices` | Browsers that have checked in |
| POST | `/user/devices/adopt` | Merges an old install into the calling `X-Device-Id` |
| DELETE | `/user/devices/:deviceId` | Removes that device's synced copies and refresh tokens |
| PUT | `/user/public-key` | Publish key for shares |
| GET | `/user/export` | JSON export of account, device, session-envelope and share metadata |
| DELETE | `/user/data` | Irreversible erasure of account and all associated records |

`DELETE /user/data` removes the user row, encrypted sessions, refresh tokens,
devices, recovery keys, OTPs and shares in both directions. It does not leave a
"deactivated" account that can be resurrected.

`POST /user/devices/adopt` exists for reinstalls. Uninstalling the extension
clears its local storage, so the browser generates a new `deviceId` while the
old record remains. The caller names the old `deviceId`; the server moves its
encrypted sessions to the calling device (newest version wins per host), deletes
the old install's refresh tokens, and removes the duplicate device row. The
client only offers this after explicit user confirmation, because two real
machines can share the same browser and OS.

### Health

`GET /healthz` → `{ok:true, ts}`

---

## Security posture

**Implemented**
- Zero-knowledge: no plaintext, no key, no decryption path server-side
- scrypt (N=16384) for the stored credential; `timingSafeEqual` everywhere
- Uniform prelogin response → no account enumeration
- Constant-time-ish login: a verify runs even for unknown emails
- Refresh token rotation (single-use, burned on use; one concurrent retry may
  return 409 instead of signing the user out)
- Email verification required for registration in production
- Per-user and per-IP rate limiting on auth surfaces
- Per-origin CORS allowlist (`ALLOWED_ORIGINS`) — production requires it
- Per-account storage budget (`MAX_USER_BYTES`)
- Authenticated admin API gated by `ADMIN_EMAILS`; disabled when empty
- Security headers; `x-powered-by` disabled; JSON body limit

**Not implemented yet — do these before real users**

1. **Device revocation is bookkeeping only.** Removing a device deletes its
   synced copies and refresh tokens, but an already-issued access token still
   works until expiry (≤15 min). For true immediate revocation, add a per-device
   blocklist or check a session epoch on each request.
2. **In-memory rate limiter.** Resets on restart and is not shared across
   replicas. Swap for a Redis-backed limiter before running more than one
   instance.
3. **RSA-2048 OAEP for sharing.** Fine today; move to X25519/ECIES or wrap a
   symmetric key for smaller, faster handoffs.
4. **No key rotation.** If a vault key leaks, there is no way to re-key every
   item without re-uploading. Plan a `rotate` endpoint.
5. **`sessions` grows unbounded per user** apart from the byte budget. Add a
   per-user item cap or TTL if that becomes a problem.
6. **No append-only audit log beyond the admin console's in-memory buffer.**
   For team handoff deployments, persist "who accessed what, when".

---

## Production notes

Production is fail-closed. The server refuses to boot unless `MONGODB_URI`,
`TOKEN_SECRET` (≥32 chars), `REFRESH_PEPPER` (≥16), `DUMMY_SALT_SECRET` (≥16)
and `ALLOWED_ORIGINS` are set.

- Put it behind TLS. Ciphertext over plaintext HTTP is still metadata leakage.
- `MONGODB_URI` should use a least-privilege DB user, not admin.
- Set `TRUST_PROXY_HOPS` to the real number of proxies; a wrong value lets
  clients spoof `X-Forwarded-For` and evade rate limits.
- Backups contain only ciphertext — but back them up anyway; losing the DB
  means users lose their sessions.
- `ADMIN_EMAILS` is the admin allowlist, and it requires normal verified
  accounts. If it is empty, `/v1/admin` returns `403 admin_not_configured`.
  It is **not** a storage-quota bypass; quotas come from `MAX_USER_BYTES`.

## Contributing: two rules that are load-bearing

**1. Import `Router` from `src/lib/router.js`, never from `express`.**

```js
import { Router } from '../lib/router.js';   // correct
import { Router } from 'express';            // WRONG — see below
```

Express 4 does not forward rejected promises from async handlers to the error
middleware. A throw inside `async (req, res) => {}` becomes an unhandled
rejection, and Node ≥ 15 turns that into a **process exit** — one bad query in
one route takes down the API for every user. This is not theoretical: a single
`{ _id: { $oid: ... } }` in `/v1/auth/refresh` crashed the whole server on its
first call. The wrapper in `lib/router.js` routes both sync throws and async
rejections to `next(err)`.

**2. Never use Extended JSON as a query operator.**

`{ $oid: '...' }` / `{ $date: ... }` are *serialization* formats, not MongoDB
query operators. MongoDB rejects them with `unknown operator: $oid`. Store ids
as strings if you like, but convert with `new ObjectId(id)` before querying, and
guard the conversion (a malformed id should be a 401/400, not a throw):

```js
let userId;
try { userId = new ObjectId(record.userId); }
catch { return res.status(401).json({ error: 'invalid_refresh_token' }); }
```

`test/router.test.js` locks in the first rule. `test/smoke.test.js` locks in the
second.

## Data model

```
users    { _id, email*, authHash, kdfSalt, kdfIterations, tokenVersion,
           publicKey, emailVerifiedAt, createdAt }
sessions { _id, userId, deviceId, host*, envelope, version, updatedAt,
           deleted, deletedAt, deviceName }
refresh  { _id, userId, tokenHash*, expiresAt(TTL), revokedAt, deviceId }
shares   { _id, fromUserId, toUserId, host, wrappedKey, note, createdAt, consumedAt }
devices  { _id, userId, deviceId*, systemId, name, browserInfo, lastSeenAt }
otps     { _id, email, otpHash, purpose, attempts, expiresAt(TTL) }
feedbacks{ _id, type, description, email, status, createdAt }
```

`*` unique. Session rows are unique per `(userId, deviceId, host)` so devices do
not overwrite each other. `systemId` is a random per-profile value, **not** a
hardware fingerprint. Feedback rows deliberately omit IP address and user-agent.

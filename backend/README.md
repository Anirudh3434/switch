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

Smoke test (needs a reachable MongoDB, skips cleanly otherwise):

```bash
npm run smoke
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
| POST | `/auth/otp/send` | `{email, purpose?}` | `{ok, message, expiresIn, cooldown, simulated?, devOtp?}` |
| POST | `/auth/otp/verify` | `{email, otp, purpose?}` | `{ok, verified, email, verificationToken}` |
| POST | `/auth/prelogin` | `{email}` | `{kdfSalt}` |
| POST | `/auth/register` | `{email, authHash, kdfSalt, verificationToken?, otp?}` | `{user, accessToken, refreshToken, expiresIn}` |
| POST | `/auth/login` | `{email, authHash}` | `{user, accessToken, refreshToken, expiresIn}` |
| POST | `/auth/refresh` | `{refreshToken}` | `{accessToken, refreshToken, expiresIn}` (rotates) |
| POST | `/auth/logout` | `{refreshToken}` | `204` |
| GET | `/auth/me` | — | `{user}` |

`prelogin` returns a **deterministic dummy salt** for unknown accounts, so its
response cannot be used to enumerate users.

#### Gmail SMTP Setup
To send real verification emails via Gmail SMTP, configure your Google App Password in `.env`:
1. Enable 2-Step Verification on your Google Account: [https://myaccount.google.com/security](https://myaccount.google.com/security)
2. Generate an App Password under Security → 2-Step Verification → App passwords: [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Set in `.env`:
   ```bash
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=your_email@gmail.com
   SMTP_PASS=xxxx xxxx xxxx xxxx  # 16-character Google App Password
   SMTP_FROM="Switch Vault <no-reply@switch.local>"
   ```
*(Note: If `SMTP_USER` or `SMTP_PASS` is empty, the server automatically runs in development simulation mode, logging the 6-digit OTP code to the server console and API response for testing).*


### Sync

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| POST | `/sync/push` | `{items:[{host, baseVersion, envelope}]}` | Max 100 per batch |
| GET | `/sync/pull` | `?since=<epochMs>&limit=<1-500>` | Returns `{items, cursor, hasMore}` |
| GET | `/sync/list` | — | Index only, no payloads |
| DELETE | `/sync/:host` | — | Tombstone, propagates on pull |

**Envelope shape:** `{ iv: base64url, data: base64url }` — output of the
extension's `seal()`. Max 8 MB each.

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
| DELETE | `/user/devices/:deviceId` | Bookkeeping only — see hardening below |
| PUT | `/user/public-key` | Publish key for shares |
| DELETE | `/user/data` | GDPR/DPDP erasure |

### Health

`GET /healthz` → `{ok:true, ts}`

---

## Security posture

**Implemented**
- Zero-knowledge: no plaintext, no key, no decryption path server-side
- scrypt (N=16384) for the stored credential; `timingSafeEqual` everywhere
- Uniform prelogin response → no account enumeration
- Constant-time-ish login: a verify runs even for unknown emails
- Refresh token rotation (single-use, burned on use)
- Per-IP rate limiting on auth endpoints
- Per-origin CORS allowlist (`ALLOWED_ORIGINS`) — extensions only
- Per-account storage budget (`MAX_USER_BYTES`)
- Security headers; `x-powered-by` disabled; JSON body limit

**Not implemented yet — do these before real users**

1. **`TOKEN_SECRET` defaults to a dev string.** Generate 32 random bytes and
   inject it. Rotating it invalidates all sessions.
2. **Device revocation is bookkeeping only.** A revoked device's access token
   still works until expiry (≤15 min). For true revocation, keep a per-device
   token blocklist or check a session epoch on each request.
3. **In-memory rate limiter.** Resets on restart, no cross-replica coordination.
   Swap for a Redis-backed limiter before running more than one instance.
   Also note the limits are **per IP**, not per account: `register` allows 5 per
   15 min per IP, so an office or campus behind one NAT address will start
   getting 429s after the sixth signup. Raise the link limits and key the login
   limiter on the normalized email as well as the IP.
4. **No MFA / no email verification.** Anyone can register any email address.
   Add a verification token before launch.
5. **RSA-2048 OAEP for sharing.** Fine today; move to X25519/ECIES or wrap a
   symmetric key for smaller, faster handoffs.
6. **No key rotation.** If a vault key leaks, there is no way to re-key every
   item without re-uploading. Plan a `rotate` endpoint.
7. **`sessions` grows unbounded per user.** Add TTL or a per-user item cap.
8. **No audit log.** For the team-handoff use case, "who accessed what, when"
   is a sales requirement. Add an append-only `audit` collection.

---

## Production notes

- Put it behind TLS. Ciphertext over plaintext HTTP is still metadata leakage.
- `MONGODB_URI` should use a least-privilege DB user, not admin.
- Backups contain only ciphertext — but back them up anyway; losing the DB
  means users lose their sessions.
- The `ADMIN_EMAILS` env var is reserved for plan gating and is not yet wired
  into enforcement.

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
users    { _id, email*, authHash, kdfSalt, publicKey, createdAt }
sessions { _id, userId, host*, envelope, version, updatedAt, deviceId, deleted }
                                            unique index: (userId, host)
refresh  { _id, userId, tokenHash*, expiresAt(TTL), revokedAt }
shares   { _id, fromUserId, toUserId, host, wrappedKey, note, createdAt, consumedAt }
devices  { _id, userId, deviceId*, name, lastSeenAt }
```
\* unique

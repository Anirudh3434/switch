// Token signing/verification + server-side password hashing.
//
// Zero-knowledge contract: the client derives two independent keys from the
// master password.
//   - AUTH key  -> base64(HMAC-SHA256(email))  -> sent to the server
//   - ENC  key  -> wraps the random vault key  -> NEVER leaves the client
// Because they use different PBKDF2 labels, stealing `authHash` from the DB
// does not give an attacker the ability to decrypt vaults.
//
// The server additionally hashes `authHash` at rest with scrypt, so a DB dump
// doesn't even expose a reusable login credential directly.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Stateless access token (HMAC-SHA256). Short TTL. */
export function signAccessToken(payload, ttlSeconds, secret) {
  const body = b64u(
    JSON.stringify({ ...payload, iat: now(), exp: now() + ttlSeconds }),
  );
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAccessToken(token, secret) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;

  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof claims.exp !== 'number' || claims.exp < now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Opaque refresh token. Only its hash is stored server-side. */
export function newRefreshToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export const sha256 = (s) =>
  createHmac('sha256', config.refreshPepper)
    .update(s)
    .digest('base64url');

/** scrypt for the credential the client sends us. */
export function hashAuthHash(authHash) {
  const salt = randomBytes(16);
  const derived = scryptSync(authHash, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyAuthHash(authHash, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const saltBuf = Buffer.from(salt, 'base64url');
  const expected = Buffer.from(hash, 'base64url');
  const derived = scryptSync(authHash, saltBuf, expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

const now = () => Math.floor(Date.now() / 1000);

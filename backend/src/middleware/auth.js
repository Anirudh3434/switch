import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { verifyAccessToken } from '../lib/crypto.js';
import { devices, users } from '../db.js';

/** Signs the shared secret used for access tokens. */
export function tokenSecret() {
  if (!config.tokenSecret) {
    throw new Error('FATAL: TOKEN_SECRET must be configured in environment');
  }
  return config.tokenSecret;
}

/**
 * Verifies the bearer token AND that the account still exists at the current
 * token version. The DB check is what makes "delete account" and "reset
 * password" revoke already-issued access tokens immediately instead of
 * leaving a 15-minute window.
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.get('Authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'missing_token' });
    }

    const claims = verifyAccessToken(token, tokenSecret());
    if (!claims || claims.type === 'email_verification') {
      return res.status(401).json({ error: 'invalid_or_expired_token' });
    }

    let userId;
    try {
      userId = new ObjectId(claims.sub);
    } catch {
      return res.status(401).json({ error: 'invalid_or_expired_token' });
    }

    const user = await users().findOne(
      { _id: userId },
      { projection: { email: 1, tokenVersion: 1 } },
    );
    if (!user) return res.status(401).json({ error: 'invalid_or_expired_token' });
    if ((claims.tv || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'invalid_or_expired_token' });
    }

    req.user = { id: String(user._id), email: user.email };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Admin authorization is an allowlist of real accounts, not a shared password.
 * If `ADMIN_EMAILS` is unset the console is disabled entirely (fail closed).
 */
export function requireAdmin(req, res, next) {
  if (!config.adminEmails.length) {
    return res.status(403).json({ error: 'admin_not_configured' });
  }
  const email = String(req.user?.email || '').toLowerCase();
  if (!config.adminEmails.includes(email)) {
    return res.status(403).json({ error: 'admin_forbidden' });
  }
  req.admin = { email };
  next();
}

/** Records the calling device so users can audit and revoke access. */
export async function touchDevice(req, _res, next) {
  const deviceId = req.get('X-Device-Id');
  if (!deviceId || !req.user) return next();

  try {
    await devices().updateOne(
      { userId: req.user.id, deviceId },
      {
        $set: { lastSeenAt: new Date() },
        $setOnInsert: { name: req.get('X-Device-Name') || 'unnamed' },
      },
      { upsert: true },
    );
  } catch (e) {
    // Device bookkeeping must never break the actual request.
    console.warn('[switch] touchDevice failed:', e.message);
  }
  next();
}

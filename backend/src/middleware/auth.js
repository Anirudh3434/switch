import { config } from '../config.js';
import { verifyAccessToken } from '../lib/crypto.js';
import { devices } from '../db.js';

/** Signs the shared secret used for access tokens. */
export function tokenSecret() {
  if (!config.tokenSecret) {
    throw new Error('FATAL: TOKEN_SECRET must be configured in environment');
  }
  return config.tokenSecret;
}

export function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'missing_token' });
  }

  const claims = verifyAccessToken(token, tokenSecret());
  if (!claims) return res.status(401).json({ error: 'invalid_or_expired_token' });

  req.user = { id: claims.sub, email: claims.email };
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

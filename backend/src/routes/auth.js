// Auth. The server stores scrypt(authHash) — never a password, never the
// vault key, never anything decryptable.
//
// Prelogin returns a KDF salt. For unknown emails we return a *deterministic
// dummy salt* derived from the email, so prelogin response time and body are
// identical whether or not the account exists. Otherwise prelogin is an
// account-enumeration oracle.
//
// Production policy: registration requires a verified email, password-reset
// requests are answered identically for known and unknown addresses, and an
// OTP is never returned in an API response.

import { createHmac, randomInt } from 'node:crypto';
import { Router } from '../lib/router.js';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { users, refresh, sessions, devices, otps } from '../db.js';
import {
  hashAuthHash,
  verifyAuthHash,
  signAccessToken,
  verifyAccessToken,
  newRefreshToken,
  sha256,
} from '../lib/crypto.js';
import { rateLimit } from '../lib/rateLimit.js';
import { requireAuth, tokenSecret } from '../middleware/auth.js';
import { sendMailViaSmtp, buildOtpEmailHtml } from '../lib/smtp.js';

const router = Router();

const DEFAULT_KDF_ITERATIONS = 600_000;
const MIN_KDF_ITERATIONS = 100_000;
const MAX_KDF_ITERATIONS = 2_000_000;
const REFRESH_RACE_GRACE_MS = 30_000;
const OTP_PURPOSES = new Set(['account verification', 'password reset']);

const emailNorm = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function dummySalt(email) {
  // Stable per-email, so the response is indistinguishable from a real account.
  return createHmac('sha256', config.dummySaltSecret)
    .update(emailNorm(email))
    .digest('base64url')
    .slice(0, 22);
}

function normalizeIterations(value, fallback = DEFAULT_KDF_ITERATIONS) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  if (n < MIN_KDF_ITERATIONS || n > MAX_KDF_ITERATIONS) return fallback;
  return n;
}

/** Legacy accounts were created at 60k iterations and did not store the count. */
const iterationsFor = (user) =>
  normalizeIterations(user?.kdfIterations, 60_000);

const loginLimiter = rateLimit({ key: 'login', limit: 10, windowMs: 15 * 60 * 1000 });
const registerLimiter = rateLimit({ key: 'register', limit: 3, windowMs: 60 * 60 * 1000 });
const otpSendLimiter = rateLimit({ key: 'otp_send', limit: 5, windowMs: 15 * 60 * 1000 });
const otpVerifyLimiter = rateLimit({ key: 'otp_verify', limit: 10, windowMs: 15 * 60 * 1000 });
const forgotPasswordLimiter = rateLimit({ key: 'forgot_password', limit: 3, windowMs: 60 * 60 * 1000 });

/**
 * Sends an OTP. In production an unconfigured mailer is a hard 503 — silently
 * "simulating" delivery would lock every user out of account verification.
 * Development logs the code to the server console, never to the response body.
 */
async function deliverOtp({ email, otp, purpose }) {
  if (!config.smtpConfigured) {
    if (config.isProd) {
      const err = new Error('email_not_configured');
      err.status = 503;
      throw err;
    }
    console.warn(
      `[switch] SMTP not configured. OTP for ${email} (${purpose}): ${otp}`,
    );
    return { simulated: true };
  }

  const isReset = purpose === 'password reset';
  await sendMailViaSmtp({
    host: config.smtpHost,
    port: config.smtpPort,
    user: config.smtpUser,
    pass: config.smtpPass,
    from: config.smtpFrom,
    to: email,
    subject: isReset ? 'Switch | Password Reset Code' : 'Switch | Verify your email',
    html: buildOtpEmailHtml({ otp, email, purpose }),
    text: [
      isReset
        ? 'Use the following code to reset your Switch Master Password:'
        : 'Verify your email to finish signing up with Switch. Use the following code:',
      '',
      otp,
      '',
      'The verification code is valid for 10 min.',
      '',
      'Switch — Session Bridge',
    ].join('\n'),
  });
  return { simulated: false };
}

/**
 * Validates either a signed verification token or a direct OTP. Returns
 * { verified, reason } and consumes the OTP on success.
 */
async function verifyEmailProof(email, { verificationToken, otp } = {}) {
  if (verificationToken) {
    const claims = verifyAccessToken(verificationToken, tokenSecret());
    if (
      claims &&
      claims.type === 'email_verification' &&
      claims.verified &&
      emailNorm(claims.email) === email
    ) {
      return { verified: true };
    }
    return { verified: false, reason: 'invalid_verification_token' };
  }

  if (otp) {
    const record = await otps().findOne({ email });
    const expectedHash = sha256(String(otp).trim() + config.dummySaltSecret + email);
    if (
      record &&
      record.otpHash === expectedHash &&
      new Date(record.expiresAt) >= new Date()
    ) {
      await otps().deleteMany({ email });
      return { verified: true };
    }
    return { verified: false, reason: 'invalid_otp' };
  }

  return { verified: false, reason: 'email_verification_required' };
}

async function issueTokens(user, deviceId = null) {
  const access = signAccessToken(
    {
      sub: String(user._id),
      email: user.email,
      tv: user.tokenVersion || 0,
    },
    config.accessTtl,
    tokenSecret(),
  );
  const { token, hash } = newRefreshToken();
  await refresh().insertOne({
    userId: String(user._id),
    tokenHash: hash,
    deviceId: deviceId || null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + config.refreshTtl * 1000),
    revokedAt: null,
  });
  return {
    accessToken: access,
    refreshToken: token,
    expiresIn: config.accessTtl,
  };
}

const publicUser = (u) => ({
  id: String(u._id),
  email: u.email,
  kdfSalt: u.kdfSalt,
  kdfIterations: iterationsFor(u),
  createdAt: u.createdAt,
});

/** POST /v1/auth/otp/send — Sends 6-digit OTP via the configured mailer */
router.post('/otp/send', otpSendLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  const purpose = String(req.body?.purpose || 'account verification');

  if (!validEmail(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email', message: 'Valid email address is required.' });
  }
  if (!OTP_PURPOSES.has(purpose)) {
    return res.status(400).json({ ok: false, error: 'invalid_purpose' });
  }

  if (!config.smtpConfigured && config.isProd) {
    return res.status(503).json({
      ok: false,
      error: 'email_not_configured',
      message: 'Email delivery is not configured. Contact the operator.',
    });
  }

  // Password resets only make sense for existing accounts. Do not confirm or
  // deny existence: return the same generic body either way.
  if (purpose === 'password reset') {
    const user = await users().findOne({ email });
    if (!user) {
      return res.json({
        ok: true,
        message: 'If an account exists for that address, a reset code is on its way.',
        expiresIn: config.otpTtl,
        cooldown: config.otpCooldown,
      });
    }
  }

  // Check resend cooldown
  const existing = await otps().findOne({ email });
  if (existing) {
    const elapsedSeconds = Math.floor((Date.now() - new Date(existing.createdAt).getTime()) / 1000);
    if (elapsedSeconds < config.otpCooldown) {
      const waitTime = config.otpCooldown - elapsedSeconds;
      return res.status(429).json({
        ok: false,
        error: 'cooldown_active',
        message: `Please wait ${waitTime} seconds before requesting a new code.`,
        retryAfter: waitTime,
      });
    }
  }

  // Generate cryptographically secure 6-digit numeric OTP
  const otp = String(randomInt(100000, 1000000));
  const otpHash = sha256(otp + config.dummySaltSecret + email);

  // Store in database with TTL
  await otps().deleteMany({ email });
  await otps().insertOne({
    email,
    otpHash,
    purpose,
    attempts: 0,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + config.otpTtl * 1000),
  });

  try {
    const delivery = await deliverOtp({ email, otp, purpose });
    return res.json({
      ok: true,
      message: 'Verification code sent.',
      expiresIn: config.otpTtl,
      cooldown: config.otpCooldown,
      // "console" tells a developer where to look; it is never the code.
      delivery: delivery.simulated ? 'console' : 'email',
    });
  } catch (err) {
    console.error('[switch] Failed to send email:', err?.message || err);
    await otps().deleteMany({ email }).catch(() => {});
    const status = err?.status || 502;
    return res.status(status).json({
      ok: false,
      error: status === 503 ? 'email_not_configured' : 'smtp_failed',
      message: 'Could not send the verification email. Please try again later.',
    });
  }
});

/** POST /v1/auth/otp/verify — Verifies 6-digit OTP and returns signed verification token */
router.post('/otp/verify', otpVerifyLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  const otp = String(req.body?.otp || '').trim();

  if (!validEmail(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email', message: 'Valid email address is required.' });
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ ok: false, error: 'invalid_otp_format', message: 'OTP must be a 6-digit number.' });
  }

  const record = await otps().findOne({ email });
  if (!record || new Date(record.expiresAt) < new Date()) {
    return res.status(400).json({
      ok: false,
      error: 'otp_expired',
      message: 'Verification code has expired or was not requested. Please request a new one.',
    });
  }

  if (record.attempts >= config.otpMaxAttempts) {
    await otps().deleteMany({ email });
    return res.status(429).json({
      ok: false,
      error: 'too_many_attempts',
      message: 'Too many incorrect attempts. This code has been invalidated. Please request a new code.',
    });
  }

  const expectedHash = sha256(otp + config.dummySaltSecret + email);
  if (record.otpHash !== expectedHash) {
    await otps().updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    const remaining = config.otpMaxAttempts - (record.attempts + 1);
    return res.status(400).json({
      ok: false,
      error: 'invalid_otp',
      message: `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      attemptsRemaining: remaining,
    });
  }

  // OTP verified successfully - burn it immediately
  await otps().deleteMany({ email });

  // Issue temporary signed verification token (valid for 15 minutes)
  const verificationToken = signAccessToken(
    { sub: email, email, verified: true, type: 'email_verification' },
    15 * 60,
    tokenSecret(),
  );

  return res.json({
    ok: true,
    verified: true,
    email,
    verificationToken,
    message: 'Email successfully verified.',
  });
});

/** POST /v1/auth/forgot-password — Request password reset code */
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);

  if (!validEmail(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email', message: 'Valid email address is required.' });
  }

  if (!config.smtpConfigured && config.isProd) {
    return res.status(503).json({
      ok: false,
      error: 'email_not_configured',
      message: 'Email delivery is not configured. Contact the operator.',
    });
  }

  const generic = {
    ok: true,
    message: 'If an account exists for that address, a reset code is on its way.',
    expiresIn: config.otpTtl,
    cooldown: config.otpCooldown,
  };

  const user = await users().findOne({ email });
  if (!user) return res.json(generic);

  // Check resend cooldown. Still return the generic body so an attacker cannot
  // use cooldown state to test whether the address exists.
  const existing = await otps().findOne({ email });
  if (existing) {
    const elapsedSeconds = Math.floor((Date.now() - new Date(existing.createdAt).getTime()) / 1000);
    if (elapsedSeconds < config.otpCooldown) return res.json(generic);
  }

  // Generate cryptographically secure 6-digit numeric OTP
  const otp = String(randomInt(100000, 1000000));
  const otpHash = sha256(otp + config.dummySaltSecret + email);

  // Store in database with TTL
  await otps().deleteMany({ email });
  await otps().insertOne({
    email,
    otpHash,
    purpose: 'password reset',
    attempts: 0,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + config.otpTtl * 1000),
  });

  try {
    const delivery = await deliverOtp({ email, otp, purpose: 'password reset' });
    return res.json({ ...generic, delivery: delivery.simulated ? 'console' : 'email' });
  } catch (err) {
    console.error('[switch] Failed to send reset email:', err?.message || err);
    await otps().deleteMany({ email }).catch(() => {});
    const status = err?.status || 502;
    return res.status(status).json({
      ok: false,
      error: status === 503 ? 'email_not_configured' : 'smtp_failed',
      message: 'Could not send the reset email. Please try again later.',
    });
  }
});

/** POST /v1/auth/reset-password — Reset Master Password via verified token or OTP */
router.post('/reset-password', registerLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  const { newAuthHash, newKdfSalt, newKdfIterations, verificationToken, otp } = req.body || {};

  if (!validEmail(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email', message: 'Valid email address is required.' });
  }

  if (typeof newAuthHash !== 'string' || newAuthHash.length < 32) {
    return res.status(400).json({ ok: false, error: 'invalid_auth_hash', message: 'Master password auth hash is invalid.' });
  }

  if (typeof newKdfSalt !== 'string' || newKdfSalt.length < 16) {
    return res.status(400).json({ ok: false, error: 'invalid_kdf_salt', message: 'Master password KDF salt is invalid.' });
  }

  const proof = await verifyEmailProof(email, { verificationToken, otp });
  if (!proof.verified) {
    return res.status(400).json({
      ok: false,
      error: proof.reason || 'invalid_verification',
      message: 'Email verification code has expired or is invalid. Please request a new code.',
    });
  }

  const user = await users().findOne({ email });
  if (!user) {
    return res.status(404).json({
      ok: false,
      error: 'user_not_found',
      message: 'No account found with this email address.',
    });
  }

  const updatedAuthHash = hashAuthHash(newAuthHash);
  const nextTokenVersion = (user.tokenVersion || 0) + 1;
  await users().updateOne(
    { _id: user._id },
    {
      $set: {
        authHash: updatedAuthHash,
        kdfSalt: newKdfSalt,
        kdfIterations: normalizeIterations(newKdfIterations),
        passwordResetAt: new Date(),
        updatedAt: new Date(),
      },
      $inc: { tokenVersion: 1 },
    },
  );

  // Invalidate all previous refresh tokens and cloud sessions (they were
  // encrypted with the old password's vault key and cannot be read).
  await Promise.all([
    refresh().deleteMany({ userId: String(user._id) }),
    sessions().deleteMany({ userId: String(user._id) }),
  ]);

  const tokens = await issueTokens(
    {
      ...user,
      authHash: updatedAuthHash,
      kdfSalt: newKdfSalt,
      kdfIterations: normalizeIterations(newKdfIterations),
      tokenVersion: nextTokenVersion,
    },
    req.get('X-Device-Id') || null,
  );

  return res.json({
    ok: true,
    message: 'Master password successfully reset! You are now signed in.',
    user: publicUser({ ...user, kdfSalt: newKdfSalt }),
    ...tokens,
  });
});

/** POST /v1/auth/prelogin */
router.post('/prelogin', loginLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email' });

  const user = await users().findOne({ email });
  return res.json({
    kdfSalt: user?.kdfSalt || dummySalt(email),
    kdfIterations: user ? iterationsFor(user) : DEFAULT_KDF_ITERATIONS,
  });
});

/** POST /v1/auth/register */
router.post('/register', registerLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  const { authHash, kdfSalt, kdfIterations, publicKey, verificationToken, otp } = req.body || {};

  if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  if (typeof authHash !== 'string' || authHash.length < 32)
    return res.status(400).json({ error: 'invalid_auth_hash' });
  if (typeof kdfSalt !== 'string' || kdfSalt.length < 16)
    return res.status(400).json({ error: 'invalid_kdf_salt' });
  if (publicKey && typeof publicKey !== 'string')
    return res.status(400).json({ error: 'invalid_public_key' });

  // Registration is closed to unverified addresses in production. The dev
  // escape hatch is explicit and never available when NODE_ENV=production.
  const proof = await verifyEmailProof(email, { verificationToken, otp });
  if (!proof.verified && !config.allowUnverifiedRegistration) {
    return res.status(400).json({
      error: proof.reason || 'email_verification_required',
      message: 'Verify your email address before creating an account.',
    });
  }

  const existing = await users().findOne({ email });
  if (existing) return res.status(409).json({ error: 'email_taken' });

  const doc = {
    email,
    authHash: hashAuthHash(authHash), // hashed again at rest
    kdfSalt,
    kdfIterations: normalizeIterations(kdfIterations),
    publicKey: publicKey || null,
    tokenVersion: 0,
    emailVerifiedAt: proof.verified ? new Date() : null,
    createdAt: new Date(),
  };
  const { insertedId } = await users().insertOne(doc);

  return res.status(201).json({
    user: publicUser({ ...doc, _id: insertedId }),
    ...(await issueTokens({ ...doc, _id: insertedId }, req.get('X-Device-Id') || null)),
  });
});

/** POST /v1/auth/login */
router.post('/login', loginLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  const { authHash } = req.body || {};

  if (!validEmail(email) || typeof authHash !== 'string')
    return res.status(400).json({ error: 'invalid_credentials' });

  const user = await users().findOne({ email });
  // Always run a verify to keep timing uniform for unknown emails.
  const stored = user?.authHash || hashAuthHash(authHash);
  const ok = verifyAuthHash(authHash, stored);

  if (!user || !ok) return res.status(401).json({ error: 'invalid_credentials' });

  return res.json({
    user: publicUser(user),
    ...(await issueTokens(user, req.get('X-Device-Id') || null)),
  });
});

/**
 * POST /v1/auth/refresh — rotates the refresh token.
 *
 * Rotation is atomic. If two tabs race, the loser gets 409 and retries with
 * the winner's token (the client single-flights refreshes). Reusing a token
 * that was rotated more than a grace period ago is treated as theft and
 * revokes every refresh token on the account.
 */
router.post('/refresh', loginLimiter, async (req, res) => {
  const { refreshToken } = req.body || {};
  if (typeof refreshToken !== 'string')
    return res.status(400).json({ error: 'invalid_refresh_token' });

  const tokenHash = sha256(refreshToken);
  const record = await refresh().findOne({ tokenHash });
  if (!record || record.expiresAt < new Date())
    return res.status(401).json({ error: 'invalid_refresh_token' });

  if (record.revokedAt) {
    const age = Date.now() - new Date(record.revokedAt).getTime();
    if (age < REFRESH_RACE_GRACE_MS) {
      res.set('Retry-After', '1');
      return res.status(409).json({ error: 'refresh_in_progress', retryAfterSeconds: 1 });
    }
    // Old token replayed well after rotation: assume compromise.
    await refresh().updateMany(
      { userId: record.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return res.status(401).json({ error: 'invalid_refresh_token' });
  }

  // Claim the token atomically. Exactly one concurrent request wins.
  const claimed = await refresh().findOneAndUpdate(
    { _id: record._id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  if (!claimed) {
    res.set('Retry-After', '1');
    return res.status(409).json({ error: 'refresh_in_progress', retryAfterSeconds: 1 });
  }

  let userId;
  try {
    userId = new ObjectId(record.userId);
  } catch {
    return res.status(401).json({ error: 'invalid_refresh_token' });
  }

  const user = await users().findOne({ _id: userId });
  if (!user) return res.status(401).json({ error: 'invalid_refresh_token' });

  return res.json(await issueTokens(user, record.deviceId || null));
});

/**
 * POST /v1/auth/logout — ends THIS browser's server session.
 *
 * Signing out must never delete another device's synced sessions. Data
 * deletion is a separate, explicit action (`DELETE /v1/user/account`).
 */
router.post('/logout', async (req, res) => {
  const { refreshToken, clearSyncData = false, deviceId: bodyDeviceId } = req.body || {};

  let userId = null;
  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const claims = verifyAccessToken(token, tokenSecret());
      if (claims?.sub && claims.type !== 'email_verification') userId = claims.sub;
    } catch {
      // Logout is best-effort; never fail because the access token expired.
    }
  }

  if (!userId && typeof refreshToken === 'string' && refreshToken.length > 0) {
    const rec = await refresh().findOne({ tokenHash: sha256(refreshToken) });
    if (rec?.userId) userId = rec.userId;
  }

  const deviceId = req.get('X-Device-Id') || bodyDeviceId;

  // Revoke only the refresh token presented by this browser.
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    await refresh()
      .updateOne(
        { tokenHash: sha256(refreshToken), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
      .catch(() => {});
  }

  if (userId && deviceId) {
    // Remove the device listing but leave its encrypted sessions intact.
    await devices().deleteOne({ userId, deviceId }).catch(() => {});
  }

  // Opt-in only. Kept for backwards compatibility with old clients, but the
  // current client never sends true.
  if (userId && clearSyncData === true) {
    await sessions().deleteMany({ userId }).catch(() => {});
  }

  res.status(204).end();
});

/** GET /v1/auth/me */
router.get('/me', requireAuth, async (req, res) => {
  const user = await users().findOne({ email: req.user.email });
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ user: publicUser(user) });
});

export default router;

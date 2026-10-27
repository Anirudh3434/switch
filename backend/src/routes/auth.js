// Auth. The server stores scrypt(authHash) — never a password, never the
// vault key, never anything decryptable.
//
// Prelogin returns a KDF salt. For unknown emails we return a *deterministic
// dummy salt* derived from the email, so prelogin response time and body are
// identical whether or not the account exists. Otherwise prelogin is an
// account-enumeration oracle.

import { createHmac, scryptSync, randomInt } from 'node:crypto';
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

const emailNorm = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function dummySalt(email) {
  // Stable per-email, so the response is indistinguishable from a real account.
  return createHmac('sha256', config.dummySaltSecret)
    .update(emailNorm(email))
    .digest('base64url')
    .slice(0, 22);
}

const loginLimiter = rateLimit({ key: 'login', limit: 10, windowMs: 15 * 60 * 1000 });
const registerLimiter = rateLimit({ key: 'register', limit: 3, windowMs: 60 * 60 * 1000 });
const otpSendLimiter = rateLimit({ key: 'otp_send', limit: 5, windowMs: 15 * 60 * 1000 });
const otpVerifyLimiter = rateLimit({ key: 'otp_verify', limit: 10, windowMs: 15 * 60 * 1000 });
const forgotPasswordLimiter = rateLimit({ key: 'forgot_password', limit: 3, windowMs: 60 * 60 * 1000 });

/** POST /v1/auth/otp/send — Sends 6-digit OTP via Gmail SMTP */
router.post('/otp/send', otpSendLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  const purpose = req.body?.purpose || 'account verification';

  if (!validEmail(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email', message: 'Valid email address is required.' });
  }

  // If purpose is password reset, verify that the account exists
  if (purpose === 'password reset') {
    const user = await users().findOne({ email });
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'No registered Switch account found with this email address.',
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

  // Send via Gmail SMTP
  try {
    const isReset = purpose === 'password reset';
    const mailResult = await sendMailViaSmtp({
      host: config.smtpHost,
      port: config.smtpPort,
      user: config.smtpUser,
      pass: config.smtpPass,
      from: config.smtpFrom,
      to: email,
      subject: isReset ? 'Switch | Password Reset Code' : 'Switch | Otp to verify',
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
        '© 2026 Switch Technologies, Inc. All rights reserved.',
      ].join('\n'),
    });

    const isSimulated = mailResult?.simulated;
    return res.json({
      ok: true,
      message: isSimulated
        ? 'Verification code logged to server console (SMTP not configured)'
        : 'Verification code sent to your email address via Gmail SMTP.',
      expiresIn: config.otpTtl,
      cooldown: config.otpCooldown,
      simulated: isSimulated,
      ...(isSimulated ? { devOtp: otp } : {}),
    });
  } catch (err) {
    console.error('[switch] Failed to send email via SMTP:', err);
    return res.status(500).json({
      ok: false,
      error: 'smtp_failed',
      message: `Failed to send email via Gmail SMTP: ${err.message}`,
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

  const user = await users().findOne({ email });
  if (!user) {
    return res.status(404).json({
      ok: false,
      error: 'user_not_found',
      message: 'No registered Switch account found with this email address.',
    });
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
    purpose: 'password reset',
    attempts: 0,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + config.otpTtl * 1000),
  });

  // Send via Gmail SMTP
  try {
    const mailResult = await sendMailViaSmtp({
      host: config.smtpHost,
      port: config.smtpPort,
      user: config.smtpUser,
      pass: config.smtpPass,
      from: config.smtpFrom,
      to: email,
      subject: 'Switch | Password Reset Code',
      html: buildOtpEmailHtml({ otp, email, purpose: 'password reset' }),
      text: [
        'Use the following code to reset your Switch Master Password:',
        '',
        otp,
        '',
        'The verification code is valid for 10 min.',
        '',
        '© 2026 Switch Technologies, Inc. All rights reserved.',
      ].join('\n'),
    });

    const isSimulated = mailResult?.simulated;
    return res.json({
      ok: true,
      message: isSimulated
        ? 'Password reset code logged to server console (SMTP not configured)'
        : 'Password reset code sent to your email address.',
      expiresIn: config.otpTtl,
      cooldown: config.otpCooldown,
      simulated: isSimulated,
      ...(isSimulated ? { devOtp: otp } : {}),
    });
  } catch (err) {
    console.error('[switch] Failed to send email via SMTP:', err);
    return res.status(500).json({
      ok: false,
      error: 'smtp_failed',
      message: `Failed to send email via Gmail SMTP: ${err.message}`,
    });
  }
});

/** POST /v1/auth/reset-password — Reset Master Password via verified token or OTP */
router.post('/reset-password', registerLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  const { newAuthHash, newKdfSalt, verificationToken, otp } = req.body || {};

  if (!validEmail(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email', message: 'Valid email address is required.' });
  }

  if (typeof newAuthHash !== 'string' || newAuthHash.length < 32) {
    return res.status(400).json({ ok: false, error: 'invalid_auth_hash', message: 'Master password auth hash is invalid.' });
  }

  if (typeof newKdfSalt !== 'string' || newKdfSalt.length < 16) {
    return res.status(400).json({ ok: false, error: 'invalid_kdf_salt', message: 'Master password KDF salt is invalid.' });
  }

  // 1. Validate email verification proof (verificationToken OR direct OTP)
  let isVerified = false;
  if (verificationToken) {
    const claims = verifyAccessToken(verificationToken, tokenSecret());
    if (claims && emailNorm(claims.email) === email && claims.verified) {
      isVerified = true;
    }
  } else if (otp) {
    const record = await otps().findOne({ email });
    const expectedHash = sha256(String(otp).trim() + config.dummySaltSecret + email);
    if (record && record.otpHash === expectedHash && new Date(record.expiresAt) >= new Date()) {
      isVerified = true;
      await otps().deleteMany({ email });
    }
  }

  if (!isVerified) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_verification',
      message: 'Email verification code has expired or is invalid. Please request a new code.',
    });
  }

  // 2. Locate user
  const user = await users().findOne({ email });
  if (!user) {
    return res.status(404).json({
      ok: false,
      error: 'user_not_found',
      message: 'No account found with this email address.',
    });
  }

  // 3. Update master password hashes
  const updatedAuthHash = hashAuthHash(newAuthHash);
  await users().updateOne(
    { _id: user._id },
    {
      $set: {
        authHash: updatedAuthHash,
        kdfSalt: newKdfSalt,
        passwordResetAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );

  // 4. Invalidate all previous refresh tokens
  await refresh().deleteMany({ userId: String(user._id) });

  // 5. Purge old encrypted cloud sessions (cannot be decrypted without old password)
  await sessions().deleteMany({ userId: String(user._id) });

  // 6. Issue fresh tokens
  const tokens = await issueTokens({ ...user, authHash: updatedAuthHash, kdfSalt: newKdfSalt });

  return res.json({
    ok: true,
    message: 'Master password successfully reset! You are now signed in.',
    user: publicUser({ ...user, kdfSalt: newKdfSalt }),
    ...tokens,
  });
});


async function issueTokens(user) {
  const access = signAccessToken(
    { sub: String(user._id), email: user.email },
    config.accessTtl,
    tokenSecret(),
  );
  const { token, hash } = newRefreshToken();
  await refresh().insertOne({
    userId: String(user._id),
    tokenHash: hash,
    expiresAt: new Date(Date.now() + config.refreshTtl * 1000),
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
  createdAt: u.createdAt,
});

/** POST /v1/auth/prelogin */
router.post('/prelogin', loginLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email' });

  const user = await users().findOne({ email });
  return res.json({ kdfSalt: user?.kdfSalt || dummySalt(email) });
});

/** POST /v1/auth/register */
router.post('/register', registerLimiter, async (req, res) => {
  const email = emailNorm(req.body?.email);
  const { authHash, kdfSalt, publicKey, verificationToken, otp } = req.body || {};

  if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  if (typeof authHash !== 'string' || authHash.length < 32)
    return res.status(400).json({ error: 'invalid_auth_hash' });
  if (typeof kdfSalt !== 'string' || kdfSalt.length < 16)
    return res.status(400).json({ error: 'invalid_kdf_salt' });
  if (publicKey && typeof publicKey !== 'string')
    return res.status(400).json({ error: 'invalid_public_key' });

  // Optional OTP / Verification Token validation
  if (verificationToken) {
    const claims = verifyAccessToken(verificationToken, tokenSecret());
    if (!claims || emailNorm(claims.email) !== email || !claims.verified) {
      return res.status(400).json({ error: 'invalid_verification_token', message: 'Email verification token is invalid or expired.' });
    }
  } else if (otp) {
    const record = await otps().findOne({ email });
    const expectedHash = sha256(String(otp).trim() + config.dummySaltSecret + email);
    if (!record || record.otpHash !== expectedHash || new Date(record.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'invalid_otp', message: 'Verification code is invalid or expired.' });
    }
    await otps().deleteMany({ email });
  }

  const existing = await users().findOne({ email });
  if (existing) return res.status(409).json({ error: 'email_taken' });

  const doc = {
    email,
    authHash: hashAuthHash(authHash), // hashed again at rest
    kdfSalt,
    publicKey: publicKey || null,
    createdAt: new Date(),
  };
  const { insertedId } = await users().insertOne(doc);

  return res.status(201).json({
    user: publicUser({ ...doc, _id: insertedId }),
    ...(await issueTokens({ ...doc, _id: insertedId })),
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

  return res.json({ user: publicUser(user), ...(await issueTokens(user)) });
});

/** POST /v1/auth/refresh — rotates the refresh token. */
router.post('/refresh', loginLimiter, async (req, res) => {
  const { refreshToken } = req.body || {};
  if (typeof refreshToken !== 'string')
    return res.status(400).json({ error: 'invalid_refresh_token' });

  const tokenHash = sha256(refreshToken);
  const record = await refresh().findOne({ tokenHash, revokedAt: null });
  if (!record || record.expiresAt < new Date())
    return res.status(401).json({ error: 'invalid_refresh_token' });

  // Rotation: burn the old token the moment it's used.
  await refresh().updateOne(
    { _id: record._id },
    { $set: { revokedAt: new Date() } },
  );

  // `record.userId` was stored as a string (see issueTokens), so it must be
  // converted back. `{ $oid: ... }` is Extended JSON *serialization* syntax,
  // not a query operator — MongoDB rejects it with "unknown operator: $oid".
  let userId;
  try {
    userId = new ObjectId(record.userId);
  } catch {
    // Malformed userId in the refresh record: treat as an invalid token.
    return res.status(401).json({ error: 'invalid_refresh_token' });
  }

  const user = await users().findOne({ _id: userId });
  if (!user) return res.status(401).json({ error: 'invalid_refresh_token' });

  return res.json(await issueTokens(user));
});

/** POST /v1/auth/logout */
router.post('/logout', async (req, res) => {
  const { refreshToken, clearSyncData = true, deviceId: bodyDeviceId } = req.body || {};

  // Extract userId from Authorization header if present
  let userId = null;
  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const claims = verifyAccessToken(token, tokenSecret());
      if (claims?.sub) userId = claims.sub;
    } catch (e) {
      // Ignore token verification errors on logout
    }
  }

  // If not found from access token, locate userId from refreshToken hash
  if (!userId && typeof refreshToken === 'string' && refreshToken.length > 0) {
    const tokenHash = sha256(refreshToken);
    const rec = await refresh().findOne({ tokenHash });
    if (rec?.userId) {
      userId = rec.userId;
    }
  }

  const deviceId = req.get('X-Device-Id') || bodyDeviceId;

  // Revoke/delete refresh token records
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    try {
      await refresh().updateMany(
        { tokenHash: sha256(refreshToken) },
        { $set: { revokedAt: new Date() } },
      );
    } catch (e) {
      // Ignore errors
    }
  }
  
  if (userId) {
    try {
      await refresh().deleteMany({ userId });
    } catch (e) {
      // Ignore errors
    }

    // 1. Delete device info from database
    try {
      if (deviceId) {
        await devices().deleteOne({ userId, deviceId });
      } else {
        await devices().deleteMany({ userId });
      }
    } catch (e) {
      // Ignore errors
    }

    // 2. Delete all cookies and tokens stored in database for this user if requested
    if (clearSyncData) {
      try {
        await sessions().deleteMany({ userId });
      } catch (e) {
        // Ignore errors
      }
    }
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

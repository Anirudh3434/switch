// Environment configuration. Fails fast and loudly on boot — a backend that
// silently starts with defaults is a backend you can't trust.
//
// Production is fail-closed: every secret that participates in authentication
// or pseudonymisation is mandatory and length-checked. There is no fallback
// secret, because a fallback secret is a public secret.
import 'node:process';

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const required = isProd
  ? [
      'MONGODB_URI',
      'TOKEN_SECRET',
      'REFRESH_PEPPER',
      'DUMMY_SALT_SECRET',
      'ALLOWED_ORIGINS',
    ]
  : ['MONGODB_URI'];

function load() {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required env: ${missing.join(', ')}. See .env.example.`,
    );
  }

  const minLength = (key, n) => {
    const value = process.env[key];
    if (isProd && (!value || value.length < n)) {
      throw new Error(`${key} must be at least ${n} characters in production`);
    }
  };

  if (isProd) {
    minLength('TOKEN_SECRET', 32);
    minLength('REFRESH_PEPPER', 16);
    minLength('DUMMY_SALT_SECRET', 16);

    // A production API without an origin allowlist cannot serve the extension.
    if (!process.env.ALLOWED_ORIGINS) {
      throw new Error('ALLOWED_ORIGINS must list the extension origins in production');
    }
  }

  const int = (k, dflt) => {
    const n = Number(process.env[k]);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };

  const smtpUser =
    process.env.SMTP_USER || process.env.GMAIL_USER || '';
  const smtpPass =
    process.env.SMTP_PASS ||
    process.env.GMAIL_APP_PASSWORD ||
    process.env.GMAIL_APP_PASS ||
    '';

  return Object.freeze({
    isProd,
    isTest,
    port: int('PORT', 8080),
    trustProxy: int('TRUST_PROXY_HOPS', 1),
    mongoUri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB || 'switch',
    tokenSecret:
      process.env.TOKEN_SECRET ||
      (isProd ? null : 'dev-only-insecure-secret-change-me'),
    refreshPepper:
      process.env.REFRESH_PEPPER ||
      (isProd ? null : 'switch-refresh-pepper-dev'),
    dummySaltSecret:
      process.env.DUMMY_SALT_SECRET ||
      (isProd ? null : 'switch-dummy-salt-dev'),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    accessTtl: int('ACCESS_TOKEN_TTL_SECONDS', 900),
    refreshTtl: int('REFRESH_TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30),
    adminEmails: (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    maxUserBytes: int('MAX_USER_BYTES', 50 * 1024 * 1024),
    // Gmail SMTP Configuration
    smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: int('SMTP_PORT', 465),
    smtpUser,
    smtpPass,
    smtpFrom:
      process.env.SMTP_FROM ||
      smtpUser ||
      'no-reply@switch.invalid',
    smtpConfigured: Boolean(smtpUser && smtpPass),
    otpTtl: int('OTP_TTL_SECONDS', 600),
    otpCooldown: int('OTP_COOLDOWN_SECONDS', 60),
    otpMaxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    // Development escape hatch only. Production always requires a verified
    // email before an account can be created.
    allowUnverifiedRegistration:
      !isProd && process.env.ALLOW_UNVERIFIED_REGISTRATION === 'true',
  });
}

export const config = load();

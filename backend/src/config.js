// Environment configuration. Fails fast and loudly on boot — a backend that
// silently starts with defaults is a backend you can't trust.
import 'node:process';

const isProd = process.env.NODE_ENV === 'production';
const required = isProd ? ['MONGODB_URI', 'TOKEN_SECRET'] : ['MONGODB_URI'];

function load() {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required env: ${missing.join(', ')}. See .env.example.`,
    );
  }

  // Extra production validation
  if (isProd) {
    if (!process.env.TOKEN_SECRET || process.env.TOKEN_SECRET.length < 32) {
      throw new Error('TOKEN_SECRET must be at least 32 characters in production');
    }
    if (!process.env.ALLOWED_ORIGINS) {
      console.warn('[switch] WARNING: ALLOWED_ORIGINS not set in production - only non-browser clients allowed');
    }
  }

  const int = (k, dflt) => {
    const n = Number(process.env[k]);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };

  return Object.freeze({
    port: int('PORT', 8080),
    mongoUri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB || 'switch',
    tokenSecret: process.env.TOKEN_SECRET || (isProd ? null : 'dev-only-insecure-secret-change-me'),
    refreshPepper: process.env.REFRESH_PEPPER || (isProd ? null : 'switch-refresh-pepper-dev'),
    dummySaltSecret: process.env.DUMMY_SALT_SECRET || (isProd ? null : 'switch-dummy-salt-dev'),
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
    smtpUser: process.env.SMTP_USER || process.env.GMAIL_USER || '',
    smtpPass: process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_APP_PASS || '',
    smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || process.env.GMAIL_USER || 'no-reply@switch.local',
    otpTtl: int('OTP_TTL_SECONDS', 600),
    otpCooldown: int('OTP_COOLDOWN_SECONDS', 60),
    otpMaxAttempts: int('OTP_MAX_ATTEMPTS', 5),
  });
}

export const config = load();

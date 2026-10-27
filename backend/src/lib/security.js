// Security headers + CORS for extension origins.
//
// Extensions are a hostile-ish origin: any web page can talk to an extension
// if the extension opens a host permission. We therefore allowlist by origin
// prefix (chrome-extension://ID vs moz-extension://UUID differ per browser
// and per install) and never reflect arbitrary Origin headers.

import { config } from '../config.js';

export function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-XSS-Protection': '0',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  next();
}

function originAllowed(origin) {
  if (!origin) return true;
  if (origin === 'null') return true;
  const isProd = process.env.NODE_ENV === 'production';
  const cleanOrigin = origin.replace(/\/+$/, '');

  // Non-production development allowance: allow all browser extension schemes and localhost
  if (!isProd) {
    if (
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('moz-extension://') ||
      origin.startsWith('edge-extension://') ||
      origin.startsWith('safari-web-extension://') ||
      origin.startsWith('extension://') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1') ||
      origin.startsWith('https://localhost')
    ) {
      return true;
    }
  }

  // In production, only allow explicitly configured origins
  if (config.allowedOrigins.length === 0) {
    // If no origins configured in production, deny all browser extension origins
    if (origin.startsWith('chrome-extension://') || 
        origin.startsWith('moz-extension://') || 
        origin.startsWith('edge-extension://') ||
        origin.startsWith('safari-web-extension://')) {
      return false;
    }
  }

  return config.allowedOrigins.some((allowed) => {
    const cleanAllowed = allowed.replace(/\/+$/, '');
    // In production, require exact extension ID matching — never open-ended scheme prefixes
    if (isProd && (cleanAllowed === 'chrome-extension:' || cleanAllowed === 'moz-extension:' || cleanAllowed === 'edge-extension:' || cleanAllowed === 'safari-web-extension:' || cleanAllowed === 'extension:')) {
      return false;
    }
    if (cleanOrigin === cleanAllowed) return true;
    // Non-production development allowance for local testing
    if (!isProd && allowed.endsWith('//') && origin.startsWith(allowed)) return true;
    return false;
  });
}

export function cors(req, res, next) {
  const origin = req.get('Origin');

  if (originAllowed(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,X-Device-Id,X-Device-Name,X-System-Id',
    );
    res.set('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

/** Last-line-of-defence guard. CORS is not authentication. */
export function rejectDisallowedOrigin(req, res, next) {
  const origin = req.get('Origin');
  // Non-browser clients (curl, the smoke test) send no Origin header.
  if (!origin) return next();
  if (originAllowed(origin)) return next();
  res.status(403).json({ error: 'origin_not_allowed' });
}

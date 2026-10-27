// Auth client for Switch backend sync & token management.
// Implements zero-knowledge authentication:
// - authHash derived via WebCrypto PBKDF2 (SHA-256, 60,000 iters)
// - password never leaves the browser in plaintext

const DEFAULT_SERVER = 'http://localhost:8080';

export function uint8ArrayToBase64Url(uint8) {
  let binary = '';
  const len = uint8.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function randomBase64Url(byteCount = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return uint8ArrayToBase64Url(bytes);
}

/**
 * Derive authHash: PBKDF2(password, salt + "auth", 60000, 32, SHA-256)
 * Matches server's verifyAuthHash protocol exactly.
 */
export async function deriveAuthHash(password, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt + 'auth'),
      iterations: 60000,
      hash: 'SHA-256',
    },
    baseKey,
    256,
  );
  return uint8ArrayToBase64Url(new Uint8Array(bits));
}

export function normalizeBaseUrl(url) {
  let clean = (url || DEFAULT_SERVER).trim().replace(/\/+$/, '');
  clean = clean.replace(/\/v1$/i, '');
  return clean;
}

export async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  return normalizeBaseUrl(serverUrl || DEFAULT_SERVER);
}

export async function setServerUrl(url) {
  const clean = normalizeBaseUrl(url || DEFAULT_SERVER);
  await chrome.storage.local.set({ serverUrl: clean });
  return clean;
}

export async function prelogin(email, serverUrl) {
  const base = serverUrl || (await getServerUrl());
  try {
    const res = await fetch(`${base}/v1/auth/prelogin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email || '').trim().toLowerCase() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        const retryAfter = Number(data.retryAfterSeconds) || Number(res.headers.get('Retry-After')) || 60;
        const err = new Error(data.message || 'rate_limited');
        err.code = 'rate_limited';
        err.retryAfterSeconds = retryAfter;
        throw err;
      }
      if (res.status === 0 || res.status >= 500) {
        throw new Error('Could not reach sync server. Check the server URL in settings.');
      }
      throw new Error(data.error || `Prelogin failed with status ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

/**
 * Derive deterministic 256-bit vault encryption key from password & account salt.
 * Ensures all browsers and devices of the user account share the exact same
 * zero-knowledge encryption key for cross-device session portability.
 */
export async function deriveVaultKey(password, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt + 'vault_sync_key_seed'),
      iterations: 60000,
      hash: 'SHA-256',
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

export async function sendEmailOtp(email, purpose = 'account verification', serverUrl) {
  const base = normalizeBaseUrl(serverUrl || (await getServerUrl()));
  const normEmail = String(email || '').trim().toLowerCase();

  try {
    const res = await fetch(`${base}/v1/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normEmail, purpose }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number(data.retryAfterSeconds) || Number(res.headers.get('Retry-After')) || 60;
        const err = new Error(data.message || 'rate_limited');
        err.code = 'rate_limited';
        err.retryAfterSeconds = retryAfter;
        throw err;
      }
      if (res.status === 404) {
        throw new Error('Could not reach sync server. Check the server URL in settings.');
      }
      if (res.status === 0 || res.status >= 500) {
        throw new Error('Could not reach sync server. Check the server URL in settings.');
      }
      throw new Error(data.message || data.error || `Failed to send OTP (${res.status})`);
    }
    return data;
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

export async function verifyEmailOtp(email, otp, purpose = 'account verification', serverUrl) {
  const base = normalizeBaseUrl(serverUrl || (await getServerUrl()));
  const normEmail = String(email || '').trim().toLowerCase();

  try {
    const res = await fetch(`${base}/v1/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normEmail, otp: String(otp).trim(), purpose }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404 || res.status === 0 || res.status >= 500) {
        throw new Error('Could not reach sync server. Check the server URL in settings.');
      }
      throw new Error(data.message || data.error || `Verification failed (${res.status})`);
    }
    return data;
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

export async function register(email, password, serverUrl, { verificationToken, otp } = {}) {
  const base = serverUrl || (await getServerUrl());
  const normEmail = String(email || '').trim().toLowerCase();
  const kdfSalt = randomBase64Url(16);
  const authHash = await deriveAuthHash(password, kdfSalt);
  const vaultKey = await deriveVaultKey(password, kdfSalt);

  const payload = { email: normEmail, authHash, kdfSalt };
  if (verificationToken) payload.verificationToken = verificationToken;
  if (otp) payload.otp = otp;

  try {
    const res = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number(data.retryAfterSeconds) || Number(res.headers.get('Retry-After')) || 60;
        const err = new Error(data.message || 'rate_limited');
        err.code = 'rate_limited';
        err.retryAfterSeconds = retryAfter;
        throw err;
      }
      if (res.status === 0 || res.status >= 500) {
        throw new Error('Could not reach sync server. Check the server URL in settings.');
      }
      throw new Error(data.message || data.error || `Registration failed (${res.status})`);
    }

    const { user, accessToken, refreshToken, expiresIn } = data;
    const tokenExpiresAt = Date.now() + (expiresIn || 900) * 1000;

    await chrome.storage.local.set({
      serverUrl: base,
      user,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      vaultKeyRaw: Array.from(vaultKey),
      vaultKeyDerived: true,
    });

    return { user, accessToken, refreshToken, expiresIn };
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

export async function login(email, password, serverUrl) {
  const base = serverUrl || (await getServerUrl());
  const normEmail = String(email || '').trim().toLowerCase();

  try {
    const { kdfSalt } = await prelogin(normEmail, base);
    if (!kdfSalt) throw new Error('Failed to retrieve authentication parameters');

    const authHash = await deriveAuthHash(password, kdfSalt);
    const vaultKey = await deriveVaultKey(password, kdfSalt);

    const res = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normEmail, authHash }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw new Error('Invalid email or password');
      if (res.status === 429) {
        const retryAfter = Number(data.retryAfterSeconds) || Number(res.headers.get('Retry-After')) || 60;
        const err = new Error(data.message || 'rate_limited');
        err.code = 'rate_limited';
        err.retryAfterSeconds = retryAfter;
        throw err;
      }
      if (res.status === 0 || res.status >= 500) {
        throw new Error('Could not reach sync server. Check the server URL in settings.');
      }
      throw new Error(data.error || `Login failed (${res.status})`);
    }

    const { user, accessToken, refreshToken, expiresIn } = data;
    const tokenExpiresAt = Date.now() + (expiresIn || 900) * 1000;

    await chrome.storage.local.set({
      serverUrl: base,
      user,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      vaultKeyRaw: Array.from(vaultKey),
      vaultKeyDerived: true,
    });

    return { user, accessToken, refreshToken, expiresIn };
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

export async function forgotPassword(email, serverUrl) {
  const base = serverUrl || (await getServerUrl());
  const normEmail = String(email || '').trim().toLowerCase();

  try {
    const res = await fetch(`${base}/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normEmail }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number(data.retryAfterSeconds) || Number(res.headers.get('Retry-After')) || 60;
        const err = new Error(data.message || 'rate_limited');
        err.code = 'rate_limited';
        err.retryAfterSeconds = retryAfter;
        throw err;
      }
      if (res.status === 0 || res.status >= 500) {
        throw new Error('Could not reach sync server. Check the server URL in settings.');
      }
      throw new Error(data.message || data.error || `Password reset request failed (${res.status})`);
    }
    return data;
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

export async function resetPassword(email, newPassword, serverUrl, { verificationToken, otp } = {}) {
  const base = serverUrl || (await getServerUrl());
  const normEmail = String(email || '').trim().toLowerCase();
  const newKdfSalt = randomBase64Url(16);
  const newAuthHash = await deriveAuthHash(newPassword, newKdfSalt);
  const newVaultKey = await deriveVaultKey(newPassword, newKdfSalt);

  const payload = {
    email: normEmail,
    newAuthHash,
    newKdfSalt,
  };
  if (verificationToken) payload.verificationToken = verificationToken;
  if (otp) payload.otp = otp;

  try {
    const res = await fetch(`${base}/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number(data.retryAfterSeconds) || Number(res.headers.get('Retry-After')) || 60;
        const err = new Error(data.message || 'rate_limited');
        err.code = 'rate_limited';
        err.retryAfterSeconds = retryAfter;
        throw err;
      }
      if (res.status === 0 || res.status >= 500) {
        throw new Error('Could not reach sync server. Check the server URL in settings.');
      }
      throw new Error(data.message || data.error || `Password reset failed (${res.status})`);
    }

    const { user, accessToken, refreshToken, expiresIn } = data;
    const tokenExpiresAt = Date.now() + (expiresIn || 900) * 1000;

    await chrome.storage.local.set({
      serverUrl: base,
      user,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      vaultKeyRaw: Array.from(newVaultKey),
      vaultKeyDerived: true,
    });

    return { user, accessToken, refreshToken, expiresIn };
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

export async function refreshSession() {
  const { serverUrl, refreshToken } = await chrome.storage.local.get([
    'serverUrl',
    'refreshToken',
  ]);
  const base = serverUrl || DEFAULT_SERVER;
  if (!refreshToken) throw new Error('No refresh token available');

  const res = await fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    await logout();
    throw new Error(data.error || 'Session expired, please log in again');
  }

  const { accessToken, refreshToken: newRefresh, expiresIn } = data;
  const tokenExpiresAt = Date.now() + (expiresIn || 900) * 1000;

  await chrome.storage.local.set({
    accessToken,
    refreshToken: newRefresh,
    tokenExpiresAt,
  });

  return { accessToken, refreshToken: newRefresh, expiresIn };
}

/**
 * Proactively returns a valid access token, auto-refreshing via refresh token if expired.
 */
export async function getValidAccessToken() {
  const data = await chrome.storage.local.get([
    'accessToken',
    'refreshToken',
    'tokenExpiresAt',
  ]);

  if (!data.accessToken && !data.refreshToken) return null;

  const now = Date.now();
  if (
    data.refreshToken &&
    (!data.accessToken || (data.tokenExpiresAt && now > data.tokenExpiresAt - 60000))
  ) {
    try {
      const refreshed = await refreshSession();
      return refreshed?.accessToken || null;
    } catch (e) {
      console.warn('[switch] auto refresh token failed:', e);
      return data.accessToken || null;
    }
  }

  return data.accessToken;
}

export async function logout() {
  try {
    const { serverUrl, refreshToken, accessToken, deviceId } = await chrome.storage.local.get([
      'serverUrl',
      'refreshToken',
      'accessToken',
      'deviceId',
    ]);
    const base = serverUrl || DEFAULT_SERVER;
    if (refreshToken || accessToken) {
      const headers = { 'Content-Type': 'application/json' };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
      if (deviceId) {
        headers['X-Device-Id'] = deviceId;
      }

      // Explicitly deregister this device from the account on the backend
      if (accessToken && deviceId) {
        await fetch(`${base}/v1/user/devices/${encodeURIComponent(deviceId)}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Device-Id': deviceId,
          },
        }).catch(() => {});
      }

      await fetch(`${base}/v1/auth/logout`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          refreshToken: refreshToken || '',
          clearSyncData: true,
          deviceId: deviceId || '',
        }),
      }).catch((e) => console.warn('[switch] backend logout error:', e));
    }
  } finally {
    // 1. Core auth and encryption keys
    const keysToRemove = [
      'user',
      'accessToken',
      'refreshToken',
      'tokenExpiresAt',
      'vaultKeyRaw',
      'vaultKeyDerived',
      'deviceId',
      'systemId',
    ];

    // 2. Clear all cached domain tokens, snapshots, and swap backups
    const all = await chrome.storage.local.get(null);
    for (const key of Object.keys(all || {})) {
      if (
        key.startsWith('snap_') ||
        key.startsWith('snap:') ||
        key.startsWith('swap_backup_') ||
        key.startsWith('switch:') ||
        key.startsWith('attempt:') ||
        key.startsWith('rejected:') ||
        key.startsWith('never:') ||
        key === 'active_swaps' ||
        key === 'activeSwaps' ||
        key === 'grantedHosts' ||
        key === 'switch:granted' ||
        key === 'detectEnabled'
      ) {
        keysToRemove.push(key);
      }
    }

    await chrome.storage.local.remove([...new Set(keysToRemove)]);
  }
}

export async function getAuthStatus() {
  const data = await chrome.storage.local.get([
    'user',
    'accessToken',
    'refreshToken',
    'tokenExpiresAt',
    'serverUrl',
  ]);

  const loggedIn = !!data.accessToken && !!data.user;
  const isExpired = data.tokenExpiresAt ? Date.now() > data.tokenExpiresAt : false;

  return {
    loggedIn,
    user: data.user || null,
    serverUrl: data.serverUrl || DEFAULT_SERVER,
    accessToken: data.accessToken || null,
    refreshToken: data.refreshToken || null,
    tokenExpiresAt: data.tokenExpiresAt || null,
    isExpired,
  };
}

// ---------------- Token inspection helpers ----------------

export function parseJwt(token) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;

    const base64Url = parts[1];
    let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

export function parseJwtHeader(token) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;

    const base64Url = parts[0];
    let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const jsonHeader = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(jsonHeader);
  } catch {
    return null;
  }
}

export function isJwt(token) {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (!trimmed.startsWith('eyJ')) return false;
  return parseJwt(trimmed) !== null;
}

export function isAuthToken(name, value) {
  if (isJwt(value)) return true;
  const n = String(name || '').toLowerCase();
  const keywords = [
    'token',
    'jwt',
    'auth',
    'bearer',
    'session',
    'sess',
    'sid',
    'id_token',
    'access_token',
    'refresh_token',
    'authtoken',
    'accesstoken',
    'phpsessid',
    'jsessionid',
    'connect.sid',
    'csrf',
    'xsrf',
    'user_session',
    'remember',
    'login',
    'account',
    'oauth',
    'apikey',
    'api_key',
    'ticket',
  ];
  return keywords.some((k) => n.includes(k));
}

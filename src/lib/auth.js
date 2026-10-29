// Auth client for Switch backend sync & token management.
// Implements zero-knowledge authentication:
// - authHash derived via WebCrypto PBKDF2 (SHA-256)
// - password never leaves the browser in plaintext
// - vault key lives in session storage, never persistent local storage

// Development default. The login and account screens expose this value so a
// production deployment can point at a real host without a code change.
export const DEFAULT_SERVER = 'http://localhost:8080';
export const AUTH_KDF_ITERATIONS = 600000;
const LEGACY_KDF_ITERATIONS = 60000;

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
 * Derive authHash: PBKDF2(password, salt + "auth", iterations, 32, SHA-256)
 * Matches the server's verifyAuthHash protocol exactly.
 */
export async function deriveAuthHash(
  password,
  salt,
  iterations = AUTH_KDF_ITERATIONS,
) {
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
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    256,
  );
  return uint8ArrayToBase64Url(new Uint8Array(bits));
}

/**
 * The workload parameter is stored per account so old accounts keep working
 * when the default is raised. `prelogin` returns it; legacy accounts omit it.
 */
export const iterationsFromPrelogin = (prelogin) =>
  Number(prelogin?.kdfIterations) || LEGACY_KDF_ITERATIONS;

export function normalizeBaseUrl(url) {
  let clean = String(url || '').trim().replace(/\/+$/, '');
  clean = clean.replace(/\/v1$/i, '');
  if (!clean) return '';
  if (!/^https?:\/\//i.test(clean)) {
    throw new Error('Sync server URL must start with http:// or https://');
  }
  return clean;
}

export async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  return normalizeBaseUrl(serverUrl || DEFAULT_SERVER);
}

export async function setServerUrl(url) {
  const clean = normalizeBaseUrl(url);
  if (!clean) throw new Error('Sync server URL is required');
  await chrome.storage.local.set({ serverUrl: clean });
  return clean;
}

async function requireServerUrl(serverUrl) {
  const base = normalizeBaseUrl(serverUrl || (await getServerUrl()));
  if (!base) {
    throw new Error('Configure your sync server URL in settings before signing in.');
  }
  return base;
}

export async function prelogin(email, serverUrl) {
  const base = await requireServerUrl(serverUrl);
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
 * Derive the deterministic 256-bit vault key from the password and account
 * salt. Every device of the same account derives the same key; the server never
 * receives it.
 */
export async function deriveVaultKey(
  password,
  salt,
  iterations = AUTH_KDF_ITERATIONS,
) {
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
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

export async function sendEmailOtp(email, purpose = 'account verification', serverUrl) {
  const base = await requireServerUrl(serverUrl);
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
  const base = await requireServerUrl(serverUrl);
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

async function persistSession({ base, user, accessToken, refreshToken, expiresIn }, vaultKey) {
  const tokenExpiresAt = Date.now() + (expiresIn || 900) * 1000;
  await chrome.storage.local.set({
    serverUrl: base,
    user,
    accessToken,
    refreshToken,
    tokenExpiresAt,
  });
  // The vault key is memory-only for this browser session.
  await chrome.storage.session.set({ vaultKeyRaw: Array.from(vaultKey) });
  await chrome.storage.local.set({ vaultKeyDerived: true });
  // Remove the old plaintext-at-rest copy if this profile predates the fix.
  await chrome.storage.local.remove('vaultKeyRaw');
}

export async function register(email, password, serverUrl, { verificationToken, otp } = {}) {
  const base = await requireServerUrl(serverUrl);
  const normEmail = String(email || '').trim().toLowerCase();
  const kdfSalt = randomBase64Url(16);
  const kdfIterations = AUTH_KDF_ITERATIONS;
  const authHash = await deriveAuthHash(password, kdfSalt, kdfIterations);
  const vaultKey = await deriveVaultKey(password, kdfSalt, kdfIterations);

  const payload = { email: normEmail, authHash, kdfSalt, kdfIterations };
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
    await persistSession({ base, user, accessToken, refreshToken, expiresIn }, vaultKey);

    return { user, accessToken, refreshToken, expiresIn };
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

export async function login(email, password, serverUrl) {
  const base = await requireServerUrl(serverUrl);
  const normEmail = String(email || '').trim().toLowerCase();

  try {
    const pre = await prelogin(normEmail, base);
    if (!pre.kdfSalt) throw new Error('Failed to retrieve authentication parameters');
    const kdfIterations = iterationsFromPrelogin(pre);

    const authHash = await deriveAuthHash(password, pre.kdfSalt, kdfIterations);
    const vaultKey = await deriveVaultKey(password, pre.kdfSalt, kdfIterations);

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
    await persistSession({ base, user, accessToken, refreshToken, expiresIn }, vaultKey);

    return { user, accessToken, refreshToken, expiresIn };
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

export async function forgotPassword(email, serverUrl) {
  const base = await requireServerUrl(serverUrl);
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
  const base = await requireServerUrl(serverUrl);
  const normEmail = String(email || '').trim().toLowerCase();
  const newKdfSalt = randomBase64Url(16);
  const newKdfIterations = AUTH_KDF_ITERATIONS;
  const newAuthHash = await deriveAuthHash(newPassword, newKdfSalt, newKdfIterations);
  const newVaultKey = await deriveVaultKey(newPassword, newKdfSalt, newKdfIterations);

  const payload = {
    email: normEmail,
    newAuthHash,
    newKdfSalt,
    newKdfIterations,
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
    await persistSession({ base, user, accessToken, refreshToken, expiresIn }, newVaultKey);

    return { user, accessToken, refreshToken, expiresIn };
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Could not reach sync server. Check the server URL in settings.');
    }
    throw e;
  }
}

let refreshInFlight = null;

export function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh() {
  const { serverUrl, refreshToken } = await chrome.storage.local.get([
    'serverUrl',
    'refreshToken',
  ]);
  const base = normalizeBaseUrl(serverUrl || DEFAULT_SERVER);
  if (!refreshToken) throw new Error('No refresh token available');

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    const data = await res.json().catch(() => ({}));

    // Another tab won the rotation race. Retry with whatever token is now in
    // storage instead of logging the user out.
    if (res.status === 409 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 500));
      const latest = await chrome.storage.local.get('refreshToken');
      if (latest.refreshToken && latest.refreshToken !== refreshToken) {
        return doRefresh();
      }
      continue;
    }

    if (!res.ok) {
      if (res.status === 401) await clearAuthState();
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

  throw new Error('Session expired, please log in again');
}

/**
 * Proactively returns a valid access token, auto-refreshing via refresh token
 * if expired. Concurrent callers share one refresh.
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

/**
 * Clear this browser's credentials. Server-side synced sessions are untouched.
 */
export async function clearAuthState() {
  await chrome.storage.session.remove('vaultKeyRaw');
  await chrome.storage.local.remove([
    'user',
    'accessToken',
    'refreshToken',
    'tokenExpiresAt',
    'vaultKeyRaw',
    'vaultKeyDerived',
  ]);
}

/**
 * Sign out of THIS browser.
 *
 * `clearSyncData` is false: signing out must not erase the account's encrypted
 * sessions or other devices' refresh tokens. Account deletion is a separate,
 * explicitly confirmed action (`deleteAccount`).
 */
export async function logout() {
  try {
    const { serverUrl, refreshToken, accessToken, deviceId } = await chrome.storage.local.get([
      'serverUrl',
      'refreshToken',
      'accessToken',
      'deviceId',
    ]);
    const base = normalizeBaseUrl(serverUrl || DEFAULT_SERVER);
    if (base && (refreshToken || accessToken)) {
      const headers = { 'Content-Type': 'application/json' };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      if (deviceId) headers['X-Device-Id'] = deviceId;

      await fetch(`${base}/v1/auth/logout`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          refreshToken: refreshToken || '',
          clearSyncData: false,
          deviceId: deviceId || '',
        }),
      }).catch((e) => console.warn('[switch] backend logout error:', e));
    }
  } finally {
    await clearAuthState();

    // Local snapshots and swap backups belong to the signed-in account. Keep
    // the server copy, drop the local plaintext caches.
    const all = await chrome.storage.local.get(null);
    const keysToRemove = [];
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

/** Irreversible account + data erasure (GDPR/DPDP). */
export async function deleteAccount() {
  const { serverUrl } = await chrome.storage.local.get(['serverUrl']);
  const base = normalizeBaseUrl(serverUrl || DEFAULT_SERVER);
  let accessToken = await getValidAccessToken();
  if (!base || !accessToken) throw new Error('Not authenticated');

  const request = () =>
    fetch(`${base}/v1/user/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

  let res = await request();
  if (res.status === 401) {
    // An expired access token must not be mistaken for a completed deletion.
    // Refresh and retry before clearing anything locally.
    const refreshed = await refreshSession().catch(() => null);
    accessToken = refreshed?.accessToken || null;
    if (!accessToken) throw new Error('Session expired. Sign in again, then delete the account.');
    res = await request();
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Account deletion failed (${res.status})`);
  }

  // Only clear local state after the server confirms erasure.
  await clearAuthState();
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
}

/** Download a machine-readable copy of the account's server-side data. */
export async function exportUserData() {
  const { serverUrl } = await chrome.storage.local.get(['serverUrl']);
  const base = normalizeBaseUrl(serverUrl || DEFAULT_SERVER);
  let accessToken = await getValidAccessToken();
  if (!base || !accessToken) throw new Error('Not authenticated');

  const request = () =>
    fetch(`${base}/v1/user/export`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

  let res = await request();
  if (res.status === 401) {
    const refreshed = await refreshSession().catch(() => null);
    accessToken = refreshed?.accessToken || null;
    if (!accessToken) throw new Error('Session expired. Sign in again to export.');
    res = await request();
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Export failed (${res.status})`);
  }
  return res.json();
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

// Handles device fingerprinting, unique device ID persistence,
// device registration, cross-device session query, and domain token swapping.

import { seal, open, getOrCreateVaultKey } from './crypto.js';

const CH = chrome;

/**
 * Check if a host/domain is localhost, loopback IP, or local dev domain.
 */
export function isLocalhost(domain) {
  if (!domain) return false;
  const d = String(domain).replace(/^\./, '').toLowerCase().trim();
  return (
    d === 'localhost' ||
    d === '127.0.0.1' ||
    d === '::1' ||
    d.endsWith('.localhost') ||
    d.startsWith('localhost:')
  );
}

/**
 * Check if a host/domain is a search engine (Google, Bing, DuckDuckGo, etc.)
 * that should be excluded from session swapping and token injection prompts.
 */
export function isSearchEngine(domain) {
  if (!domain) return false;
  const d = String(domain).replace(/^\./, '').toLowerCase().trim();
  // Google domains (e.g. google.com, google.co.in, www.google.com, etc.)
  if (/^([a-z0-9-]+\.)?google\.[a-z.]+$/i.test(d)) return true;
  // Other search engines
  if (/^([a-z0-9-]+\.)?(bing|duckduckgo|baidu|yandex|ecosia|ask|search\.yahoo)\.[a-z.]+$/i.test(d)) return true;
  return false;
}

/**
 * Generate a cryptographically secure random device ID with prefix 'dev_'.
 */
export function generateDeviceId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'dev_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get or create unique device ID persisted in chrome.storage.local.
 */
export async function getOrCreateDeviceId() {
  const { deviceId } = await CH.storage.local.get('deviceId');
  if (deviceId && typeof deviceId === 'string' && deviceId.startsWith('dev_')) {
    return deviceId;
  }
  const newId = generateDeviceId();
  await CH.storage.local.set({ deviceId: newId });
  return newId;
}

/**
 * Detect client browser, version, operating system, and human-friendly name.
 */
export function detectDeviceEnvironment() {
  const ua = navigator.userAgent || '';

  // Detect OS
  let os = 'Unknown OS';
  if (ua.includes('Windows NT 10.0')) os = 'Windows 10/11';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS X') || ua.includes('Macintosh')) os = 'macOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Linux')) os = 'Linux';

  // Detect Browser
  let browser = 'Browser';
  let version = '';

  if (ua.includes('Edg/')) {
    browser = 'Edge';
    version = ua.match(/Edg\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('OPR/') || ua.includes('Opera/')) {
    browser = 'Opera';
    version = ua.match(/(?:OPR|Opera)\/([\d.]+)/)?.[1] || '';
  } else if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
    browser = 'Brave';
  } else if (ua.includes('Chrome/')) {
    browser = 'Chrome';
    version = ua.match(/Chrome\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('Firefox/')) {
    browser = 'Firefox';
    version = ua.match(/Firefox\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
    browser = 'Safari';
    version = ua.match(/Version\/([\d.]+)/)?.[1] || '';
  }

  const majorVersion = version.split('.')[0] || '';
  const browserLabel = majorVersion ? `${browser} ${majorVersion}` : browser;
  const name = `${browserLabel} on ${os}`;

  return {
    name,
    browserInfo: {
      browser,
      browserVersion: version,
      os,
      platform: navigator.platform || '',
      language: navigator.language || 'en',
      userAgent: ua,
    },
  };
}

/**
 * Generate or retrieve a hardware-based System ID identifying this computer across browsers.
 * Combines OS, CPU core count, screen specs, timezone, and GPU renderer.
 */
export async function getOrCreateSystemId() {
  const { systemId } = await CH.storage.local.get('systemId');
  if (systemId && typeof systemId === 'string' && systemId.startsWith('sys_')) {
    return systemId;
  }

  let gpu = '';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : '';
    }
  } catch {}

  const ua = navigator.userAgent || '';
  const os = ua.includes('Windows')
    ? 'Windows'
    : ua.includes('Mac')
      ? 'macOS'
      : ua.includes('Linux')
        ? 'Linux'
        : 'OS';
  const cores = navigator.hardwareConcurrency || 4;
  const screenSpec =
    typeof screen !== 'undefined'
      ? `${screen.width}x${screen.height}x${screen.colorDepth}`
      : 'screen';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const rawSeed = `${os}|${cores}|${screenSpec}|${tz}|${gpu}`;

  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(rawSeed));
  const hashArr = Array.from(new Uint8Array(hashBuf));
  const hex = hashArr
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const newSysId = `sys_${hex}`;

  await CH.storage.local.set({ systemId: newSysId });
  return newSysId;
}

/**
 * Register current device with backend server.
 */
export async function registerDevice(serverUrl, accessToken) {
  const deviceId = await getOrCreateDeviceId();
  const systemId = await getOrCreateSystemId();
  const { name, browserInfo } = detectDeviceEnvironment();

  const res = await fetch(`${serverUrl}/v1/user/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Device-Id': deviceId,
      'X-Device-Name': name,
      'X-System-Id': systemId,
    },
    body: JSON.stringify({
      deviceId,
      systemId,
      name,
      browserInfo,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Device registration failed (${res.status})`);
  }

  await CH.storage.local.set({
    deviceName: name,
    systemId,
    deviceRegisteredAt: Date.now(),
  });

  return { deviceId, systemId, name, browserInfo };
}

/**
 * Fetch all devices registered to the user account.
 */
export async function fetchUserDevices(serverUrl, accessToken) {
  const deviceId = await getOrCreateDeviceId();
  const systemId = await getOrCreateSystemId();
  const { name } = detectDeviceEnvironment();

  const res = await fetch(`${serverUrl}/v1/user/devices`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Device-Id': deviceId,
      'X-Device-Name': name,
      'X-System-Id': systemId,
    },
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to fetch devices (${res.status})`);
  }

  const data = await res.json();
  return data.items || [];
}

/**
 * Revoke and remove a device and its synced sessions from the user account.
 */
export async function revokeDevice(serverUrl, accessToken, targetDeviceId) {
  const currentDeviceId = await getOrCreateDeviceId();
  const systemId = await getOrCreateSystemId();

  const res = await fetch(`${serverUrl}/v1/user/devices/${encodeURIComponent(targetDeviceId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Device-Id': currentDeviceId,
      'X-System-Id': systemId,
    },
  });

  if (!res.ok && res.status !== 404 && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to revoke device (${res.status})`);
  }

  return { ok: true };
}

/**
 * Encode payload to UTF-8 safe Base64 string for envelope.data.
 */
function toBase64Envelope(data) {
  const jsonStr = JSON.stringify(data);
  return btoa(unescape(encodeURIComponent(jsonStr)));
}

/**
 * Decode payload from UTF-8 safe Base64 envelope.data.
 */
function fromBase64Envelope(base64Str) {
  try {
    const jsonStr = decodeURIComponent(escape(atob(base64Str)));
    return JSON.parse(jsonStr);
  } catch (e) {
    console.warn('[switch] envelope decode failed:', e);
    return null;
  }
}

/**
 * Fetch remote sessions from sync server and decode cookie payloads.
 */
export async function fetchRemoteSessions(serverUrl, accessToken) {
  const deviceId = await getOrCreateDeviceId();
  const { name } = detectDeviceEnvironment();
  const vaultKey = await getOrCreateVaultKey();

  const res = await fetch(`${serverUrl}/v1/sync/pull?limit=500`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Device-Id': deviceId,
      'X-Device-Name': name,
    },
  });

  if (!res.ok) {
    return [];
  }

  const data = await res.json();
  const items = data.items || [];
  const results = [];

  for (const item of items) {
    if (isLocalhost(item.host)) continue;
    let cookies = [];
    if (item.envelope?.data) {
      try {
        cookies = await open(vaultKey, item.envelope);
      } catch (err) {
        // Backward-compatible fallback for unencrypted base64 payloads
        cookies = fromBase64Envelope(item.envelope.data) || [];
        if (!cookies.length) {
          console.warn(`[switch] Unable to unseal cookies for host ${item.host}:`, err?.message || err);
        }
      }
    }
    results.push({
      host: item.host,
      version: item.version,
      updatedAt: item.updatedAt,
      deviceId: item.deviceId,
      deviceName: item.deviceName,
      cookies,
    });
  }

  return results;
}

/**
 * Push current domain cookies to backend sync database securely sealed with AES-256-GCM.
 */
export async function pushDomainSession(serverUrl, accessToken, host, cookies, baseVersion = 0) {
  if (isLocalhost(host)) return { ok: false, reason: 'localhost_ignored' };

  const deviceId = await getOrCreateDeviceId();
  const { name } = detectDeviceEnvironment();
  const vaultKey = await getOrCreateVaultKey();

  // Seal tokens in an end-to-end AES-256-GCM encrypted envelope
  const envelope = await seal(vaultKey, cookies);

  const res = await fetch(`${serverUrl}/v1/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Device-Id': deviceId,
      'X-Device-Name': name,
    },
    body: JSON.stringify({
      items: [
        {
          host,
          baseVersion: baseVersion ?? -1,
          force: true,
          envelope,
          deviceId,
          deviceName: name,
        },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Push failed (${res.status})`);
  }

  return data;
}

/**
 * Push multiple domain sessions in batches securely sealed with AES-256-GCM.
 */
export async function pushBatchDomainSessions(serverUrl, accessToken, domainList) {
  if (!Array.isArray(domainList) || domainList.length === 0) {
    return { ok: true, syncedCount: 0 };
  }

  const deviceId = await getOrCreateDeviceId();
  const { name } = detectDeviceEnvironment();
  const vaultKey = await getOrCreateVaultKey();

  const validItems = domainList.filter((item) => item.host && !isLocalhost(item.host));
  const envelopes = [];

  for (const item of validItems) {
    try {
      const envelope = await seal(vaultKey, item.cookies || []);
      envelopes.push({
        host: item.host,
        baseVersion: item.baseVersion ?? -1,
        force: true,
        envelope,
        deviceId,
        deviceName: name,
      });
    } catch (e) {
      console.warn('[switch] seal failed for host:', item.host, e);
    }
  }

  const BATCH_SIZE = 50;
  let totalAccepted = 0;

  for (let i = 0; i < envelopes.length; i += BATCH_SIZE) {
    const chunk = envelopes.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${serverUrl}/v1/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Device-Id': deviceId,
        'X-Device-Name': name,
      },
      body: JSON.stringify({ items: chunk }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Batch push failed (${res.status})`);
    }

    const data = await res.json();
    totalAccepted += (data.results || []).filter((r) => r.status === 'ok').length;
  }

  return { ok: true, syncedCount: totalAccepted, totalItems: envelopes.length };
}

/**
 * Delete a domain session from the cloud sync server.
 */
export async function deleteDomainSessionFromServer(serverUrl, accessToken, host, deviceId = null) {
  if (!serverUrl || !accessToken || !host) return false;
  const cleanHost = String(host).replace(/^\./, '').toLowerCase().trim();
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
    };
    if (deviceId) {
      headers['X-Device-Id'] = deviceId;
    }
    const res = await fetch(`${serverUrl}/v1/sync/${encodeURIComponent(cleanHost)}`, {
      method: 'DELETE',
      headers,
    });
    return res.ok;
  } catch (e) {
    console.warn('[switch] deleteDomainSessionFromServer failed:', e);
    return false;
  }
}


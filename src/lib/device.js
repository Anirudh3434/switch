// Device identity, cross-device session query, and sync transport.
//
// Privacy notes:
// - The "system id" is a RANDOM per-profile identifier, not a hardware
//   fingerprint. A GPU/screen/timezone hash is stable across sites and is a
//   tracking vector; we do not need it to group a user's own devices.
// - Device metadata is minimised to a human label plus coarse browser/OS.
//   User-agent, platform and language are not uploaded.

import { seal, open, getOrCreateVaultKey } from './crypto.js';
import { isIpHost, normalizeHost } from './domain.js';

const CH = chrome;

/** Check if a host/domain is localhost, loopback IP, or local dev domain. */
export function isLocalhost(domain) {
  if (!domain) return false;
  const d = String(domain).replace(/^\./, '').toLowerCase().trim();
  return (
    d === 'localhost' ||
    d === '127.0.0.1' ||
    d === '::1' ||
    d === '[::1]' ||
    d.endsWith('.localhost') ||
    d.startsWith('localhost:')
  );
}

/** Search engines are excluded from swap/injection prompts. */
export function isSearchEngine(domain) {
  if (!domain) return false;
  const d = String(domain).replace(/^\./, '').toLowerCase().trim();
  if (/^([a-z0-9-]+\.)?google\.[a-z.]+$/i.test(d)) return true;
  if (/^([a-z0-9-]+\.)?(bing|duckduckgo|baidu|yandex|ecosia|ask|search\.yahoo)\.[a-z.]+$/i.test(d)) return true;
  return false;
}

/** Generate a cryptographically secure random id with the given prefix. */
export function generateDeviceId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'dev_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

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
 * Coarse, non-identifying device description.
 *
 * Deliberately omits `userAgent`, `platform` and `language`: they add
 * fingerprinting surface without helping the user recognise their own browser.
 */
export function detectDeviceEnvironment() {
  const ua = navigator.userAgent || '';

  let os = 'Unknown OS';
  if (ua.includes('Windows NT 10.0')) os = 'Windows 10/11';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS X') || ua.includes('Macintosh')) os = 'macOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Linux')) os = 'Linux';

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

  return {
    name: `${browserLabel} on ${os}`,
    browserInfo: {
      browser,
      browserMajorVersion: majorVersion,
      os,
    },
  };
}

/**
 * Random per-profile "system" id.
 *
 * Kept for display grouping only. It cannot and should not identify the same
 * physical machine across different browsers — that requires cross-profile
 * tracking, which this product does not do.
 */
export async function getOrCreateSystemId() {
  const { systemId } = await CH.storage.local.get('systemId');
  if (systemId && typeof systemId === 'string' && systemId.startsWith('sys_')) {
    return systemId;
  }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const newSysId =
    'sys_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await CH.storage.local.set({ systemId: newSysId });
  return newSysId;
}

/** Register or refresh this device with the backend. */
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
    body: JSON.stringify({ deviceId, systemId, name, browserInfo }),
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

export async function revokeDevice(serverUrl, accessToken, targetDeviceId) {
  const currentDeviceId = await getOrCreateDeviceId();
  const systemId = await getOrCreateSystemId();

  const res = await fetch(
    `${serverUrl}/v1/user/devices/${encodeURIComponent(targetDeviceId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Device-Id': currentDeviceId,
        'X-System-Id': systemId,
      },
    },
  );

  if (!res.ok && res.status !== 404 && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to revoke device (${res.status})`);
  }

  return { ok: true };
}

/**
 * Merge an old device record into this install.
 *
 * Used after a reinstall: the extension's local storage is gone, so it has a
 * fresh random device id, while the account still lists the previous install.
 * The server keeps this device ID, moves the old record's synced sessions
 * across, and deletes the duplicate.
 */
export async function adoptDevice(serverUrl, accessToken, targetDeviceId) {
  const deviceId = await getOrCreateDeviceId();
  const systemId = await getOrCreateSystemId();
  const { name, browserInfo } = detectDeviceEnvironment();

  const res = await fetch(`${serverUrl}/v1/user/devices/adopt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Device-Id': deviceId,
      'X-Device-Name': name,
      'X-System-Id': systemId,
    },
    body: JSON.stringify({ deviceId: targetDeviceId, systemId, name, browserInfo }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Device merge failed (${res.status})`);
    err.status = res.status;
    throw err;
  }

  return { ...data, deviceId, systemId, name, browserInfo };
}

/**
 * Pull every remote session, following the server cursor.
 *
 * The old implementation requested a single page of 500 and silently dropped
 * the rest. The server now reports `hasMore` + `cursor`, so keep asking until
 * it says stop.
 */
export async function fetchRemoteSessions(serverUrl, accessToken, { since = 0 } = {}) {
  const deviceId = await getOrCreateDeviceId();
  const { name } = detectDeviceEnvironment();
  const vaultKey = await getOrCreateVaultKey();

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'X-Device-Id': deviceId,
    'X-Device-Name': name,
  };

  const byHost = new Map();
  let cursor = Number(since) || 0;

  for (let page = 0; page < 100; page++) {
    const res = await fetch(
      `${serverUrl}/v1/sync/pull?since=${encodeURIComponent(cursor)}&limit=500`,
      { headers },
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Pull failed (${res.status})`);
    }

    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];

    for (const item of items) {
      const host = normalizeHost(item.host);
      if (!host || isLocalhost(host) || isIpHost(host)) continue;

      let cookies = [];
      if (!item.deleted && item.envelope?.data) {
        try {
          // AAD binds the ciphertext to this host; a server that swaps two
          // hosts' payloads produces a decrypt failure, not a silent login.
          cookies = await open(vaultKey, item.envelope, `host:${host}`);
        } catch (err) {
          console.warn(
            `[switch] Unable to unseal cookies for ${host}:`,
            err?.message || err,
          );
          // No plaintext fallback: an unreadable envelope is a failed read,
          // never a reason to trust unauthenticated base64.
          continue;
        }
      }

      const next = {
        host,
        version: item.version,
        updatedAt: item.updatedAt,
        deleted: !!item.deleted,
        deletedAt: item.deletedAt || null,
        deviceId: item.deviceId || null,
        deviceName: item.deviceName || null,
        cookies,
      };

      const prev = byHost.get(host);
      if (!prev || (next.version || 0) >= (prev.version || 0)) {
        byHost.set(host, next);
      }
    }

    if (!data.hasMore) break;
    const nextCursor = Number(data.cursor);
    if (!Number.isFinite(nextCursor) || nextCursor <= cursor) break;
    cursor = nextCursor;
  }

  return [...byHost.values()].filter((s) => !s.deleted);
}

/**
 * Push one host's cookies.
 *
 * `baseVersion` is the version this client last saw. The server rejects a
 * stale write with a conflict instead of letting an offline device clobber a
 * fresher session. There is no `force`.
 */
export async function pushDomainSession(
  serverUrl,
  accessToken,
  host,
  cookies,
  baseVersion = 0,
) {
  const cleanHost = normalizeHost(host);
  if (!cleanHost || isLocalhost(cleanHost)) {
    return { ok: false, reason: 'localhost_ignored' };
  }

  const deviceId = await getOrCreateDeviceId();
  const { name } = detectDeviceEnvironment();
  const vaultKey = await getOrCreateVaultKey();

  const envelope = await seal(vaultKey, cookies, `host:${cleanHost}`);

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
          host: cleanHost,
          baseVersion: Number.isFinite(Number(baseVersion))
            ? Number(baseVersion)
            : 0,
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
 * Push several hosts in batches. Conflicts are reported, not overwritten.
 * Each item needs `{ host, cookies, baseVersion }`.
 */
export async function pushBatchDomainSessions(serverUrl, accessToken, domainList) {
  if (!Array.isArray(domainList) || domainList.length === 0) {
    return { ok: true, syncedCount: 0, conflicts: [] };
  }

  const deviceId = await getOrCreateDeviceId();
  const { name } = detectDeviceEnvironment();
  const vaultKey = await getOrCreateVaultKey();

  const items = [];
  for (const item of domainList) {
    const host = normalizeHost(item.host);
    if (!host || isLocalhost(host)) continue;
    try {
      items.push({
        host,
        baseVersion: Number.isFinite(Number(item.baseVersion))
          ? Number(item.baseVersion)
          : 0,
        envelope: await seal(vaultKey, item.cookies || [], `host:${host}`),
        deviceId,
        deviceName: name,
      });
    } catch (e) {
      console.warn('[switch] seal failed for host:', host, e);
    }
  }

  const BATCH_SIZE = 50;
  let accepted = 0;
  const conflicts = [];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
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
    for (const result of data.results || []) {
      if (result.status === 'ok') accepted++;
      else conflicts.push(result);
    }
  }

  return {
    ok: true,
    syncedCount: accepted,
    conflicts,
    totalItems: items.length,
  };
}

/**
 * Tombstone a host.
 *
 * Only the exact host is touched. Deriving a registrable domain here would
 * turn `shop.example.co.uk` into `co.uk` and delete an unrelated subtree.
 * Pass `allDevices` to remove every device's copy, not just this browser's.
 */
export async function deleteDomainSessionFromServer(
  serverUrl,
  accessToken,
  host,
  deviceId = null,
  { allDevices = false } = {},
) {
  if (!serverUrl || !accessToken || !host) return false;

  const cleanHost = normalizeHost(host);
  if (!cleanHost) return false;

  try {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (deviceId) headers['X-Device-Id'] = deviceId;

    const query = allDevices ? '?allDevices=true' : '';
    const res = await fetch(
      `${serverUrl}/v1/sync/${encodeURIComponent(cleanHost)}${query}`,
      { method: 'DELETE', headers },
    );
    return res.ok;
  } catch (e) {
    console.warn('[switch] deleteDomainSessionFromServer failed:', e);
    return false;
  }
}

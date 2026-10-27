// Persistent Store Collection for Cross-Device Session Swaps.
//
// Tracks:
// 1. Origin: Current device, browser, OS, and original cookie/token values.
// 2. Target: Interchanged device, browser, OS, and applied cookie/token values.
//
// Enforces:
// - Exact restoration of original cookies on Rollback.
// - Clean deletion of swap record upon Rollback.
// - Strict Swap Guard: Blocks chaining swaps with a 3rd device/browser while swapped.

import { isAuthToken } from './auth.js';
import { detectDeviceEnvironment, getOrCreateDeviceId } from './device.js';

const CH = typeof chrome !== 'undefined' ? chrome : browser;
export const ACTIVE_SWAPS_KEY = 'active_swaps';

/**
 * Clean domain string removing leading dot and trimming.
 */
export function cleanDomain(domain) {
  if (!domain) return '';
  return String(domain).replace(/^\./, '').toLowerCase().trim();
}

/**
 * Get root domain (e.g. "dashboard.stripe.com" -> "stripe.com")
 */
export function getRootDomain(domain) {
  const clean = cleanDomain(domain);
  if (!clean) return '';
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;
  return parts.slice(-2).join('.');
}

/**
 * Mask sensitive token values for UI summary.
 */
export function maskTokenValue(val) {
  const s = String(val || '');
  if (s.length === 0) return '';
  if (s.length <= 8) return '••••••••';
  return s.slice(0, 4) + '••••••••' + s.slice(-4);
}

/**
 * Parse browser name from device name string (e.g. "Edge 120 on Windows 10/11" -> "Edge")
 */
export function parseBrowserFromDeviceName(deviceName) {
  const str = String(deviceName || '').trim();
  if (/edge|edg/i.test(str)) return 'Edge';
  if (/brave/i.test(str)) return 'Brave';
  if (/opera|opr/i.test(str)) return 'Opera';
  if (/firefox/i.test(str)) return 'Firefox';
  if (/safari/i.test(str) && !/chrome/i.test(str)) return 'Safari';
  if (/chrome/i.test(str)) return 'Chrome';
  return 'Browser';
}

/**
 * Summarize cookies into a clear array of token items for the store.
 */
export function summarizeCookies(cookies = []) {
  if (!Array.isArray(cookies)) return [];
  return cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path || '/',
    isAuth: isAuthToken(c.name, c.value),
    maskedVal: maskTokenValue(c.value),
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    expirationDate: c.expirationDate,
    session: !!c.session,
  }));
}

/**
 * Fetch the entire persistent collection of active swaps.
 * Includes migration from legacy swap_backup_* keys if needed.
 */
export async function getActiveSwapsCollection() {
  const all = await CH.storage.local.get(null);
  let collection = all[ACTIVE_SWAPS_KEY] || {};

  // Check legacy swap_backup_* entries and fold them in if not already present
  let hasMigrated = false;
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('swap_backup_') && v?.rootDomain) {
      const rd = v.rootDomain;
      if (!collection[rd]) {
        collection[rd] = {
          host: v.host || rd,
          rootDomain: rd,
          swappedAt: v.swappedAt || Date.now(),
          isLocked: true,
          origin: {
            deviceId: 'unknown',
            deviceName: 'Local Browser (Original)',
            browser: 'Browser',
            os: '',
            cookies: v.originalCookies || [],
            tokens: summarizeCookies(v.originalCookies || []),
          },
          target: {
            deviceId: 'unknown',
            deviceName: v.swappedWithDevice || 'Remote Session',
            browser: parseBrowserFromDeviceName(v.swappedWithDevice),
            os: '',
            cookies: [],
            tokens: [],
          },
        };
        hasMigrated = true;
      }
    }
  }

  if (hasMigrated) {
    await CH.storage.local.set({ [ACTIVE_SWAPS_KEY]: collection });
  }

  return collection;
}

/**
 * Retrieve active swap record for a domain/rootDomain, if any.
 */
export async function getSwapRecord(domain) {
  if (!domain) return null;
  const root = getRootDomain(domain);
  const clean = cleanDomain(domain);

  const collection = await getActiveSwapsCollection();
  if (collection[root]) return collection[root];
  if (collection[clean]) return collection[clean];

  // Direct check for legacy key
  const legacyKey = `swap_backup_${root}`;
  const legacy = await CH.storage.local.get(legacyKey);
  if (legacy[legacyKey]) {
    const v = legacy[legacyKey];
    return {
      host: v.host || root,
      rootDomain: root,
      swappedAt: v.swappedAt || Date.now(),
      isLocked: true,
      origin: {
        deviceId: 'unknown',
        deviceName: 'Local Browser',
        browser: 'Browser',
        os: '',
        cookies: v.originalCookies || [],
        tokens: summarizeCookies(v.originalCookies || []),
      },
      target: {
        deviceId: 'unknown',
        deviceName: v.swappedWithDevice || 'Remote Session',
        browser: parseBrowserFromDeviceName(v.swappedWithDevice),
        os: '',
        cookies: [],
        tokens: [],
      },
    };
  }

  return null;
}

/**
 * Check if a domain currently has an active swap record.
 */
export async function isDomainSwapped(domain) {
  const rec = await getSwapRecord(domain);
  return !!rec;
}

/**
 * Save a new swap record to the persistent collection.
 * Enforces isLocked = true to prevent 3rd device / 3rd browser swaps.
 */
export async function saveSwapRecord({
  host,
  currentCookies = [],
  remoteCookies = [],
  targetDeviceId = '',
  targetDeviceName = '',
}) {
  const rootDomain = getRootDomain(host);
  const currentDeviceId = await getOrCreateDeviceId();
  const { name: currentDeviceName, browserInfo } = detectDeviceEnvironment();

  const originBrowser = browserInfo?.browser || 'Browser';
  const originOS = browserInfo?.os || '';
  const targetBrowser = parseBrowserFromDeviceName(targetDeviceName);

  const swapRecord = {
    host,
    rootDomain,
    swappedAt: Date.now(),
    isLocked: true, // Prevents 3rd device/browser swapping
    origin: {
      deviceId: currentDeviceId,
      deviceName: currentDeviceName,
      browser: originBrowser,
      os: originOS,
      cookies: currentCookies,
      cookieCount: currentCookies.length,
      tokens: summarizeCookies(currentCookies),
    },
    target: {
      deviceId: targetDeviceId,
      deviceName: targetDeviceName || 'Remote Session',
      browser: targetBrowser,
      os: '',
      cookies: remoteCookies,
      cookieCount: remoteCookies.length,
      tokens: summarizeCookies(remoteCookies),
    },
  };

  // 1. Update persistent collection
  const all = await CH.storage.local.get(ACTIVE_SWAPS_KEY);
  const collection = all[ACTIVE_SWAPS_KEY] || {};
  collection[rootDomain] = swapRecord;

  // 2. Also keep legacy swap_backup_* format for backward compatibility
  const legacyKey = `swap_backup_${rootDomain}`;
  await CH.storage.local.set({
    [ACTIVE_SWAPS_KEY]: collection,
    [legacyKey]: {
      host,
      rootDomain,
      originalCookies: currentCookies,
      swappedWithDevice: targetDeviceName || 'Other Device',
      swappedAt: swapRecord.swappedAt,
      originDevice: currentDeviceName,
      originBrowser,
    },
  });

  return swapRecord;
}

/**
 * Remove swap record from persistent collection upon Rollback.
 * Deletes both persistent collection entry and legacy backup keys.
 */
export async function removeSwapRecord(domain) {
  const rootDomain = getRootDomain(domain);
  const clean = cleanDomain(domain);

  // 1. Remove from collection
  const all = await CH.storage.local.get(ACTIVE_SWAPS_KEY);
  const collection = all[ACTIVE_SWAPS_KEY] || {};
  delete collection[rootDomain];
  delete collection[clean];

  // 2. Remove legacy keys
  const legacyKeys = [
    `swap_backup_${rootDomain}`,
    `swap_backup_${clean}`,
  ];

  await CH.storage.local.set({ [ACTIVE_SWAPS_KEY]: collection });
  await CH.storage.local.remove(legacyKeys);

  return { ok: true, removedDomain: rootDomain };
}

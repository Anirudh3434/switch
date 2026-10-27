// Snapshot orchestration: capture cookies + localStorage, restore both, and
// decide whether to offer a restore when the user hits a login form.
//
// NOTE ON localStorage: there is NO extension API for it. The only way in is a
// content script running inside the page's origin. We therefore grant
// per-origin optional host permissions and register content scripts for that
// origin (see ensureContentScripts below).
//
// NOTE ON RUN_AT: restore.js must be document_start (write storage before the
// app boots); login-detector.js must be document_idle (DOM is usable). One
// registration = one run_at, so we register two entries per origin.

import { captureCookies, applyCookies } from './cookies.js';
import { fetchRemoteSessions } from './device.js';

const CH = chrome;

const SNAP_KEY = (host) => `snap:${host}`;
const PENDING_KEY = (host) => `switch:pending:${host}`;
const GRANTED_KEY = 'switch:granted';

// Login-prompt bookkeeping.
const ATTEMPT_KEY = (host) => `attempt:${host}`;   // last restore attempt (ms)
const REJECTED_KEY = (host) => `rejected:${host}`; // did we already say "site said no"
const NEVER_KEY = (host) => `never:${host}`;       // user opted out for this site
const DETECT_KEY = 'detectEnabled';                // global on/off

/** A pattern broad enough to cover the origin and its subdomains. */
const patternFor = (host) => `*://*.${host}/*`;

const readLocalStorageFromPage = () => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out[k] = localStorage.getItem(k);
  }
  return { origin: location.origin, storage: out };
};

async function grantedHosts() {
  return (await CH.storage.local.get(GRANTED_KEY))[GRANTED_KEY] || [];
}

async function addGrantedHost(host) {
  const hosts = await grantedHosts();
  if (!hosts.includes(host)) {
    await CH.storage.local.set({ [GRANTED_KEY]: [...hosts, host] });
  }
}

/**
 * Register the per-origin content scripts.
 * - restore.js  -> document_start, writes localStorage before the app boots
 * - login-detector.js -> document_idle, offers a restore on login forms
 */
async function ensureContentScripts(host) {
  const slug = host.replace(/[^a-z0-9]/gi, '-');

  const defs = [
    {
      id: `switch-restore-${slug}`,
      matches: [patternFor(host)],
      js: ['src/content/restore.js'],
      runAt: 'document_start',
    },
    {
      id: `switch-detector-${slug}`,
      matches: [patternFor(host)],
      js: ['src/content/login-detector.js'],
      runAt: 'document_idle',
    },
  ];

  for (const def of defs) {
    try {
      const existing = await CH.scripting.getRegisteredContentScripts({ ids: [def.id] });
      if (existing.length) continue;
      await CH.scripting.registerContentScripts([
        { ...def, persistAcrossSessions: true },
      ]);
    } catch (e) {
      console.warn('[switch] registerContentScripts failed', def.id, e);
    }
  }
}

/** CAPTURE — pull everything for the origin of `rawUrl`. */
export async function captureSite(rawUrl, tabId) {
  const url = new URL(rawUrl);
  const host = url.hostname;

  const cookies = await captureCookies(url.origin);

  // localStorage must be read from inside the page.
  let storage = {};
  try {
    const [{ result }] = await CH.scripting.executeScript({
      target: { tabId },
      func: readLocalStorageFromPage,
    });
    storage = result?.storage || {};
  } catch (e) {
    console.warn('[switch] localStorage read failed (no host permission?)', e);
  }

  const snapshot = {
    v: 1,
    host,
    origin: url.origin,
    capturedAt: Date.now(),
    cookies,
    storage,
  };

  await CH.storage.local.set({ [SNAP_KEY(host)]: snapshot });
  await addGrantedHost(host);
  await ensureContentScripts(host);
  return snapshot;
}

/** RESTORE — put a snapshot back into this browser. */
export async function restoreSite(host, tabId) {
  let snapshot = (await CH.storage.local.get(SNAP_KEY(host)))[SNAP_KEY(host)];
  let cookiesToApply = snapshot?.cookies;

  // If local snapshot not found or empty, fetch from remote backend database
  if (!cookiesToApply || cookiesToApply.length === 0) {
    const { serverUrl, accessToken } = await CH.storage.local.get(['serverUrl', 'accessToken']);
    if (serverUrl && accessToken) {
      const remoteSessions = await fetchRemoteSessions(serverUrl, accessToken);
      const cleanH = host.replace(/^\./, '').toLowerCase();
      const match = remoteSessions.find((s) => {
        const sHost = (s.host || '').replace(/^\./, '').toLowerCase();
        return cleanH === sHost || cleanH.endsWith('.' + sHost) || sHost.endsWith('.' + cleanH);
      });
      if (match?.cookies?.length) {
        cookiesToApply = match.cookies;
      }
    }
  }

  if (!cookiesToApply || cookiesToApply.length === 0) {
    throw new Error(`No saved session for ${host}`);
  }

  // 1. Cookies first — always before navigation
  const cookieResult = await applyCookies(cookiesToApply);

  // 2. Queue localStorage for the document_start script if available
  if (snapshot?.storage) {
    await CH.storage.local.set({
      [PENDING_KEY(host)]: { storage: snapshot.storage, at: Date.now() },
    });
    await ensureContentScripts(host);
  }

  // 3. Record attempt
  await CH.storage.local.set({
    [ATTEMPT_KEY(host)]: Date.now(),
    [REJECTED_KEY(host)]: false,
  });

  // 4. Reload page so cookies take effect immediately
  if (tabId) {
    await CH.tabs.reload(tabId);
    setTimeout(() => CH.tabs.reload(tabId).catch(() => {}), 800);
  }

  return {
    host,
    cookies: cookieResult,
    storageKeys: Object.keys(snapshot?.storage || {}).length,
  };
}

/**
 * Should we offer a restore on this host's login form?
 * Returns { local, remote, attempt, rejectedShown }.
 */
export async function hasSession(host, remoteHas) {
  const cleanH = host.replace(/^\./, '').toLowerCase();
  const all = await CH.storage.local.get(null);

  // Check local snapshot matching host or parent domain
  let localFound = false;
  for (const k of Object.keys(all)) {
    if (k.startsWith('snap:')) {
      const snapHost = k.replace(/^snap:/, '').toLowerCase();
      if (cleanH === snapHost || cleanH.endsWith('.' + snapHost) || snapHost.endsWith('.' + cleanH)) {
        localFound = true;
        break;
      }
    }
  }

  const flags = await CH.storage.local.get([
    ATTEMPT_KEY(host),
    REJECTED_KEY(host),
    NEVER_KEY(host),
    DETECT_KEY,
  ]);

  // Global off, or user said "never on this site" -> stay silent.
  if (flags[DETECT_KEY] === false) return { local: false, remote: false, silent: true };
  if (flags[NEVER_KEY(host)]) return { local: false, remote: false, silent: true };

  return {
    local: localFound,
    remote: !!remoteHas,
    attempt: flags[ATTEMPT_KEY(host)] || null,
    rejectedShown: !!flags[REJECTED_KEY(host)],
  };
}

export async function markRejectedShown(host) {
  await CH.storage.local.set({ [REJECTED_KEY(host)]: true });
}

export async function neverAsk(host) {
  // Note: `undefined` is NOT a valid storage value — chrome.storage throws.
  // The per-site opt-out wins, so the global toggle is left untouched.
  await CH.storage.local.set({ [NEVER_KEY(host)]: true });
}

export async function setDetectEnabled(enabled) {
  await CH.storage.local.set({ [DETECT_KEY]: !!enabled });
}

export async function listSaved() {
  const all = await CH.storage.local.get(null);
  const hosts = await grantedHosts();
  return Object.keys(all)
    .filter((k) => k.startsWith('snap:'))
    .map((k) => {
      const s = all[k];
      return {
        host: s.host,
        capturedAt: s.capturedAt,
        cookieCount: s.cookies?.length || 0,
        storageKeys: Object.keys(s.storage || {}).length,
        live: hosts.includes(s.host),
      };
    })
    .sort((a, b) => b.capturedAt - a.capturedAt);
}

export async function deleteSaved(host) {
  await CH.storage.local.remove([
    SNAP_KEY(host),
    PENDING_KEY(host),
    ATTEMPT_KEY(host),
    REJECTED_KEY(host),
  ]);
}

export async function getSnapshot(host) {
  return (await CH.storage.local.get(SNAP_KEY(host)))[SNAP_KEY(host)] || null;
}

export async function putSnapshot(snapshot) {
  await CH.storage.local.set({ [SNAP_KEY(snapshot.host)]: snapshot });
  await addGrantedHost(snapshot.host);
  await ensureContentScripts(snapshot.host);
}

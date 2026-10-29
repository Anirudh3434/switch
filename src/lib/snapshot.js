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
//
// AT-REST ENCRYPTION: snapshots contain live session cookies. They are sealed
// with the in-memory vault key and bound to the host, so chrome.storage.local
// never holds a plaintext credential. Legacy plaintext snapshots from older
// versions are re-sealed on the first unlocked read; while locked they are not
// served.

import { captureCookies, applyCookies } from './cookies.js';
import { seal, open, getOrCreateVaultKey, hasVaultKey } from './crypto.js';
import { fetchRemoteSessions } from './device.js';
import { getServerUrl, getValidAccessToken } from './auth.js';
import { hostMatches, normalizeHost } from './domain.js';

const CH = chrome;

const SNAP_KEY = (host) => `snap:${host}`;
const PENDING_KEY = (host) => `switch:pending:${host}`;
const GRANTED_KEY = 'switch:granted';

// Login-prompt bookkeeping.
const ATTEMPT_KEY = (host) => `attempt:${host}`; // last restore attempt (ms)
const REJECTED_KEY = (host) => `rejected:${host}`; // did we already say "site said no"
const NEVER_KEY = (host) => `never:${host}`; // user opted out for this site
const DETECT_KEY = 'detectEnabled'; // global on/off

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

export async function grantedHosts() {
  return (await CH.storage.local.get(GRANTED_KEY))[GRANTED_KEY] || [];
}

async function addGrantedHost(host) {
  const clean = normalizeHost(host);
  if (!clean) return;
  const hosts = await grantedHosts();
  if (!hosts.includes(clean)) {
    await CH.storage.local.set({ [GRANTED_KEY]: [...hosts, clean] });
  }
}

async function removeGrantedHost(host) {
  const clean = normalizeHost(host);
  const hosts = await grantedHosts();
  await CH.storage.local.set({
    [GRANTED_KEY]: hosts.filter((h) => h !== clean),
  });
}

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
      const existing = await CH.scripting.getRegisteredContentScripts({
        ids: [def.id],
      });
      if (existing.length) continue;
      await CH.scripting.registerContentScripts([
        { ...def, persistAcrossSessions: true },
      ]);
    } catch (e) {
      console.warn('[switch] registerContentScripts failed', def.id, e);
    }
  }
}

async function unregisterContentScripts(host) {
  const slug = host.replace(/[^a-z0-9]/gi, '-');
  try {
    await CH.scripting.unregisterContentScripts({
      ids: [`switch-restore-${slug}`, `switch-detector-${slug}`],
    });
  } catch {
    // Not registered, fine.
  }
}

/** Store a snapshot sealed with the vault key. */
async function writeSnapshot(snapshot) {
  const vaultKey = await getOrCreateVaultKey();
  const host = normalizeHost(snapshot.host);
  const { cookies, storage, ...meta } = snapshot;

  const envelope = await seal(
    vaultKey,
    { cookies: cookies || [], storage: storage || {} },
    `snap:${host}`,
  );

  const record = {
    ...meta,
    v: 2,
    host,
    sealed: true,
    envelope,
    cookieCount: (cookies || []).length,
    storageKeys: Object.keys(storage || {}).length,
  };
  await CH.storage.local.set({ [SNAP_KEY(host)]: record });
  await addGrantedHost(host);
  await ensureContentScripts(host);
  return record;
}

/**
 * Read a snapshot, transparently unsealing it.
 *
 * Legacy plaintext snapshots are migrated to the encrypted format when a vault
 * key is available. If the vault is locked we refuse to return plaintext: the
 * caller shows an unlock prompt instead.
 */
async function readSnapshot(host) {
  const clean = normalizeHost(host);
  const record = (await CH.storage.local.get(SNAP_KEY(clean)))[SNAP_KEY(clean)];
  if (!record) return null;

  if (!record.sealed) {
    // Legacy plaintext record. Do not serve it while the vault is locked: the
    // whole point of at-rest encryption is that plaintext cookies are not
    // available until the user unlocks. Migrate on the first unlocked read.
    if (!(await hasVaultKey())) {
      const err = new Error(
        'Vault is locked. Re-enter your master password to open saved sessions.',
      );
      err.code = 'vault_locked';
      throw err;
    }

    const snapshot = {
      v: 1,
      host: record.host || clean,
      origin: record.origin,
      capturedAt: record.capturedAt,
      cookies: record.cookies || [],
      storage: record.storage || {},
    };
    try {
      const { cookies, storage, ...meta } = snapshot;
      await writeSnapshot({ ...meta, cookies, storage });
    } catch (e) {
      console.warn('[switch] snapshot migration failed:', e?.message || e);
    }
    return snapshot;
  }

  const vaultKey = await getOrCreateVaultKey();
  const payload = await open(vaultKey, record.envelope, `snap:${clean}`);
  return {
    v: 2,
    host: record.host || clean,
    origin: record.origin,
    capturedAt: record.capturedAt,
    cookies: payload.cookies || [],
    storage: payload.storage || {},
  };
}

/** CAPTURE — pull everything for the origin of `rawUrl`. */
export async function captureSite(rawUrl, tabId) {
  const url = new URL(rawUrl);
  const host = normalizeHost(url.hostname);

  const cookies = await captureCookies(url.origin);

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
    v: 2,
    host,
    origin: url.origin,
    capturedAt: Date.now(),
    cookies,
    storage,
  };

  await writeSnapshot(snapshot);
  return snapshot;
}

/** RESTORE — put a snapshot back into this browser. */
export async function restoreSite(host, tabId) {
  const clean = normalizeHost(host);
  const snapshot = await readSnapshot(clean).catch((e) => {
    if (e?.code === 'vault_locked') throw e;
    console.warn('[switch] snapshot read failed:', e?.message || e);
    return null;
  });

  let cookiesToApply = snapshot?.cookies;

  if (!cookiesToApply || cookiesToApply.length === 0) {
    const serverUrl = await getServerUrl();
    const accessToken = await getValidAccessToken();
    if (serverUrl && accessToken) {
      const remoteSessions = await fetchRemoteSessions(serverUrl, accessToken);
      const match = remoteSessions.find((s) => hostMatches(s.host, clean));
      if (match?.cookies?.length) cookiesToApply = match.cookies;
    }
  }

  if (!cookiesToApply || cookiesToApply.length === 0) {
    throw new Error(`No saved session for ${host}`);
  }

  const cookieResult = await applyCookies(cookiesToApply);

  if (snapshot?.storage && Object.keys(snapshot.storage).length) {
    await CH.storage.local.set({
      [PENDING_KEY(clean)]: { storage: snapshot.storage, at: Date.now() },
    });
    await ensureContentScripts(clean);
  }

  await CH.storage.local.set({
    [ATTEMPT_KEY(clean)]: Date.now(),
    [REJECTED_KEY(clean)]: false,
  });

  if (tabId) {
    await CH.tabs.reload(tabId);
    setTimeout(() => CH.tabs.reload(tabId).catch(() => {}), 800);
  }

  return {
    host: clean,
    cookies: cookieResult,
    storageKeys: Object.keys(snapshot?.storage || {}).length,
  };
}

export async function hasSession(host, remoteHas) {
  const clean = normalizeHost(host);
  const all = await CH.storage.local.get(null);

  let localFound = false;
  for (const k of Object.keys(all)) {
    if (k.startsWith('snap:')) {
      const snapHost = k.replace(/^snap:/, '');
      if (hostMatches(snapHost, clean)) {
        localFound = true;
        break;
      }
    }
  }

  const flags = await CH.storage.local.get([
    ATTEMPT_KEY(clean),
    REJECTED_KEY(clean),
    NEVER_KEY(clean),
    DETECT_KEY,
  ]);

  if (flags[DETECT_KEY] === false) return { local: false, remote: false, silent: true };
  if (flags[NEVER_KEY(clean)]) return { local: false, remote: false, silent: true };

  return {
    local: localFound,
    remote: !!remoteHas,
    attempt: flags[ATTEMPT_KEY(clean)] || null,
    rejectedShown: !!flags[REJECTED_KEY(clean)],
  };
}

export async function markRejectedShown(host) {
  await CH.storage.local.set({ [REJECTED_KEY(normalizeHost(host))]: true });
}

export async function neverAsk(host) {
  await CH.storage.local.set({ [NEVER_KEY(normalizeHost(host))]: true });
}

export async function setDetectEnabled(enabled) {
  await CH.storage.local.set({ [DETECT_KEY]: !!enabled });
}

/**
 * Mark a site as explicitly saved: remember it and register the restore /
 * login-detector content scripts for that origin.
 *
 * Only called after an explicit user action (Save/Sync for that site).
 */
export async function grantSite(host) {
  const clean = normalizeHost(host);
  if (!clean) return null;
  await addGrantedHost(clean);
  await ensureContentScripts(clean);
  return clean;
}

/** Revoke the saved/granted state for a site. */
export async function revokeSite(host) {
  const clean = normalizeHost(host);
  if (!clean) return null;
  await removeGrantedHost(clean);
  await unregisterContentScripts(clean);
  return clean;
}

export async function listSaved() {
  const all = await CH.storage.local.get(null);
  const hosts = await grantedHosts();
  return Object.keys(all)
    .filter((k) => k.startsWith('snap:'))
    .map((k) => {
      const s = all[k];
      return {
        host: s.host || k.replace(/^snap:/, ''),
        capturedAt: s.capturedAt,
        cookieCount: s.cookieCount ?? s.cookies?.length ?? 0,
        storageKeys: s.storageKeys ?? Object.keys(s.storage || {}).length,
        sealed: !!s.sealed,
        live: hosts.includes(s.host || k.replace(/^snap:/, '')),
      };
    })
    .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
}

export async function deleteSaved(host) {
  const clean = normalizeHost(host);
  await CH.storage.local.remove([
    SNAP_KEY(clean),
    PENDING_KEY(clean),
    ATTEMPT_KEY(clean),
    REJECTED_KEY(clean),
  ]);
  await removeGrantedHost(clean);
  await unregisterContentScripts(clean);
}

export async function getSnapshot(host) {
  return readSnapshot(host).catch((e) => {
    if (e?.code === 'vault_locked') throw e;
    return null;
  });
}

/** Import path: seal the snapshot before persisting it. */
export async function putSnapshot(snapshot) {
  await writeSnapshot(snapshot);
}

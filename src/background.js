// MV3 service worker — message router.
// Runs up to ~30s idle / 5min max, so no long-lived work here.

import {
  captureSite,
  restoreSite,
  listSaved,
  deleteSaved,
  getSnapshot,
  putSnapshot,
  hasSession,
  markRejectedShown,
  neverAsk,
  setDetectEnabled,
} from './lib/snapshot.js';
import { pack, unpack } from './lib/crypto.js';
import {
  isConsented,
  isStaleConsent,
  giveConsent,
  withdrawConsent,
  PROTOCOL,
} from './lib/consent.js';
import {
  login,
  register,
  logout,
  forgotPassword,
  resetPassword,
  sendEmailOtp,
  verifyEmailOtp,
  getAuthStatus,
  refreshSession,
  getValidAccessToken,
  setServerUrl,
  isAuthToken,
} from './lib/auth.js';
import { applyCookies } from './lib/cookies.js';
import {
  isLocalhost,
  isSearchEngine,
  registerDevice,
  fetchUserDevices,
  revokeDevice,
  getOrCreateDeviceId,
  getOrCreateSystemId,
  detectDeviceEnvironment,
  fetchRemoteSessions,
  pushDomainSession,
  pushBatchDomainSessions,
  deleteDomainSessionFromServer,
} from './lib/device.js';
import {
  saveSwapRecord,
  getSwapRecord,
  removeSwapRecord,
  getActiveSwapsCollection,
  isDomainSwapped,
} from './lib/swap-store.js';

// Debug logging - disabled in production
const DEBUG = false;
const log = (...args) => {
  if (DEBUG) console.log('[switch]', ...args);
};
const warn = (...args) => {
  if (DEBUG) console.warn('[switch]', ...args);
};
const error = (...args) => {
  console.error('[switch]', ...args);
};

// First install, or an update that changed the disclosure wording -> open the
// onboarding tab so consent is obtained BEFORE any data is handled.
// (Disclosure Requirements #2: consent prior to data handling.)
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  if (await isConsented()) return;

  await chrome.tabs.create({
    url: chrome.runtime.getURL('src/onboarding/onboarding.html'),
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((e) => {
      const errMsg = String(e?.message || e);
      const isRateLimited = e?.code === 'rate_limited' || errMsg.includes('rate_limited') || errMsg.includes('Too many requests');
      sendResponse({
        ok: false,
        error: errMsg,
        code: isRateLimited ? 'rate_limited' : e?.code,
        retryAfterSeconds: e?.retryAfterSeconds || (isRateLimited ? 60 : undefined),
      });
    });
  return true; // keep the channel open for the async response
});

/**
 * Remote vault lookup. Returns null when the user isn't signed in or no server
 * is configured — the caller treats that as "no remote session" and stays
 * silent about it. Wired to the /v1/sync/list endpoint once auth lands.
 */
async function remoteHasSession(host) {
  try {
    const { serverUrl, accessToken } = await chrome.storage.local.get([
      'serverUrl',
      'accessToken',
    ]);
    if (!serverUrl || !accessToken) return false;

    const res = await fetch(`${serverUrl}/v1/sync/list`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return false;
    const { items } = await res.json();
    return (items || []).some((i) => i.host === host);
  } catch {
    return false; // offline / server down must never block the page
  }
}

/**
 * Broadcasts the DevTools Inspect & Suction Warp animation to the currently active web tab.
 * Dynamically injects the content script if the tab hasn't loaded it yet.
 */
async function broadcastSyncAnimationToActiveTab(domain, cookies) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (
      !tab?.id ||
      !tab.url ||
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:') ||
      tab.url.startsWith('chrome-extension://')
    ) {
      return;
    }

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'PLAY_SYNC_INSPECT_ANIMATION',
        domain,
        cookies,
      });
    } catch {
      // If content script was not already present, inject dynamically and replay
      if (chrome.scripting && chrome.scripting.executeScript) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content/inspect-sync-animation.js'],
        }).catch(() => {});
        await chrome.tabs.sendMessage(tab.id, {
          type: 'PLAY_SYNC_INSPECT_ANIMATION',
          domain,
          cookies,
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.debug('[switch] broadcastSyncAnimationToActiveTab error:', e);
  }
}

/**
 * Broadcasts the rich holographic token key swap animation to the target tab.
 * Dynamically injects swap-animation.js if not yet present.
 */
async function broadcastSwapKeyAnimation(tabId, domain, originDevice, targetDevice, isRollback = false) {
  if (!tabId) return;
  const payload = {
    type: 'PLAY_SWAP_TOKEN_ANIMATION',
    domain,
    originDevice,
    targetDevice,
    isRollback,
  };

  try {
    try {
      await chrome.tabs.sendMessage(tabId, payload);
    } catch {
      if (chrome.scripting && chrome.scripting.executeScript) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content/swap-animation.js'],
        }).catch(() => {});
        await chrome.tabs.sendMessage(tabId, payload).catch(() => {});
      }
    }
  } catch (e) {
    console.debug('[switch] broadcastSwapKeyAnimation error:', e);
  }
}

async function handle(msg, sender) {
  switch (msg.type) {
    case 'CAPTURE':
      return { snapshot: await captureSite(msg.url, msg.tabId) };

    case 'RESTORE':
      return { result: await restoreSite(msg.host, msg.tabId) };

    // Fired from the in-page toast. Resolve the tab from the sender instead of
    // trusting a tabId that could come from anywhere.
    case 'RESTORE_FROM_PAGE': {
      const tabId = sender?.tab?.id;
      const result = await restoreSite(msg.host, tabId);
      return { result };
    }
    case 'GET_ACTIVE_TAB_SWAP_INFO': {
      let tab = sender?.tab;
      if (!tab) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs[0];
      }
      if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
        return { ok: false, reason: 'internal_page' };
      }

      let host = '';
      try {
        host = new URL(tab.url).hostname.replace(/^\./, '').toLowerCase().trim();
      } catch {
        return { ok: false, reason: 'invalid_url' };
      }

      if (isLocalhost(host) || isSearchEngine(host)) {
        return { ok: false, reason: 'ignored_host' };
      }

      // 1. Query DOM page state from content script if not already passed in msg
      let pageState = msg.pageState || { hasLoginForm: false, looksLoggedIn: false };
      if (!msg.pageState && !sender?.tab) {
        try {
          const domState = await chrome.tabs.sendMessage(tab.id, { type: 'DETECT_PAGE_STATE' });
          if (domState) pageState = domState;
        } catch {}
      }

      // 2. Query local cookies for this domain
      const rootDomain = host.split('.').slice(-2).join('.');
      const allCookies = await chrome.cookies.getAll({});
      const hostCookies = allCookies.filter((c) => {
        const d = String(c.domain || '').replace(/^\./, '').toLowerCase().trim();
        return d === host || d === rootDomain || host.endsWith('.' + d);
      });

      const currentDeviceId = await getOrCreateDeviceId();
      const hasLocalAuth = hostCookies.some((c) => isAuthToken(c.name, c.value));
      // User is logged in only if they have auth tokens / look logged in, and are NOT actively sitting on a login/signup form
      const isUserAlreadyLoggedIn = !pageState.hasLoginForm && (hasLocalAuth || pageState.looksLoggedIn || hostCookies.length > 5);

      // 3. Find other device's session for this domain
      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      const accessToken = await getValidAccessToken();
      let otherDeviceSession = null;

      if (accessToken) {
        try {
          const sessions = await fetchRemoteSessions(serverUrl || 'http://localhost:8080', accessToken);
          const match = sessions.find((s) => {
            const sh = String(s.host || '').replace(/^\./, '').toLowerCase().trim();
            const sameHost = sh === host || sh === rootDomain || host.endsWith('.' + sh) || sh.endsWith('.' + host);
            if (!sameHost || !Array.isArray(s.cookies) || s.cookies.length === 0) return false;

            // Sessions must come from ANOTHER device/browser.
            // Never recommend a session that was saved by the current device itself (which was either already logged out or is currently active).
            if (s.deviceId && s.deviceId === currentDeviceId) {
              return false;
            }

            // Must contain at least one valid auth/session token (not just empty tracking cookies)
            const hasAuthTokens = s.cookies.some((c) => isAuthToken(c.name, c.value));
            if (!hasAuthTokens) {
              return false;
            }

            return true;
          });
          if (match) otherDeviceSession = match;
        } catch (e) {
          console.warn('[switch] fetchRemoteSessions in swap info error:', e);
        }
      }

      // 4. Check persistent swap record collection for this domain
      const swapRecord = await getSwapRecord(rootDomain || host);
      const isSwapped = !!swapRecord;
      const isLocked = isSwapped; // Chained 3rd-device/browser swap is locked while swapped

      // Formulate backward-compatible backupSession
      const backupSession = swapRecord
        ? {
            host: swapRecord.host || host,
            rootDomain,
            originalCookies: swapRecord.origin?.cookies || [],
            swappedWithDevice: swapRecord.target?.deviceName || 'Remote Session',
            swappedAt: swapRecord.swappedAt || Date.now(),
            originDevice: swapRecord.origin?.deviceName,
            originBrowser: swapRecord.origin?.browser,
            targetBrowser: swapRecord.target?.browser,
            swapRecord,
          }
        : null;

      return {
        ok: true,
        host,
        tabId: tab.id,
        tabUrl: tab.url,
        tabTitle: tab.title || host,
        pageState,
        isUserAlreadyLoggedIn,
        hostCookies,
        hasLocalAuth,
        otherDeviceSession,
        backupSession,
        swapRecord,
        isSwapped,
        isLocked,
      };
    }

    case 'SWAP_ACTIVE_TAB_SESSION': {
      const { host, currentCookies, remoteCookies, tabId, baseVersion, deviceName, targetDeviceId, isInjectOnly } = msg;
      if (!host || isLocalhost(host) || isSearchEngine(host)) {
        return { ok: false, error: 'Cannot swap sessions on search engines or localhost' };
      }
      const targetTabId = tabId || sender?.tab?.id;
      const rootDomain = host.split('.').slice(-2).join('.');

      // STRICT SWAP GUARD: Disallow swapping if domain is already swapped with a device/browser.
      // Must rollback first before swapping again.
      const existingSwap = await getSwapRecord(rootDomain);
      if (existingSwap) {
        return {
          ok: false,
          error: `This domain is currently swapped with "${existingSwap.target?.deviceName || 'another device'}". You must Rollback before swapping with another device or browser.`,
          isLocked: true,
          swapRecord: existingSwap,
        };
      }

      // 1. Gather current cookies if not provided
      let cookiesToBackup = currentCookies;
      if (!Array.isArray(cookiesToBackup) || cookiesToBackup.length === 0) {
        const allCookies = await chrome.cookies.getAll({});
        cookiesToBackup = allCookies.filter((c) => {
          const d = String(c.domain || '').replace(/^\./, '').toLowerCase().trim();
          return d === host || d === rootDomain || host.endsWith('.' + d);
        });
      }

      // 2. Resolve remote cookies & target device info
      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      const accessToken = await getValidAccessToken();
      let cookiesToApply = remoteCookies;
      let finalTargetDeviceId = targetDeviceId || '';
      let finalTargetDeviceName = deviceName || 'Remote Device';

      if (!Array.isArray(cookiesToApply) || cookiesToApply.length === 0 || !finalTargetDeviceId) {
        if (accessToken) {
          const sessions = await fetchRemoteSessions(serverUrl || 'http://localhost:8080', accessToken).catch(() => []);
          const currentDeviceId = await getOrCreateDeviceId();
          const match = sessions.find((s) => {
            const sh = String(s.host || '').replace(/^\./, '').toLowerCase().trim();
            const sameHost = sh === host || sh === rootDomain || host.endsWith('.' + sh) || sh.endsWith('.' + host);
            return sameHost && s.deviceId && s.deviceId !== currentDeviceId && Array.isArray(s.cookies) && s.cookies.length > 0;
          });
          if (match) {
            if (!Array.isArray(cookiesToApply) || cookiesToApply.length === 0) {
              cookiesToApply = match.cookies;
            }
            if (!finalTargetDeviceId) finalTargetDeviceId = match.deviceId;
            if (!finalTargetDeviceName || finalTargetDeviceName === 'Remote Device') {
              finalTargetDeviceName = match.deviceName || 'Remote Device';
            }
          }
        }
      }

      // 3. Save into Persistent Swap Store Collection (skipped if isInjectOnly)
      let swapRecord = null;
      if (!isInjectOnly && Array.isArray(cookiesToBackup) && cookiesToBackup.length > 0) {
        swapRecord = await saveSwapRecord({
          host,
          currentCookies: cookiesToBackup,
          remoteCookies: cookiesToApply || [],
          targetDeviceId: finalTargetDeviceId,
          targetDeviceName: finalTargetDeviceName,
        });
      }

      // 4. Push current browser cookies to cloud so the other device/browser has them (skipped if isInjectOnly or no auth tokens)
      const hasAuthTokensToPush = Array.isArray(cookiesToBackup) && cookiesToBackup.some((c) => isAuthToken(c.name, c.value));
      if (!isInjectOnly && accessToken && hasAuthTokensToPush) {
        await pushDomainSession(
          serverUrl || 'http://localhost:8080',
          accessToken,
          host,
          cookiesToBackup,
          baseVersion || 0,
        ).catch(() => {});
      }

      // Trigger futuristic holographic token swap animation on target tab
      const swapAnimPromise = broadcastSwapKeyAnimation(
        targetTabId,
        host,
        'Local Browser',
        finalTargetDeviceName,
        false
      );

      // 5. Cleanly isolate session: Clear old domain cookies and web storage before applying remote cookies
      if (Array.isArray(cookiesToApply) && cookiesToApply.length > 0) {
        await removeDomainCookies(rootDomain, false);
        if (targetTabId && chrome.scripting && chrome.scripting.executeScript) {
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            func: () => {
              try { localStorage.clear(); } catch {}
              try { sessionStorage.clear(); } catch {}
            },
          }).catch(() => {});
        }
        await applyCookies(cookiesToApply);
      }

      // 6. Await rich key animation completion before reloading active tab
      await Promise.all([
        swapAnimPromise,
        new Promise((r) => setTimeout(r, 2100)),
      ]);

      if (targetTabId) {
        chrome.tabs.reload(targetTabId, { bypassCache: true }).catch(() => {});
      }

      return { ok: true, swapRecord };
    }

    case 'RESTORE_SWAP_BACKUP': {
      const { host, tabId } = msg;
      const targetTabId = tabId || sender?.tab?.id;
      const rootDomain = host.split('.').slice(-2).join('.');

      // 1. Retrieve persistent swap record
      const swapRecord = (await getSwapRecord(rootDomain || host));
      const originalCookies = swapRecord?.origin?.cookies || swapRecord?.originalCookies;

      if (!swapRecord || !Array.isArray(originalCookies) || originalCookies.length === 0) {
        throw new Error('No active swap record or original cookies found to rollback for this domain');
      }

      // Trigger rollback key animation
      const restoreAnimPromise = broadcastSwapKeyAnimation(
        targetTabId,
        host,
        swapRecord?.target?.deviceName || 'Remote Device',
        swapRecord?.origin?.deviceName || 'Original Session',
        true
      );

      // 2. Clear current swapped cookies and web storage from browser (without tab reload)
      await removeDomainCookies(rootDomain, false);
      if (targetTabId && chrome.scripting && chrome.scripting.executeScript) {
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          func: () => {
            try { localStorage.clear(); } catch {}
            try { sessionStorage.clear(); } catch {}
          },
        }).catch(() => {});
      }

      // 3. Exactly replace original cookies into the cookies store
      await applyCookies(originalCookies);

      // 4. Remove the record from the persistent collection (clean slate)
      await removeSwapRecord(rootDomain);

      // 5. Await key animation before reloading cleanly into original session
      await Promise.all([
        restoreAnimPromise,
        new Promise((r) => setTimeout(r, 2100)),
      ]);

      if (targetTabId) {
        chrome.tabs.reload(targetTabId, { bypassCache: true }).catch(() => {});
      }

      return {
        ok: true,
        restoredCount: originalCookies.length,
        removedRecord: rootDomain,
        message: 'Original cookies restored and swap record removed.',
      };
    }

    case 'GET_ALL_SWAP_BACKUPS': {
      const collection = await getActiveSwapsCollection();
      return { backups: collection, activeSwaps: collection };
    }

    case 'HAS_SESSION': {
      const remote = await remoteHasSession(msg.host);
      return await hasSession(msg.host, remote);
    }

    case 'MARK_REJECTED_SHOWN':
      await markRejectedShown(msg.host);
      return {};

    case 'NEVER_ASK':
      await neverAsk(msg.host);
      return {};

    case 'SET_DETECT':
      await setDetectEnabled(msg.enabled);
      return {};

    // Handshake. The popup compares PROTOCOL to detect a stale worker (see the
    // comment on PROTOCOL in lib/consent.js).
    case 'PING':
      return { protocol: PROTOCOL };

    case 'CONSENT_STATUS': {
      const consented = await isConsented();
      const stale = !consented && (await isStaleConsent());
      return { consented, stale, needsOnboarding: !consented };
    }

    case 'CONSENT_GIVE':
      return { consent: await giveConsent() };

    case 'CONSENT_WITHDRAW':
      await withdrawConsent({ wipeData: msg.wipeData !== false });
      return {};

    case 'OPEN_ONBOARDING':
      await chrome.tabs.create({
        url: chrome.runtime.getURL('src/onboarding/onboarding.html'),
      });
      return {};

    case 'LIST':
      return { sessions: await listSaved() };

    case 'DELETE':
      await deleteSaved(msg.host);
      return {};

    case 'GET_SNAPSHOT':
      return { snapshot: await getSnapshot(msg.host) };

    case 'EXPORT': {
      // Encrypt locally. The file that leaves this machine is opaque.
      const snapshots = [];
      for (const host of msg.hosts) {
        const s = await getSnapshot(host);
        if (s) snapshots.push(s);
      }
      const envelope = await pack(msg.password, { v: 1, snapshots });
      return { envelope };
    }

    case 'IMPORT': {
      const payload = await unpack(msg.password, msg.envelope);
      for (const s of payload.snapshots || []) await putSnapshot(s);
      return { imported: (payload.snapshots || []).map((s) => s.host) };
    }

    case 'AUTH_STATUS':
      return await getAuthStatus();

    case 'AUTH_SEND_OTP':
      return await sendEmailOtp(msg.email, msg.purpose, msg.serverUrl);

    case 'AUTH_VERIFY_OTP':
      return await verifyEmailOtp(msg.email, msg.otp, msg.purpose, msg.serverUrl);

    case 'AUTH_LOGIN': {
      const auth = await login(msg.email, msg.password, msg.serverUrl);
      try {
        await registerDevice(msg.serverUrl || 'http://localhost:8080', auth.accessToken);
        await syncAllBrowserCookies(msg.serverUrl || 'http://localhost:8080', auth.accessToken);
      } catch (e) {
        console.warn('[switch] device registration/sync after login:', e.message);
      }
      return auth;
    }

    case 'AUTH_REGISTER': {
      const auth = await register(msg.email, msg.password, msg.serverUrl, {
        verificationToken: msg.verificationToken,
        otp: msg.otp,
      });
      try {
        await registerDevice(msg.serverUrl || 'http://localhost:8080', auth.accessToken);
        await syncAllBrowserCookies(msg.serverUrl || 'http://localhost:8080', auth.accessToken);
      } catch (e) {
        console.warn('[switch] device registration/sync after register:', e.message);
      }
      return auth;
    }

    case 'AUTH_FORGOT_PASSWORD': {
      return await forgotPassword(msg.email, msg.serverUrl);
    }

    case 'AUTH_RESET_PASSWORD': {
      const auth = await resetPassword(msg.email, msg.newPassword, msg.serverUrl, {
        verificationToken: msg.verificationToken,
        otp: msg.otp,
      });
      try {
        await registerDevice(msg.serverUrl || 'http://localhost:8080', auth.accessToken);
        await syncAllBrowserCookies(msg.serverUrl || 'http://localhost:8080', auth.accessToken);
      } catch (e) {
        console.warn('[switch] device registration/sync after reset:', e.message);
      }
      return auth;
    }

    case 'AUTH_LOGOUT': {
      // Do NOT clear system browser cookies on logout.
      // Clear backend DB sessions/tokens for this user and wipe local extension storage keys.
      await logout();
      return { ok: true };
    }

    case 'AUTH_REFRESH':
      return await refreshSession();

    case 'AUTH_SET_SERVER':
      return { serverUrl: await setServerUrl(msg.serverUrl) };

async function syncAllBrowserCookies(serverUrl, accessToken) {
  try {
    const allCookies = await chrome.cookies.getAll({});
    const filtered = (allCookies || []).filter(
      (c) => c.domain && !isLocalhost(c.domain)
    );

    const domainMap = new Map();
    for (const c of filtered) {
      const d = String(c.domain || '').replace(/^\./, '').toLowerCase().trim();
      if (!d) continue;
      if (!domainMap.has(d)) {
        domainMap.set(d, []);
      }
      domainMap.get(d).push(c);
    }

    const domainList = Array.from(domainMap.entries()).map(([host, cookies]) => ({
      host,
      cookies,
      baseVersion: 0,
    }));

    if (domainList.length === 0) {
      return { ok: true, syncedCount: 0, totalCookiesCount: 0 };
    }

    const res = await pushBatchDomainSessions(
      serverUrl || 'http://localhost:8080',
      accessToken,
      domainList,
    );

    return {
      ok: true,
      syncedCount: res.syncedCount,
      totalCookiesCount: filtered.length,
      domainList,
      filtered,
    };
  } catch (e) {
    console.warn('[switch] syncAllBrowserCookies error:', e);
    return { ok: false, error: e.message };
  }
}

    case 'DEVICE_GET_CURRENT': {
      const deviceId = await getOrCreateDeviceId();
      const systemId = await getOrCreateSystemId();
      const { name, browserInfo } = detectDeviceEnvironment();
      return { deviceId, systemId, name, browserInfo };
    }

    case 'DEVICE_REGISTER': {
      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      let accessToken = await getValidAccessToken();
      if (!accessToken) return { ok: false, error: 'Not authenticated' };
      try {
        const info = await registerDevice(serverUrl || 'http://localhost:8080', accessToken);
        return { ok: true, ...info };
      } catch (err) {
        if (String(err?.message || '').includes('401')) {
          const refreshed = await refreshSession().catch(() => null);
          if (refreshed?.accessToken) {
            const info = await registerDevice(serverUrl || 'http://localhost:8080', refreshed.accessToken);
            return { ok: true, ...info };
          }
        }
        throw err;
      }
    }

    case 'DEVICE_LIST': {
      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      let accessToken = await getValidAccessToken();
      if (!accessToken) return { items: [] };
      try {
        const items = await fetchUserDevices(serverUrl || 'http://localhost:8080', accessToken);
        return { items };
      } catch (err) {
        if (String(err?.message || '').includes('401')) {
          const refreshed = await refreshSession().catch(() => null);
          if (refreshed?.accessToken) {
            const items = await fetchUserDevices(serverUrl || 'http://localhost:8080', refreshed.accessToken);
            return { items };
          }
        }
        return { items: [] };
      }
    }

    case 'DEVICE_REVOKE': {
      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      let accessToken = await getValidAccessToken();
      if (!accessToken) return { ok: false, error: 'Not authenticated' };
      try {
        return await revokeDevice(serverUrl || 'http://localhost:8080', accessToken, msg.deviceId);
      } catch (err) {
        if (String(err?.message || '').includes('401')) {
          const refreshed = await refreshSession().catch(() => null);
          if (refreshed?.accessToken) {
            return await revokeDevice(serverUrl || 'http://localhost:8080', refreshed.accessToken, msg.deviceId);
          }
        }
        throw err;
      }
    }

    case 'SYNC_PULL_SESSIONS': {
      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      let accessToken = await getValidAccessToken();
      if (!accessToken) return { sessions: [] };
      try {
        const sessions = await fetchRemoteSessions(serverUrl || 'http://localhost:8080', accessToken);
        return { sessions };
      } catch (err) {
        if (String(err?.message || '').includes('401')) {
          const refreshed = await refreshSession().catch(() => null);
          if (refreshed?.accessToken) {
            const sessions = await fetchRemoteSessions(serverUrl || 'http://localhost:8080', refreshed.accessToken);
            return { sessions };
          }
        }
        return { sessions: [] };
      }
    }

    case 'SYNC_PUSH_DOMAIN': {
      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      let accessToken = await getValidAccessToken();
      if (!accessToken) throw new Error('Not authenticated');
      try {
        return await pushDomainSession(
          serverUrl || 'http://localhost:8080',
          accessToken,
          msg.host,
          msg.cookies,
          msg.baseVersion || 0,
        );
      } catch (err) {
        if (String(err?.message || '').includes('401')) {
          const refreshed = await refreshSession().catch(() => null);
          if (refreshed?.accessToken) {
            return await pushDomainSession(
              serverUrl || 'http://localhost:8080',
              refreshed.accessToken,
              msg.host,
              msg.cookies,
              msg.baseVersion || 0,
            );
          }
        }
        throw err;
      }
    }

    case 'SYNC_PUSH_ALL': {
      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      let accessToken = await getValidAccessToken();
      if (!accessToken) {
        const refreshed = await refreshSession().catch(() => null);
        accessToken = refreshed?.accessToken;
      }
      if (!accessToken) throw new Error('Not authenticated');

      const result = await syncAllBrowserCookies(serverUrl || 'http://localhost:8080', accessToken);

      return {
        ok: true,
        syncedDomainsCount: result?.syncedCount || 0,
        totalCookiesCount: result?.totalCookiesCount || 0,
      };
    }

    case 'APPLY_COOKIES': {
      if (!Array.isArray(msg.cookies)) return { restored: 0, failed: [] };
      return await applyCookies(msg.cookies);
    }

    case 'GET_ALL_BROWSER_COOKIES': {
      try {
        const query = msg.domain ? { domain: msg.domain } : {};
        const cookies = await chrome.cookies.getAll(query);
        // Exclude all localhost, 127.0.0.1, ::1 tokens & cookies
        const filtered = (cookies || []).filter((c) => !isLocalhost(c.domain));
        return { cookies: filtered };
      } catch (e) {
        return { cookies: [], error: String(e?.message || e) };
      }
    }

    case 'DELETE_DOMAIN_SESSION': {
      const { host, deleteServer = false } = msg;
      if (!host) throw new Error('Host required');

      // 1. Remove cookies matching domain from browser
      const cookiesRemoved = await removeDomainCookies(host);

      // 2. Remove local storage swap backups and snapshots
      const storageKeysRemoved = await removeDomainLocalStorage(host);

      // 3. Delete session from cloud server ONLY if deleteServer is explicitly requested
      let serverDeleted = false;
      if (deleteServer) {
        try {
          const { serverUrl } = await chrome.storage.local.get('serverUrl');
          const accessToken = await getValidAccessToken();
          if (accessToken) {
            serverDeleted = await deleteDomainSessionFromServer(
              serverUrl || 'http://localhost:8080',
              accessToken,
              host,
            );
          }
        } catch (e) {
          console.warn('[switch] server session deletion error:', e);
        }
      }

      return {
        ok: true,
        host,
        cookiesRemovedCount: cookiesRemoved.length,
        storageKeysRemoved,
        serverDeleted,
      };
    }

    case 'DELETE_SINGLE_COOKIE': {
      const { cookie } = msg;
      if (!cookie || !cookie.name || !cookie.domain) {
        throw new Error('Invalid cookie to delete');
      }
      const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      const path = cookie.path || '/';
      const candidateUrls = [`https://${host}${path}`, `http://${host}${path}`];

      let removed = false;
      for (const url of candidateUrls) {
        try {
          const details = { url, name: cookie.name };
          if (cookie.storeId) details.storeId = cookie.storeId;
          if (cookie.partitionKey && typeof cookie.partitionKey === 'object' && cookie.partitionKey.topLevelSite) {
            details.partitionKey = { topLevelSite: cookie.partitionKey.topLevelSite };
          }
          const res = await chrome.cookies.remove(details);
          if (res) {
            removed = true;
            break;
          }
        } catch {}
      }
      return { ok: removed, name: cookie.name };
    }

    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
}

/**
 * Accurately match all cookies belonging to a domain and its subdomains.
 */
function matchesDomain(cookieDomain, targetDomain) {
  if (!cookieDomain || !targetDomain) return false;
  const cd = String(cookieDomain).replace(/^\./, '').toLowerCase().trim();
  const td = String(targetDomain).replace(/^\./, '').toLowerCase().trim();
  const rootTd = td.split('.').slice(-2).join('.');
  const rootCd = cd.split('.').slice(-2).join('.');

  return (
    cd === td ||
    cd === rootTd ||
    rootCd === rootTd ||
    cd.endsWith('.' + td) ||
    cd.endsWith('.' + rootTd) ||
    td.endsWith('.' + cd)
  );
}

/**
 * Remove all cookies matching a domain with fallback URLs and partitionKey handling.
 */
async function removeDomainCookies(domain, reloadTabs = true) {
  if (!domain) return [];
  const allCookies = await chrome.cookies.getAll({});
  const dClean = String(domain).replace(/^\./, '').toLowerCase().trim();
  const rootDomain = dClean.split('.').slice(-2).join('.');

  const matching = allCookies.filter((c) => matchesDomain(c.domain, dClean));
  const removed = [];

  for (const c of matching) {
    const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    const path = c.path || '/';

    let partitionKey = undefined;
    if (c.partitionKey && typeof c.partitionKey === 'object' && c.partitionKey.topLevelSite) {
      partitionKey = { topLevelSite: c.partitionKey.topLevelSite };
    }

    const candidateUrls = [
      `https://${host}${path}`,
      `http://${host}${path}`,
      `https://${dClean}${path}`,
      `https://${rootDomain}${path}`,
    ];

    let success = false;
    for (const url of candidateUrls) {
      try {
        const details = { url, name: c.name };
        if (c.storeId) details.storeId = c.storeId;
        if (partitionKey) details.partitionKey = partitionKey;
        const res = await chrome.cookies.remove(details);
        if (res) {
          success = true;
          break;
        }
      } catch (e) {}
    }

    if (success) {
      removed.push(c.name);
    }
  }

  // Clear localStorage, sessionStorage & IndexedDB on open tabs of this domain, and reload
  if (reloadTabs) {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url) continue;
        try {
          const tabHost = new URL(tab.url).hostname.toLowerCase();
          if (matchesDomain(tabHost, dClean)) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (hostName) => {
                try { localStorage.clear(); } catch {}
                try { sessionStorage.clear(); } catch {}
                try {
                  if (window.indexedDB && indexedDB.databases) {
                    indexedDB.databases().then((dbs) => {
                      for (const db of dbs) {
                        if (db.name) try { indexedDB.deleteDatabase(db.name); } catch {}
                      }
                    }).catch(() => {});
                  }
                } catch {}
              },
              args: [dClean],
            }).catch(() => {});
            // Reload tab to establish fresh logged-out state
            chrome.tabs.reload(tab.id);
          }
        } catch {}
      }
    } catch {}
  }

  return removed;
}

/**
 * Remove local storage snapshots and swap backups related to a domain.
 */
async function removeDomainLocalStorage(domain) {
  if (!domain) return [];
  const dClean = String(domain).replace(/^\./, '').toLowerCase().trim();
  const rootDomain = dClean.split('.').slice(-2).join('.');

  // Remove from persistent swap store
  await removeSwapRecord(rootDomain);
  await removeSwapRecord(dClean);

  const allStorage = await chrome.storage.local.get(null);
  const keysToRemove = [];
  for (const key of Object.keys(allStorage || {})) {
    if (
      key === `swap_backup_${rootDomain}` ||
      key === `swap_backup_${dClean}` ||
      key === `snap_${rootDomain}` ||
      key === `snap_${dClean}` ||
      (key.startsWith('swap_backup_') && (key.includes(dClean) || key.includes(rootDomain))) ||
      (key.startsWith('snap_') && (key.includes(dClean) || key.includes(rootDomain)))
    ) {
      keysToRemove.push(key);
    }
  }
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
  return keysToRemove;
}

// ============================================================================
// REAL-TIME OPTIMAL COOKIE CHANGE WATCHER & DB AUTO-SYNC
// Debounces changes per root domain to avoid excessive API requests.
// Automatically:
//  1. Detects website logouts (auth cookies cleared) -> Deletes session from DB.
//  2. Detects website logins/updates (valid auth cookies) -> Updates DB with fresh session.
// ============================================================================
const COOKIE_SYNC_DEBOUNCE_MS = 2500;
const pendingDomainSyncs = new Map();
const lastSyncedSignatures = new Map(); // domain -> signature of auth cookies

function computeCookiesSignature(cookies) {
  if (!cookies || !cookies.length) return '';
  return cookies
    .map((c) => `${c.name}=${c.value};${c.domain};${c.path}`)
    .sort()
    .join('|');
}

function getRootDomainFromCookie(cookie) {
  if (!cookie || !cookie.domain) return null;
  const d = String(cookie.domain).replace(/^\./, '').toLowerCase().trim();
  if (!d || isLocalhost(d) || isSearchEngine(d)) return null;
  const parts = d.split('.');
  if (parts.length > 2) {
    return parts.slice(-2).join('.');
  }
  return d;
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  const rootDomain = getRootDomainFromCookie(changeInfo.cookie);
  if (!rootDomain) return;

  // Clear any existing timer for this domain
  if (pendingDomainSyncs.has(rootDomain)) {
    clearTimeout(pendingDomainSyncs.get(rootDomain));
  }

  // Set debounced sync
  const timer = setTimeout(async () => {
    pendingDomainSyncs.delete(rootDomain);
    try {
      // 1. Consent and authentication check
      if (!(await isConsented())) return;
      const authStatus = await getAuthStatus();
      if (!authStatus.loggedIn) return;
      const accessToken = await getValidAccessToken();
      if (!accessToken) return;

      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      const baseServer = serverUrl || 'http://localhost:8080';
      const currentDeviceId = await getOrCreateDeviceId();

      // 2. If domain is actively swapped, do not clobber with automatic sync
      if (await isDomainSwapped(rootDomain)) return;

      // 3. Inspect all current cookies for this domain
      const currentCookies = await chrome.cookies.getAll({ domain: rootDomain });
      const authCookies = (currentCookies || []).filter((c) => isAuthToken(c.name, c.value));

      // CASE A: USER LOGGED OUT OF THE WEBSITE
      // (No auth cookies remaining for this domain)
      if (authCookies.length === 0) {
        lastSyncedSignatures.delete(rootDomain);
        // Automatically delete the stale session for this device from DB
        await deleteDomainSessionFromServer(baseServer, accessToken, rootDomain, currentDeviceId);
        log(`Detected logout on ${rootDomain} — removed session from cloud DB.`);
        return;
      }

      // CASE B: USER LOGGED IN OR COOKIES UPDATED
      const newSignature = computeCookiesSignature(authCookies);
      const prevSignature = lastSyncedSignatures.get(rootDomain);

      if (newSignature === prevSignature) {
        // No meaningful auth change; skip network call
        return;
      }

      lastSyncedSignatures.set(rootDomain, newSignature);
      await pushDomainSession(baseServer, accessToken, rootDomain, currentCookies);
      log(`Auto-synced updated session for ${rootDomain} to cloud DB.`);
    } catch (err) {
      warn(`Auto-sync error for ${rootDomain}:`, err);
    }
  }, COOKIE_SYNC_DEBOUNCE_MS);

  pendingDomainSyncs.set(rootDomain, timer);
});

// MV3 service worker — message router.
// Runs up to ~30s idle / 5min max, so no long-lived work here.
//
// PRIVACY CONTRACT
// ----------------
// Nothing is uploaded automatically. Login/registration only registers the
// device. Session uploads happen when the user explicitly saves or syncs a
// site, or when they have separately enabled opt-in auto-sync for sites they
// granted. The cookie watcher is inert by default.

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
  grantedHosts,
  grantSite,
  revokeSite,
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
  getServerUrl,
  setServerUrl,
  deleteAccount,
  exportUserData,
  isAuthToken,
} from './lib/auth.js';
import { applyCookies } from './lib/cookies.js';
import {
  isLocalhost,
  registerDevice,
  fetchUserDevices,
  revokeDevice,
  adoptDevice,
  getOrCreateDeviceId,
  getOrCreateSystemId,
  detectDeviceEnvironment,
  fetchRemoteSessions,
  pushDomainSession,
  pushBatchDomainSessions,
  deleteDomainSessionFromServer,
} from './lib/device.js';
import { getRegistrableDomain, hostMatches, normalizeHost } from './lib/domain.js';
import {
  saveSwapRecord,
  getSwapRecord,
  removeSwapRecord,
  getActiveSwapsCollection,
  isDomainSwapped,
} from './lib/swap-store.js';

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

const AUTO_SYNC_KEY = 'autoSyncEnabled';

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
      const isRateLimited =
        e?.code === 'rate_limited' ||
        errMsg.includes('rate_limited') ||
        errMsg.includes('Too many requests');
      sendResponse({
        ok: false,
        error: errMsg,
        code: isRateLimited ? 'rate_limited' : e?.code,
        retryAfterSeconds: e?.retryAfterSeconds || (isRateLimited ? 60 : undefined),
      });
    });
  return true;
});

/** Does the vault key exist for this browser session? */
async function vaultUnlocked() {
  const { vaultKeyRaw } = await chrome.storage.session.get('vaultKeyRaw');
  return Array.isArray(vaultKeyRaw) && vaultKeyRaw.length === 32;
}

/** Returns { serverUrl, accessToken } or null. Never uses a hidden fallback. */
async function authContext() {
  let accessToken = await getValidAccessToken();
  if (!accessToken) {
    const refreshed = await refreshSession().catch(() => null);
    accessToken = refreshed?.accessToken;
  }
  if (!accessToken) return null;
  const serverUrl = await getServerUrl();
  return { serverUrl, accessToken };
}

/**
 * Cheap presence check for the login detector. Uses /v1/sync/list (no payload
 * decryption) so a locked vault does not suppress the "you have a session"
 * prompt.
 */
async function remoteHasSession(host) {
  try {
    const ctx = await authContext();
    if (!ctx) return false;

    const res = await fetch(`${ctx.serverUrl}/v1/sync/list`, {
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
    });
    if (!res.ok) return false;
    const { items } = await res.json();
    return (items || []).some((i) => hostMatches(i.host, host));
  } catch {
    return false;
  }
}

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
      if (chrome.scripting && chrome.scripting.executeScript) {
        await chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            files: ['src/content/inspect-sync-animation.js'],
          })
          .catch(() => {});
        await chrome.tabs
          .sendMessage(tab.id, {
            type: 'PLAY_SYNC_INSPECT_ANIMATION',
            domain,
            cookies,
          })
          .catch(() => {});
      }
    }
  } catch (e) {
    console.debug('[switch] broadcastSyncAnimationToActiveTab error:', e);
  }
}

async function broadcastSwapKeyAnimation(
  tabId,
  domain,
  originDevice,
  targetDevice,
  isRollback = false,
) {
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
        await chrome.scripting
          .executeScript({
            target: { tabId },
            files: ['src/content/swap-animation.js'],
          })
          .catch(() => {});
        await chrome.tabs.sendMessage(tabId, payload).catch(() => {});
      }
    }
  } catch (e) {
    console.debug('[switch] broadcastSwapKeyAnimation error:', e);
  }
}

/**
 * Upload the given hosts only.
 *
 * `hosts` is required and must be a non-empty array. There is no "upload every
 * cookie in the browser" path; callers derive the list from an explicit user
 * action (granted sites or a single site).
 */
async function syncHosts(serverUrl, accessToken, hosts) {
  const wanted = new Set(
    (hosts || []).map((h) => normalizeHost(h)).filter(Boolean),
  );
  if (!wanted.size) {
    return { ok: true, syncedCount: 0, totalCookiesCount: 0, conflicts: [] };
  }

  const allCookies = await chrome.cookies.getAll({});
  const byHost = new Map();
  for (const c of allCookies || []) {
    const host = normalizeHost(c.domain);
    if (!host || isLocalhost(host) || !wanted.has(host)) continue;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(c);
  }

  // Use the server's current version so a deliberate re-save supersedes the
  // previous copy instead of being reported as a spurious conflict.
  const versions = await currentVersions(serverUrl, accessToken);

  const domainList = [...byHost.entries()].map(([host, cookies]) => ({
    host,
    cookies,
    baseVersion: versions.get(host) ?? 0,
  }));

  const res = await pushBatchDomainSessions(serverUrl, accessToken, domainList);

  return {
    ok: true,
    syncedCount: res.syncedCount,
    totalCookiesCount: allCookies.length,
    conflicts: res.conflicts || [],
    hosts: domainList.map((d) => d.host),
  };
}

/** host -> version for all of this user's non-deleted sessions. */
async function currentVersions(serverUrl, accessToken) {
  const map = new Map();
  try {
    const res = await fetch(`${serverUrl}/v1/sync/list`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return map;
    const data = await res.json();
    for (const item of data.items || []) {
      map.set(normalizeHost(item.host), item.version);
    }
  } catch {
    // Offline: baseVersion 0 will conflict against any existing copy, which is
    // the safe outcome for a sync we cannot verify.
  }
  return map;
}

async function handle(msg, sender) {
  switch (msg.type) {
    case 'CAPTURE': {
      if (!(await isConsented())) throw new Error('Consent is required before saving a session.');
      return { snapshot: await captureSite(msg.url, msg.tabId) };
    }

    case 'RESTORE':
      return { result: await restoreSite(msg.host, msg.tabId) };

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
      if (
        !tab?.url ||
        tab.url.startsWith('chrome://') ||
        tab.url.startsWith('edge://') ||
        tab.url.startsWith('about:') ||
        tab.url.startsWith('chrome-extension://')
      ) {
        return { ok: false, reason: 'internal_page' };
      }

      let host = '';
      try {
        host = normalizeHost(new URL(tab.url).hostname);
      } catch {
        return { ok: false, reason: 'invalid_url' };
      }
      if (isLocalhost(host)) return { ok: false, reason: 'ignored_host' };

      let pageState = msg.pageState || { hasLoginForm: false, looksLoggedIn: false };
      if (!msg.pageState && !sender?.tab) {
        try {
          const domState = await chrome.tabs.sendMessage(tab.id, {
            type: 'DETECT_PAGE_STATE',
          });
          if (domState) pageState = domState;
        } catch {}
      }

      const allCookies = await chrome.cookies.getAll({});
      const hostCookies = allCookies.filter((c) =>
        hostMatches(c.domain, host),
      );

      const currentDeviceId = await getOrCreateDeviceId();
      const hasLocalAuth = hostCookies.some((c) => isAuthToken(c.name, c.value));
      const isUserAlreadyLoggedIn =
        !pageState.hasLoginForm &&
        (hasLocalAuth || pageState.looksLoggedIn || hostCookies.length > 5);

      let otherDeviceSession = null;
      if (await vaultUnlocked()) {
        const ctx = await authContext();
        if (ctx) {
          try {
            const sessions = await fetchRemoteSessions(ctx.serverUrl, ctx.accessToken);
            const match = sessions.find((s) => {
              if (!hostMatches(s.host, host)) return false;
              if (!Array.isArray(s.cookies) || s.cookies.length === 0) return false;
              if (s.deviceId && s.deviceId === currentDeviceId) return false;
              return s.cookies.some((c) => isAuthToken(c.name, c.value));
            });
            if (match) otherDeviceSession = match;
          } catch (e) {
            console.warn('[switch] remote session lookup failed:', e?.message || e);
          }
        }
      }

      const swapKey = getRegistrableDomain(host) || host;
      const swapRecord = await getSwapRecord(swapKey);
      const isSwapped = !!swapRecord;

      const backupSession = swapRecord
        ? {
            host: swapRecord.host || host,
            rootDomain: swapKey,
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
        isLocked: isSwapped,
      };
    }

    case 'SWAP_ACTIVE_TAB_SESSION': {
      const {
        host,
        currentCookies,
        remoteCookies,
        tabId,
        baseVersion,
        deviceName,
        targetDeviceId,
        isInjectOnly,
      } = msg;

      const cleanHost = normalizeHost(host);
      if (!cleanHost || isLocalhost(cleanHost)) {
        return { ok: false, error: 'Cannot swap sessions on localhost' };
      }

      const targetTabId = tabId || sender?.tab?.id;
      const swapKey = getRegistrableDomain(cleanHost) || cleanHost;

      const existingSwap = await getSwapRecord(swapKey);
      if (existingSwap) {
        return {
          ok: false,
          error: `This domain is currently swapped with "${
            existingSwap.target?.deviceName || 'another device'
          }". You must Rollback before swapping with another device or browser.`,
          isLocked: true,
          swapRecord: existingSwap,
        };
      }

      let cookiesToBackup = currentCookies;
      if (!Array.isArray(cookiesToBackup) || cookiesToBackup.length === 0) {
        const allCookies = await chrome.cookies.getAll({});
        cookiesToBackup = allCookies.filter((c) =>
          hostMatches(c.domain, cleanHost),
        );
      }

      const ctx = await authContext();
      let cookiesToApply = remoteCookies;
      let finalTargetDeviceId = targetDeviceId || '';
      let finalTargetDeviceName = deviceName || 'Remote Device';

      if (
        (!Array.isArray(cookiesToApply) || cookiesToApply.length === 0 || !finalTargetDeviceId) &&
        ctx &&
        (await vaultUnlocked())
      ) {
        const sessions = await fetchRemoteSessions(ctx.serverUrl, ctx.accessToken).catch(
          () => [],
        );
        const currentDeviceId = await getOrCreateDeviceId();
        const match = sessions.find((s) => {
          return (
            hostMatches(s.host, cleanHost) &&
            s.deviceId &&
            s.deviceId !== currentDeviceId &&
            Array.isArray(s.cookies) &&
            s.cookies.length > 0
          );
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

      let swapRecord = null;
      if (
        !isInjectOnly &&
        Array.isArray(cookiesToBackup) &&
        cookiesToBackup.length > 0
      ) {
        swapRecord = await saveSwapRecord({
          host: cleanHost,
          currentCookies: cookiesToBackup,
          remoteCookies: cookiesToApply || [],
          targetDeviceId: finalTargetDeviceId,
          targetDeviceName: finalTargetDeviceName,
        });
      }

      // Push the outgoing session only when the user has granted this site and
      // the vault is unlocked. A swap is an explicit action, so this is allowed
      // — but it is never a background upload.
      const hasAuthTokensToPush =
        Array.isArray(cookiesToBackup) &&
        cookiesToBackup.some((c) => isAuthToken(c.name, c.value));
      if (!isInjectOnly && ctx && hasAuthTokensToPush && (await vaultUnlocked())) {
        await pushDomainSession(
          ctx.serverUrl,
          ctx.accessToken,
          cleanHost,
          cookiesToBackup,
          baseVersion || 0,
        ).catch((e) => console.warn('[switch] swap push failed:', e?.message || e));
      }

      const swapAnimPromise = broadcastSwapKeyAnimation(
        targetTabId,
        cleanHost,
        'Local Browser',
        finalTargetDeviceName,
        false,
      );

      if (Array.isArray(cookiesToApply) && cookiesToApply.length > 0) {
        await removeDomainCookies(swapKey, false);
        if (targetTabId && chrome.scripting && chrome.scripting.executeScript) {
          await chrome.scripting
            .executeScript({
              target: { tabId: targetTabId },
              func: () => {
                try {
                  localStorage.clear();
                } catch {}
                try {
                  sessionStorage.clear();
                } catch {}
              },
            })
            .catch(() => {});
        }
        await applyCookies(cookiesToApply);
      }

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
      const cleanHost = normalizeHost(host);
      const swapKey = getRegistrableDomain(cleanHost) || cleanHost;

      const swapRecord = await getSwapRecord(swapKey);
      const originalCookies =
        swapRecord?.origin?.cookies || swapRecord?.originalCookies;

      if (!swapRecord || !Array.isArray(originalCookies) || originalCookies.length === 0) {
        throw new Error(
          'No active swap record or original cookies found to rollback for this domain',
        );
      }

      const restoreAnimPromise = broadcastSwapKeyAnimation(
        targetTabId,
        cleanHost,
        swapRecord?.target?.deviceName || 'Remote Device',
        swapRecord?.origin?.deviceName || 'Original Session',
        true,
      );

      await removeDomainCookies(swapKey, false);
      if (targetTabId && chrome.scripting && chrome.scripting.executeScript) {
        await chrome.scripting
          .executeScript({
            target: { tabId: targetTabId },
            func: () => {
              try {
                localStorage.clear();
              } catch {}
              try {
                sessionStorage.clear();
              } catch {}
            },
          })
          .catch(() => {});
      }

      await applyCookies(originalCookies);
      await removeSwapRecord(swapKey);

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
        removedRecord: swapKey,
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
      // Local delete only. Cloud deletion is a separate explicit action.
      await deleteSaved(msg.host);
      return {};

    case 'GET_SNAPSHOT':
      return { snapshot: await getSnapshot(msg.host) };

    case 'EXPORT': {
      const snapshots = [];
      for (const host of msg.hosts || []) {
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
      // Register the device only. Uploading sessions now would be an
      // undisclosed background upload; the user syncs a site explicitly.
      try {
        await registerDevice(await getServerUrl(), auth.accessToken);
      } catch (e) {
        console.warn('[switch] device registration after login:', e?.message || e);
      }
      return auth;
    }

    case 'AUTH_REGISTER': {
      const auth = await register(msg.email, msg.password, msg.serverUrl, {
        verificationToken: msg.verificationToken,
        otp: msg.otp,
      });
      try {
        await registerDevice(await getServerUrl(), auth.accessToken);
      } catch (e) {
        console.warn('[switch] device registration after register:', e?.message || e);
      }
      return auth;
    }

    case 'AUTH_FORGOT_PASSWORD':
      return await forgotPassword(msg.email, msg.serverUrl);

    case 'AUTH_RESET_PASSWORD': {
      const auth = await resetPassword(msg.email, msg.newPassword, msg.serverUrl, {
        verificationToken: msg.verificationToken,
        otp: msg.otp,
      });
      try {
        await registerDevice(await getServerUrl(), auth.accessToken);
      } catch (e) {
        console.warn('[switch] device registration after reset:', e?.message || e);
      }
      return auth;
    }

    case 'AUTH_LOGOUT': {
      await logout();
      return { ok: true };
    }

    case 'AUTH_REFRESH':
      return await refreshSession();

    case 'AUTH_SET_SERVER':
      return { serverUrl: await setServerUrl(msg.serverUrl) };

    case 'SETTINGS_GET': {
      const { [AUTO_SYNC_KEY]: autoSync = false, detectEnabled = true } =
        await chrome.storage.local.get([AUTO_SYNC_KEY, 'detectEnabled']);
      return {
        autoSync: !!autoSync,
        detectEnabled: detectEnabled !== false,
        serverUrl: await getServerUrl(),
        grantedHosts: await grantedHosts(),
      };
    }

    case 'SETTINGS_SET': {
      const updates = {};
      if (msg.autoSync !== undefined) updates[AUTO_SYNC_KEY] = !!msg.autoSync;
      if (msg.detectEnabled !== undefined) {
        updates.detectEnabled = !!msg.detectEnabled;
        await setDetectEnabled(!!msg.detectEnabled);
      }
      if (Object.keys(updates).length) {
        await chrome.storage.local.set(updates);
      }
      return {
        autoSync: !!updates[AUTO_SYNC_KEY],
        detectEnabled: updates.detectEnabled !== false,
      };
    }

    case 'ACCOUNT_EXPORT':
      return { data: await exportUserData() };

    case 'ACCOUNT_DELETE': {
      if (msg.confirm !== true) {
        throw new Error('Account deletion requires explicit confirmation.');
      }
      await deleteAccount();
      return { ok: true };
    }

    case 'DEVICE_GET_CURRENT': {
      const deviceId = await getOrCreateDeviceId();
      const systemId = await getOrCreateSystemId();
      const { name, browserInfo } = detectDeviceEnvironment();
      return { deviceId, systemId, name, browserInfo };
    }

    case 'DEVICE_REGISTER': {
      const accessToken = await getValidAccessToken();
      if (!accessToken) return { ok: false, error: 'Not authenticated' };
      const serverUrl = await getServerUrl();
      try {
        const info = await registerDevice(serverUrl, accessToken);
        return { ok: true, ...info };
      } catch (err) {
        if (String(err?.message || '').includes('401')) {
          const refreshed = await refreshSession().catch(() => null);
          if (refreshed?.accessToken) {
            const info = await registerDevice(serverUrl, refreshed.accessToken);
            return { ok: true, ...info };
          }
        }
        throw err;
      }
    }

    case 'DEVICE_LIST': {
      const accessToken = await getValidAccessToken();
      if (!accessToken) return { items: [] };
      const serverUrl = await getServerUrl();
      try {
        const items = await fetchUserDevices(serverUrl, accessToken);
        return { items };
      } catch (err) {
        if (String(err?.message || '').includes('401')) {
          const refreshed = await refreshSession().catch(() => null);
          if (refreshed?.accessToken) {
            const items = await fetchUserDevices(serverUrl, refreshed.accessToken);
            return { items };
          }
        }
        return { items: [] };
      }
    }

    case 'DEVICE_REVOKE': {
      const accessToken = await getValidAccessToken();
      if (!accessToken) return { ok: false, error: 'Not authenticated' };
      const serverUrl = await getServerUrl();
      try {
        return await revokeDevice(serverUrl, accessToken, msg.deviceId);
      } catch (err) {
        if (String(err?.message || '').includes('401')) {
          const refreshed = await refreshSession().catch(() => null);
          if (refreshed?.accessToken) {
            return await revokeDevice(serverUrl, refreshed.accessToken, msg.deviceId);
          }
        }
        throw err;
      }
    }

    case 'DEVICE_ADOPT': {
      const accessToken = await getValidAccessToken();
      if (!accessToken) return { ok: false, error: 'Not authenticated' };
      if (typeof msg.deviceId !== 'string' || !msg.deviceId) {
        return { ok: false, error: 'deviceId is required' };
      }
      const serverUrl = await getServerUrl();
      try {
        return await adoptDevice(serverUrl, accessToken, msg.deviceId);
      } catch (err) {
        if (err?.status === 401 || String(err?.message || '').includes('401')) {
          const refreshed = await refreshSession().catch(() => null);
          if (refreshed?.accessToken) {
            return await adoptDevice(serverUrl, refreshed.accessToken, msg.deviceId);
          }
        }
        throw err;
      }
    }

    case 'SYNC_PULL_SESSIONS': {
      const ctx = await authContext();
      if (!ctx) return { sessions: [] };
      try {
        const sessions = await fetchRemoteSessions(ctx.serverUrl, ctx.accessToken);
        return { sessions };
      } catch (err) {
        if (err?.code === 'vault_locked') {
          return { sessions: [], vaultLocked: true };
        }
        return { sessions: [] };
      }
    }

    case 'SYNC_PUSH_DOMAIN': {
      const ctx = await authContext();
      if (!ctx) throw new Error('Not authenticated');
      if (!(await isConsented())) {
        throw new Error('Consent is required before syncing sessions.');
      }
      if (!(await vaultUnlocked())) {
        throw new Error('Vault is locked. Unlock with your master password first.');
      }
      const result = await pushDomainSession(
        ctx.serverUrl,
        ctx.accessToken,
        msg.host,
        msg.cookies,
        msg.baseVersion || 0,
      );
      // An explicit per-site save is what makes the site "granted" for future
      // restore prompts and opt-in auto-sync.
      await grantSite(msg.host);
      return result;
    }

    case 'SYNC_PUSH_ALL': {
      // Explicit action only. One click, one upload of the sites the user has
      // granted — never a hidden background sweep of every cookie.
      if (msg.explicit !== true) {
        throw new Error('Explicit confirmation is required to upload sessions.');
      }
      if (!(await isConsented())) {
        throw new Error('Consent is required before syncing sessions.');
      }
      if (!(await vaultUnlocked())) {
        throw new Error('Vault is locked. Unlock with your master password first.');
      }
      const ctx = await authContext();
      if (!ctx) throw new Error('Not authenticated');

      const hosts = msg.hosts?.length
        ? msg.hosts
        : await grantedHosts();

      const result = await syncHosts(ctx.serverUrl, ctx.accessToken, hosts);

      return {
        ok: true,
        syncedDomainsCount: result.syncedCount || 0,
        totalCookiesCount: result.totalCookiesCount || 0,
        conflicts: result.conflicts || [],
        hosts: result.hosts || [],
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
        const filtered = (cookies || []).filter((c) => !isLocalhost(c.domain));
        return { cookies: filtered };
      } catch (e) {
        return { cookies: [], error: String(e?.message || e) };
      }
    }

    case 'DELETE_DOMAIN_SESSION': {
      const { host, deleteServer = false } = msg;
      if (!host) throw new Error('Host required');
      const cleanHost = normalizeHost(host);

      // 1. Remove cookies for this exact site.
      const cookiesRemoved = await removeDomainCookies(cleanHost);

      // 2. Remove local snapshots and swap backups for this site.
      const storageKeysRemoved = await removeDomainLocalStorage(cleanHost);

      // 3. Tombstone this exact host in the cloud, only when explicitly asked.
      let serverDeleted = false;
      if (deleteServer) {
        try {
          const ctx = await authContext();
          if (ctx) {
            serverDeleted = await deleteDomainSessionFromServer(
              ctx.serverUrl,
              ctx.accessToken,
              cleanHost,
            );
          }
          await revokeSite(cleanHost);
        } catch (e) {
          console.warn('[switch] server session deletion error:', e?.message || e);
        }
      }

      return {
        ok: true,
        host: cleanHost,
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
      const host = normalizeHost(cookie.domain);
      const path = cookie.path || '/';
      const candidateUrls = [`https://${host}${path}`, `http://${host}${path}`];

      let removed = false;
      for (const url of candidateUrls) {
        try {
          const details = { url, name: cookie.name };
          if (cookie.storeId) details.storeId = cookie.storeId;
          if (
            cookie.partitionKey &&
            typeof cookie.partitionKey === 'object' &&
            cookie.partitionKey.topLevelSite
          ) {
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

function matchesDomain(cookieDomain, targetDomain) {
  return hostMatches(cookieDomain, targetDomain);
}

async function removeDomainCookies(domain, reloadTabs = true) {
  if (!domain) return [];
  const allCookies = await chrome.cookies.getAll({});
  const dClean = normalizeHost(domain);
  if (!dClean) return [];

  const matching = allCookies.filter((c) => matchesDomain(c.domain, dClean));
  const removed = [];

  for (const c of matching) {
    const host = normalizeHost(c.domain);
    const path = c.path || '/';

    let partitionKey;
    if (
      c.partitionKey &&
      typeof c.partitionKey === 'object' &&
      c.partitionKey.topLevelSite
    ) {
      partitionKey = { topLevelSite: c.partitionKey.topLevelSite };
    }

    const candidateUrls = [
      `https://${host}${path}`,
      `http://${host}${path}`,
      `https://${dClean}${path}`,
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
      } catch {}
    }

    if (success) removed.push(c.name);
  }

  if (reloadTabs) {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url) continue;
        try {
          const tabHost = normalizeHost(new URL(tab.url).hostname);
          if (hostMatches(tabHost, dClean)) {
            await chrome.scripting
              .executeScript({
                target: { tabId: tab.id },
                func: () => {
                  try {
                    localStorage.clear();
                  } catch {}
                  try {
                    sessionStorage.clear();
                  } catch {}
                  try {
                    if (window.indexedDB && indexedDB.databases) {
                      indexedDB
                        .databases()
                        .then((dbs) => {
                          for (const db of dbs) {
                            if (db.name) {
                              try {
                                indexedDB.deleteDatabase(db.name);
                              } catch {}
                            }
                          }
                        })
                        .catch(() => {});
                    }
                  } catch {}
                },
              })
              .catch(() => {});
            chrome.tabs.reload(tab.id);
          }
        } catch {}
      }
    } catch {}
  }

  return removed;
}

async function removeDomainLocalStorage(domain) {
  if (!domain) return [];
  const dClean = normalizeHost(domain);
  const swapKey = getRegistrableDomain(dClean) || dClean;

  await removeSwapRecord(swapKey);
  await removeSwapRecord(dClean);

  const allStorage = await chrome.storage.local.get(null);
  const keysToRemove = [];
  for (const key of Object.keys(allStorage || {})) {
    if (
      key === `snap:${dClean}` ||
      key === `snap:${swapKey}` ||
      key === `switch:pending:${dClean}` ||
      key === `switch:pending:${swapKey}` ||
      key === `attempt:${dClean}` ||
      key === `rejected:${dClean}` ||
      key === `never:${dClean}`
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
// OPT-IN COOKIE WATCHER
//
// Inert unless the user has explicitly enabled auto-sync AND granted the site.
// It only ever touches the exact cookie host; it never uploads a site the user
// has not opened/saved.
// ============================================================================
const COOKIE_SYNC_DEBOUNCE_MS = 2500;
const pendingDomainSyncs = new Map();
const lastSyncedSignatures = new Map();

function computeCookiesSignature(cookies) {
  if (!cookies || !cookies.length) return '';
  return cookies
    .map((c) => `${c.name}=${c.value};${c.domain};${c.path}`)
    .sort()
    .join('|');
}

function cookieHost(cookie) {
  if (!cookie || !cookie.domain) return null;
  const d = normalizeHost(cookie.domain);
  if (!d || isLocalhost(d)) return null;
  return d;
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo?.removed) {
    // Removals are part of normal browsing; only handle value writes/updates.
  }

  const host = cookieHost(changeInfo.cookie);
  if (!host) return;

  if (pendingDomainSyncs.has(host)) clearTimeout(pendingDomainSyncs.get(host));

  const timer = setTimeout(async () => {
    pendingDomainSyncs.delete(host);
    try {
      if (!(await isConsented())) return;

      const { [AUTO_SYNC_KEY]: autoSync } = await chrome.storage.local.get(AUTO_SYNC_KEY);
      if (autoSync !== true) return; // opt-in only

      const granted = await grantedHosts();
      if (!granted.some((g) => hostMatches(g, host))) return;

      const ctx = await authContext();
      if (!ctx) return;
      if (!(await vaultUnlocked())) return;

      if (await isDomainSwapped(getRegistrableDomain(host) || host)) return;

      const currentCookies = await chrome.cookies.getAll({ domain: host });
      const authCookies = (currentCookies || []).filter((c) =>
        isAuthToken(c.name, c.value),
      );

      if (authCookies.length === 0) {
        lastSyncedSignatures.delete(host);
        await deleteDomainSessionFromServer(
          ctx.serverUrl,
          ctx.accessToken,
          host,
          await getOrCreateDeviceId(),
        );
        log(`Detected logout on ${host} — tombstoned this device's copy.`);
        return;
      }

      const signature = computeCookiesSignature(authCookies);
      if (signature === lastSyncedSignatures.get(host)) return;

      const versions = await currentVersions(ctx.serverUrl, ctx.accessToken);
      await pushDomainSession(
        ctx.serverUrl,
        ctx.accessToken,
        host,
        currentCookies,
        versions.get(host) ?? 0,
      );
      lastSyncedSignatures.set(host, signature);
      log(`Auto-synced updated session for ${host}.`);
    } catch (err) {
      warn(`Auto-sync error for ${host}:`, err);
    }
  }, COOKIE_SYNC_DEBOUNCE_MS);

  pendingDomainSyncs.set(host, timer);
});

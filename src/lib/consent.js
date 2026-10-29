// Consent state.
//
// Disclosure Requirements #2 requires "affirmative and informed consent" BEFORE
// user data is handled. This module records that consent in a versioned,
// auditable form so we can prove what the user was shown and when.
//
// BUMP CONSENT_VERSION whenever the disclosure wording changes materially.
// Existing users get re-prompted; the old record stays in `consentHistory`
// so you can show a user exactly which version they accepted and when.
//
// The scope is intentionally narrow and truthful:
//   - cookies, localStorage and the tokens inside them, for sites the user
//     explicitly saves;
//   - manual upload only. There is no automatic "sync everything" default.
//   - opt-in auto-sync is a separate setting the user can turn off.

export const CONSENT_VERSION = '2026-10-28';

// Message-protocol version. Bump whenever the message contract between the
// popup and the background worker changes.
export const PROTOCOL = 3;

// The exact data types acknowledged. Kept in the record so consent is scoped
// to specific practices, not a blanket "I agree".
export const DATA_TYPES = ['cookies', 'localStorage', 'sessionTokens'];

// Manual by default. The popup may offer opt-in per-site auto-sync later, but
// it is never implied by accepting this consent.
export const SYNC_MODE = 'manual';

const CONSENT_KEY = 'consent';
const HISTORY_KEY = 'consentHistory';

const CH = chrome;

/** Returns the current consent record, or null if not consented. */
export async function getConsent() {
  const { [CONSENT_KEY]: consent } = await CH.storage.local.get(CONSENT_KEY);
  return consent || null;
}

export async function isConsented() {
  const consent = await getConsent();
  return !!consent && consent.version === CONSENT_VERSION;
}

/** True when consent exists but predates the current disclosure wording. */
export async function isStaleConsent() {
  const consent = await getConsent();
  return !!consent && consent.version !== CONSENT_VERSION;
}

/**
 * Record affirmative consent. Stores both the current record and an append-only
 * history entry (capped) for auditability.
 */
export async function giveConsent() {
  const consent = {
    version: CONSENT_VERSION,
    at: Date.now(),
    dataTypes: DATA_TYPES,
    scope: 'per-origin', // we never request <all_urls> at install
    syncMode: SYNC_MODE,
  };
  await CH.storage.local.set({ [CONSENT_KEY]: consent });

  const { [HISTORY_KEY]: history = [] } = await CH.storage.local.get(HISTORY_KEY);
  history.push(consent);
  await CH.storage.local.set({ [HISTORY_KEY]: history.slice(-10) });

  return consent;
}

/** Withdraw consent. Also drops every saved snapshot — no data without consent. */
export async function withdrawConsent({ wipeData = true } = {}) {
  const all = await CH.storage.local.get(null);

  const removals = [CONSENT_KEY, 'autoSyncEnabled'];
  if (wipeData) {
    for (const key of Object.keys(all)) {
      if (
        key.startsWith('snap:') ||
        key.startsWith('switch:pending:') ||
        key.startsWith('attempt:') ||
        key.startsWith('rejected:') ||
        key.startsWith('never:') ||
        key.startsWith('swap_backup_') ||
        key === 'switch:granted' ||
        key === 'activeSwaps' ||
        key === 'active_swaps'
      ) {
        removals.push(key);
      }
    }
  }
  await CH.storage.local.remove(removals);

  if (wipeData) {
    try {
      const origins = (await CH.permissions.getAll()).origins || [];
      if (origins.length) await CH.permissions.remove({ origins });
    } catch (e) {
      console.warn('[switch] could not revoke host permissions', e);
    }

    // Drop dynamically registered content scripts too; otherwise a stale
    // detector keeps running on a site the user just withdrew from.
    try {
      const scripts = await CH.scripting.getRegisteredContentScripts();
      const ids = (scripts || [])
        .map((s) => s.id)
        .filter((id) => id.startsWith('switch-'));
      if (ids.length) await CH.scripting.unregisterContentScripts({ ids });
    } catch {
      // Older browsers may not support listing; ignore.
    }
  }
}

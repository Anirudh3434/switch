// Consent state.
//
// Disclosure Requirements #2 requires "affirmative and informed consent" BEFORE
// user data is handled. This module records that consent in a versioned,
// auditable form so we can prove what the user was shown and when.
//
// BUMP CONSENT_VERSION whenever the disclosure wording changes materially.
// Existing users get re-prompted; the old record stays in `consentHistory`
// so you can show a user exactly which version they accepted and when.

export const CONSENT_VERSION = '2026-10-01';

// Message-protocol version. Bump whenever the message contract between the
// popup and the background worker changes.
//
// Why this exists: Chrome only re-registers an unpacked extension's service
// worker when you hit "Reload" in chrome://extensions. Extension *pages* are
// re-read from disk every time they open. So after an update you can easily end
// up with a new popup talking to an old worker, where every message silently
// fails. The popup pings the worker and compares this number; a mismatch is
// surfaced as "reload the extension" instead of a dead button.
export const PROTOCOL = 2;

// The exact data types acknowledged. Kept in the record so consent is scoped
// to specific practices, not a blanket "I agree".
export const DATA_TYPES = ['cookies', 'localStorage', 'sessionTokens'];

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

  const removals = [CONSENT_KEY];
  if (wipeData) {
    // Saved sessions were captured under a consent that no longer applies.
    for (const key of Object.keys(all)) {
      if (
        key.startsWith('snap:') ||
        key.startsWith('switch:pending:') ||
        key.startsWith('attempt:') ||
        key.startsWith('rejected:') ||
        key === 'switch:granted'
      ) {
        removals.push(key);
      }
    }
  }
  await CH.storage.local.remove(removals);

  if (wipeData) {
    // Best-effort: revoke the browser-level host permissions too.
    try {
      const origins = (await CH.permissions.getAll()).origins || [];
      if (origins.length) await CH.permissions.remove({ origins });
    } catch (e) {
      console.warn('[switch] could not revoke host permissions', e);
    }
  }
}

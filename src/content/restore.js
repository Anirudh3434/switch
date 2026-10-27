// Runs at document_start in granted origins, BEFORE any page script.
// Applies a queued localStorage snapshot (if the background queued one).
//
// RACE NOTE: chrome.storage.local.get is async, so a fast page could boot
// first. That is why restoreSite() does a follow-up tabs.reload() — by the
// second load, localStorage is already populated natively and the page reads
// correct state on its very first tick.
(async () => {
  try {
    const host = location.hostname;
    const key = `switch:pending:${host}`;
    const rec = (await chrome.storage.local.get(key))[key];
    if (!rec) return;

    for (const [k, v] of Object.entries(rec.storage || {})) {
      // Never clobber something the page already set on this load.
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }

    await chrome.storage.local.remove(key);
    console.info(
      `[switch] restored ${Object.keys(rec.storage || {}).length} localStorage keys on ${host}`,
    );
  } catch (e) {
    console.warn('[switch] restore failed', e);
  }
})();

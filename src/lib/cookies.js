// Cookie capture + restore.
//
// The whole product lives or dies here. The gotchas below are the reason
// naive "copy the cookies" implementations silently fail:
//
//   - `domain: ".example.com"` (leading dot) is a DOMAIN cookie.
//     `domain: "example.com"` (no dot) is HOST-ONLY. If you always pass
//     `domain` to cookies.set(), host-only cookies become domain cookies and
//     some sites reject them. So: pass `domain` ONLY when it starts with ".".
//   - `__Host-` cookies MUST be Secure, MUST have path "/", MUST be host-only.
//   - `__Secure-` cookies MUST be Secure.
//   - `SameSite=None` REQUIRES `Secure`, or the browser drops it silently.
//   - Firefox rejects `sameSite: "unspecified"` — map it to "lax".
//   - Partitioned (CHIPS) cookies are keyed by top-level site. Passing the
//     wrong partitionKey restores them into a bucket the site never reads.
//   - Session cookies (no expirationDate) must stay that way — forcing an
//     expiry changes how the server sees the session.

const CH = (typeof chrome !== 'undefined') ? chrome : browser;

const isFirefox = () =>
  typeof navigator !== 'undefined' &&
  navigator.userAgent.toLowerCase().includes('firefox');

/** Query cookies for a URL, including parent-domain cookies. */
async function cookiesForUrl(url, partitionKey) {
  try {
    return await CH.cookies.getAll(partitionKey ? { url, partitionKey } : { url });
  } catch {
    // Firefox throws on an unknown partitionKey option — degrade gracefully.
    return [];
  }
}

/**
 * Capture every cookie visible from `origin` (walking parent domains) plus
 * its partitioned variants. Returns a flat array of records.
 */
export async function captureCookies(origin) {
  const url = new URL(origin);
  const labels = url.hostname.split('.');
  const scheme = url.protocol.replace(':', '');
  const seen = new Set();
  const out = [];

  for (let i = 0; i < labels.length; i++) {
    const host = labels.slice(i).join('.');
    const candidate = `${scheme}://${host}/`;

    const sets = [await cookiesForUrl(candidate)];
    // Chrome 119+: partitionKey:{} returns partitioned + unpartitioned.
    sets.push(await cookiesForUrl(candidate, {}));

    for (const list of sets) {
      for (const c of list) {
        const key = `${c.name}|${c.domain}|${c.path}|${c.partitionKey ?? ''}|${c.firstPartyDomain ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate, // undefined === session cookie
          session: c.session,
          partitionKey: c.partitionKey,
          firstPartyDomain: c.firstPartyDomain,
          scheme, // remembered so restore can build a correct URL
        });
      }
    }
  }
  return out;
}

/** Build the `url` field cookies.set() requires. */
function buildUrl(cookie) {
  const host = (cookie.domain || '').replace(/^\./, '');
  const scheme = cookie.secure ? 'https' : cookie.scheme || 'https';
  let path = cookie.path || '/';
  if (!path.startsWith('/')) path = '/';
  if (cookie.name.startsWith('__Host-')) path = '/';
  return `${scheme}://${host}${path}`;
}

/**
 * Restore cookies. Returns { restored, failed: [{name, error}] }.
 * Call this BEFORE navigating to the site.
 */
export async function applyCookies(cookies) {
  let restored = 0;
  const failed = [];

  for (const c of cookies) {
    const details = {
      url: buildUrl(c),
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    };

    // Host-only cookies: omit `domain` entirely. Domain cookies: keep the dot.
    if (c.domain && c.domain.startsWith('.')) details.domain = c.domain;
    if (c.name.startsWith('__Host-')) {
      details.secure = true;
      details.path = '/';
      delete details.domain;
    }
    if (c.name.startsWith('__Secure-')) details.secure = true;

    // sameSite normalization.
    let ss = (c.sameSite || 'lax').toLowerCase();
    if (ss === 'unspecified') ss = 'lax'; // Firefox refuses "unspecified"
    if (ss === 'no_restriction') {
      ss = 'no_restriction';
      details.secure = true; // SameSite=None without Secure is discarded
    }
    details.sameSite = ss;

    // Preserve session-ness. Only pin an expiry if we actually have one.
    if (c.expirationDate && !c.session) {
      details.expirationDate = c.expirationDate;
    }

    if (c.partitionKey) {
      details.partitionKey =
        typeof c.partitionKey === 'string'
          ? { topLevelSite: c.partitionKey }
          : c.partitionKey;
    }
    if (c.firstPartyDomain) details.firstPartyDomain = c.firstPartyDomain;

    try {
      const res = await CH.cookies.set(details);
      if (res) restored++;
      else failed.push({ name: c.name, error: 'cookies.set() returned null' });
    } catch (e) {
      failed.push({ name: c.name, error: String(e?.message || e) });
    }
  }
  return { restored, failed };
}

export { isFirefox };

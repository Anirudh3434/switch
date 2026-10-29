// Host/domain helpers.
//
// Never derive a "root domain" with `host.split('.').slice(-2)`. That turns
// `shop.example.co.uk` into `co.uk`, which is not a site you can own and is a
// very effective way to delete or overwrite unrelated cookies.
//
// This is a deliberately small public-suffix list, not a full PSL
// implementation. It covers the common multi-label suffixes and hosted
// platforms we are likely to encounter; unknown suffixes fall back to the last
// two labels, which is correct for the overwhelming majority of domains.

const MULTI_PART_SUFFIXES = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk',
  // India
  'co.in', 'net.in', 'org.in', 'firm.in', 'ind.in', 'gen.in', 'ac.in', 'edu.in', 'gov.in', 'res.in',
  // Asia / Pacific
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'co.kr', 'or.kr', 'ne.kr', 'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk', 'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg', 'com.my', 'net.my', 'org.my', 'com.ph', 'net.ph', 'org.ph',
  'com.vn', 'net.vn', 'org.vn', 'co.id', 'net.id', 'or.id', 'ac.id', 'co.th', 'in.th', 'ac.th', 'go.th',
  'com.pk', 'net.pk', 'org.pk', 'com.bd', 'net.bd', 'org.bd', 'com.np', 'org.np',
  // Africa / Middle East
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za', 'co.ke', 'or.ke', 'ne.ke', 'com.ng', 'net.ng', 'org.ng',
  'com.eg', 'net.eg', 'org.eg', 'com.sa', 'net.sa', 'org.sa', 'com.ae', 'net.ae', 'org.ae', 'co.il', 'org.il', 'ac.il',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr',
  // Americas
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.mx', 'net.mx', 'org.mx', 'com.ar', 'net.ar', 'org.ar',
  'com.co', 'net.co', 'org.co', 'com.pe', 'net.pe', 'org.pe', 'com.ve', 'com.uy', 'com.py', 'com.bo',
  'com.ec', 'com.do', 'com.gt', 'com.sv', 'com.hn', 'com.ni', 'com.pa', 'com.pr', 'co.cr',
  // Hosted platforms: each tenant is a registrable site.
  'github.io', 'gitlab.io', 'appspot.com', 'herokuapp.com', 'vercel.app', 'netlify.app',
  'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'myshopify.com', 'readthedocs.io',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Lowercase, strip a leading dot and any trailing dot/port. */
export function normalizeHost(input) {
  let host = String(input || '').trim().toLowerCase();
  host = host.replace(/^\.+/, '').replace(/\.+$/, '');
  // URL-ish input (defensive; callers normally pass a hostname already).
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return '';
    }
  }
  // Strip :port, but leave IPv6 literals alone.
  if (!host.startsWith('[') && host.includes(':')) host = host.split(':')[0];
  return host;
}

export function isIpHost(host) {
  const h = normalizeHost(host);
  return IPV4.test(h) || h.includes(':') || h.startsWith('[');
}

/**
 * Registrable domain ("site") for a host. Returns the host itself for IPs and
 * single-label hosts such as `localhost`.
 */
export function getRegistrableDomain(input) {
  const host = normalizeHost(input);
  if (!host || isIpHost(host)) return host;

  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/** True when two hosts are the same site (including subdomain relationships). */
export function hostMatches(a, b) {
  const ha = normalizeHost(a);
  const hb = normalizeHost(b);
  if (!ha || !hb) return false;
  return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
}

/** True when a cookie's domain belongs to the given site. */
export function cookieMatchesHost(cookieDomain, host) {
  return hostMatches(cookieDomain, host);
}

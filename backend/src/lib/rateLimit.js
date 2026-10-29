// Fixed-window rate limiter.
//
// In-memory by design for a single-instance deployment. It resets on restart
// and does not coordinate across replicas; if you run more than one instance,
// put Redis (or the load balancer) in front of this. What it MUST NOT do is
// apply one 100-request bucket to every API call: sync traffic alone exceeds
// that, and a shared bucket lets one noisy endpoint lock out the rest.
//
// Keys are per authenticated user where possible, so users behind a corporate
// NAT do not throttle each other.

const buckets = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_BUCKETS = 50_000;

function clientKey(req) {
  if (req.user?.id) return `user:${req.user.id}`;
  if (req.user?.email) return `user:${String(req.user.email).toLowerCase()}`;
  const ip =
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown';
  return `ip:${ip}`;
}

export function rateLimit({ key, limit, windowMs = WINDOW_MS, keyFn } = {}) {
  const bucketPrefix = key || 'default';

  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${bucketPrefix}:${(keyFn || clientKey)(req)}`;

    let bucket = buckets.get(bucketKey);
    if (!bucket || now > bucket.resetAt) {
      // Opportunistic eviction keeps a long-lived process from growing
      // without bound when attackers rotate IPs.
      if (buckets.size >= MAX_BUCKETS) {
        for (const [k, v] of buckets) {
          if (now > v.resetAt) buckets.delete(k);
          if (buckets.size < MAX_BUCKETS * 0.9) break;
        }
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }

    if (++bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests. Please try again later.',
        retryAfterSeconds: retryAfter,
      });
    }
    next();
  };
}

/**
 * Test-only: clear every bucket.
 *
 * The smoke suite shares one source IP, so without this each test inherits the
 * previous tests' counts and the suite becomes order-dependent.
 */
export function resetRateLimits() {
  buckets.clear();
}

// Opportunistic cleanup so a long-lived process doesn't leak buckets.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}, 60_000).unref();

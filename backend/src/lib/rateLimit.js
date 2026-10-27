// In-memory fixed-window rate limiter for auth endpoints.
//
// This is deliberately in-memory: no Redis dependency for the MVP. It resets on
// restart and does not coordinate across replicas — see README "Production
// hardening" for the Redis-backed swap before you scale past one instance.

const buckets = new Map();
const WINDOW_MS = 15 * 60 * 1000;

export function rateLimit({ key, limit, windowMs = WINDOW_MS }) {
  return (req, res, next) => {
    // Use IP address, falling back to a safe default
    const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const bucketKey = `${key}:${ip}`;

    let bucket = buckets.get(bucketKey);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }

    if (++bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests. Please try again later.',
        retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
      });
    }
    next();
  };
}

/**
 * Test-only: clear every bucket.
 *
 * The smoke suite shares one source IP, so without this each test inherits the
 * previous tests' counts and the suite becomes order-dependent (and trips the
 * register limit at 5 accounts).
 */
export function resetRateLimits() {
  buckets.clear();
}

// Opportunistic cleanup so a long-lived process doesn't leak buckets.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}, 60_000).unref();

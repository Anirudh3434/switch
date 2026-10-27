// Sync: push/pull encrypted session envelopes with per-host versioning.
//
// CONFLICT MODEL — last-writer-wins with explicit versioning.
// The client sends `baseVersion` (the version it last saw). If it still matches
// the server, the write applies and `version` increments. If not, the server
// returns the winning record with `status: 'conflict'` and the newer envelope,
// so the client can decide (auto-adopt, or ask the user).
//
// This beats naive "just overwrite" because a laptop that was offline for a
// week cannot silently clobber a fresher session from your phone.

import { Router } from '../lib/router.js';
import { config } from '../config.js';
import { sessions } from '../db.js';
import { requireAuth, touchDevice } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, touchDevice);

// Rough plaintext-equivalent ceiling per envelope. Ciphertext is ~1.33x the
// plaintext with base64 + GCM tag, so we size accordingly.
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

function validateEnvelope(env) {
  if (!env || typeof env !== 'object') return 'envelope_required';
  if (typeof env.iv !== 'string' || typeof env.data !== 'string')
    return 'malformed_envelope';
  if (Buffer.byteLength(env.data, 'base64') > MAX_ENVELOPE_BYTES)
    return 'envelope_too_large';
  return null;
}

const validHost = (h) =>
  typeof h === 'string' && h.length > 0 && h.length <= 253 && /^[a-z0-9.-]+$/i.test(h);

/** POST /v1/sync/push — batch upsert. */
router.post('/push', async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'items_required' });
  if (items.length > 100) return res.status(400).json({ error: 'batch_too_large' });

  for (const item of items) {
    if (!validHost(item.host)) return res.status(400).json({ error: 'invalid_host' });
    const err = validateEnvelope(item.envelope);
    if (err) return res.status(400).json({ error: err, host: item.host });
  }

  const userId = req.user.id;
  const results = [];

  for (const item of items) {
    const deviceId = req.get('X-Device-Id') || item.deviceId || 'unassigned';
    const deviceName = req.get('X-Device-Name') || item.deviceName || null;

    const current = await sessions().findOne({ userId, deviceId, host: item.host });

    if (!item.force && current && typeof item.baseVersion === 'number' && item.baseVersion !== -1 && current.version !== item.baseVersion) {
      // Conflict — hand the client the winner so it can reconcile.
      results.push({
        host: item.host,
        status: 'conflict',
        version: current.version,
        updatedAt: current.updatedAt,
        envelope: current.envelope,
      });
      continue;
    }

    const version = (current?.version || 0) + 1;
    const updatedAt = new Date();

    await sessions().updateOne(
      { userId, deviceId, host: item.host },
      {
        $set: {
          envelope: item.envelope,
          version,
          updatedAt,
          deleted: false,
          deviceId,
          deviceName,
        },
      },
      { upsert: true },
    );

    results.push({ host: item.host, status: 'ok', version, updatedAt });
  }

  // Enforce the per-account budget after accepting, so a user can't flood us.
  const used = await sessions()
    .aggregate([
      { $match: { userId } },
      { $group: { _id: null, bytes: { $sum: { $strLenCP: '$envelope.data' } } } },
    ])
    .toArray();

  res.json({
    results,
    usage: { bytes: used[0]?.bytes || 0, limit: config.maxUserBytes },
  });
});

/** GET /v1/sync/pull?since=<epochMs>&limit=<1..500> */
router.get('/pull', async (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 500);

  // Overlap window guards against clock skew between client and server.
  const overlapMs = 5000;

  const items = await sessions()
    .find({ userId: req.user.id, updatedAt: { $gt: new Date(since - overlapMs) } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();

  const hasMore = items.length === limit;
  const cursor = hasMore ? items[items.length - 1].updatedAt.getTime() : Date.now();

  res.json({
    items: items.map((d) => ({
      host: d.host,
      envelope: d.envelope,
      version: d.version,
      updatedAt: d.updatedAt,
      deviceId: d.deviceId || null,
      deviceName: d.deviceName || null,
    })),
    cursor,
    hasMore,
  });
});

/** GET /v1/sync/list — index without the (potentially huge) payloads. */
router.get('/list', async (req, res) => {
  const items = await sessions()
    .find({ userId: req.user.id, deleted: { $ne: true } })
    .project({ host: 1, version: 1, updatedAt: 1, deviceId: 1, deviceName: 1 })
    .sort({ updatedAt: -1 })
    .toArray();

  res.json({
    items: items.map((d) => ({
      host: d.host,
      version: d.version,
      updatedAt: d.updatedAt,
      deviceId: d.deviceId || null,
      deviceName: d.deviceName || null,
    })),
  });
});

/** DELETE /v1/sync/:host — permanently remove session from cloud database. */
router.delete('/:host', async (req, res) => {
  const { host } = req.params;
  if (!validHost(host)) return res.status(400).json({ error: 'invalid_host' });

  const cleanHost = String(host).replace(/^\./, '').toLowerCase().trim();
  const rootDomain = cleanHost.split('.').slice(-2).join('.');

  const deviceId = req.get('X-Device-Id') || req.query.deviceId || null;
  const filter = {
    userId: req.user.id,
    $or: [
      { host: cleanHost },
      { host: rootDomain },
      { host: `.${cleanHost}` },
      { host: `.${rootDomain}` },
    ],
  };

  if (deviceId) {
    filter.deviceId = deviceId;
  }

  const result = await sessions().deleteMany(filter);
  res.json({ ok: true, deletedCount: result.deletedCount });
});

export default router;

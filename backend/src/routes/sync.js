// Sync: push/pull encrypted session envelopes with per-host versioning.
//
// CONFLICT MODEL — last-writer-wins with explicit versioning.
// The client sends `baseVersion` (the version it last saw). If it still matches
// the server, the write applies and `version` increments. If not, the server
// returns the winning record with `status: 'conflict'` and the newer envelope,
// so the client can decide (auto-adopt, or ask the user).
//
// There is deliberately no `force` escape hatch: a stale device must not be
// able to silently clobber a newer session just because it asked nicely.
//
// DELETES ARE TOMBSTONES. A hard delete is invisible to other devices, so the
// deleted session simply reappears on the next pull. A tombstone carries a
// version like any other write.

import { Router } from '../lib/router.js';
import { config } from '../config.js';
import { sessions } from '../db.js';
import { requireAuth, touchDevice } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, touchDevice);

// Rough plaintext-equivalent ceiling per envelope. Ciphertext is ~1.33x the
// plaintext with base64 + GCM tag, so we size accordingly.
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_PULL_LIMIT = 500;

function validateEnvelope(env) {
  if (!env || typeof env !== 'object') return 'envelope_required';
  if (typeof env.iv !== 'string' || typeof env.data !== 'string')
    return 'malformed_envelope';
  if (env.v !== undefined && env.v !== 1 && env.v !== 2)
    return 'unsupported_envelope_version';
  if (Buffer.byteLength(env.data, 'base64') > MAX_ENVELOPE_BYTES)
    return 'envelope_too_large';
  return null;
}

const normalizeHost = (h) =>
  String(h || '').replace(/^\./, '').toLowerCase().trim();

const validHost = (h) =>
  typeof h === 'string' &&
  h.length > 0 &&
  h.length <= 253 &&
  /^[a-z0-9.-]+$/i.test(h);

const envelopeBytes = (env) =>
  env && typeof env.data === 'string'
    ? Buffer.byteLength(env.data, 'base64')
    : 0;

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
  const headerDeviceId = req.get('X-Device-Id');

  // ── Phase 1: resolve current state and enforce the account budget before
  // writing anything, so a rejected batch cannot leave a partial write behind.
  const planned = [];
  let projectedBytes = 0;

  const usageAgg = await sessions()
    .aggregate([
      { $match: { userId, deleted: { $ne: true } } },
      { $group: { _id: null, bytes: { $sum: { $strLenCP: '$envelope.data' } } } },
    ])
    .toArray();
  projectedBytes = usageAgg[0]?.bytes || 0;

  for (const item of items) {
    const host = normalizeHost(item.host);
    const deviceId = headerDeviceId || item.deviceId || 'unassigned';
    const deviceName = req.get('X-Device-Name') || item.deviceName || null;

    const current = await sessions().findOne({ userId, deviceId, host });

    const hasBaseVersion = typeof item.baseVersion === 'number' && item.baseVersion >= 0;
    if (current && hasBaseVersion && current.version !== item.baseVersion) {
      planned.push({ kind: 'conflict', host, current });
      continue;
    }
    // A tombstone cannot be resurrected from a stale base version.
    if (current?.deleted && hasBaseVersion && item.baseVersion !== current.version) {
      planned.push({ kind: 'conflict', host, current });
      continue;
    }

    const oldBytes = current?.deleted ? 0 : envelopeBytes(current?.envelope);
    projectedBytes += envelopeBytes(item.envelope) - oldBytes;
    planned.push({
      kind: 'write',
      host,
      deviceId,
      deviceName,
      current,
      envelope: item.envelope,
    });
  }

  if (projectedBytes > config.maxUserBytes) {
    return res.status(413).json({
      error: 'storage_limit_exceeded',
      usage: { bytes: projectedBytes, limit: config.maxUserBytes },
    });
  }

  // ── Phase 2: apply writes.
  const results = [];
  for (const entry of planned) {
    if (entry.kind === 'conflict') {
      results.push({
        host: entry.host,
        status: 'conflict',
        version: entry.current.version,
        updatedAt: entry.current.updatedAt,
        deleted: !!entry.current.deleted,
        envelope: entry.current.deleted ? null : entry.current.envelope,
      });
      continue;
    }

    const version = (entry.current?.version || 0) + 1;
    const updatedAt = new Date();

    await sessions().updateOne(
      { userId, deviceId: entry.deviceId, host: entry.host },
      {
        $set: {
          envelope: entry.envelope,
          version,
          updatedAt,
          deleted: false,
          deletedAt: null,
          deviceId: entry.deviceId,
          deviceName: entry.deviceName,
        },
      },
      { upsert: true },
    );

    results.push({ host: entry.host, status: 'ok', version, updatedAt });
  }

  res.json({
    results,
    usage: { bytes: Math.max(0, projectedBytes), limit: config.maxUserBytes },
  });
});

/** GET /v1/sync/pull?since=<epochMs>&limit=<1..500> */
router.get('/pull', async (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.min(
    Math.max(Number(req.query.limit) || MAX_PULL_LIMIT, 1),
    MAX_PULL_LIMIT,
  );

  // Overlap window guards against clock skew between client and server.
  const overlapMs = 5000;

  const items = await sessions()
    .find({
      userId: req.user.id,
      updatedAt: { $gt: new Date(since - overlapMs) },
    })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();

  const hasMore = items.length === limit;
  const cursor = hasMore ? items[items.length - 1].updatedAt.getTime() : Date.now();

  res.json({
    items: items.map((d) => ({
      host: d.host,
      // Tombstones deliberately carry no payload.
      envelope: d.deleted ? null : d.envelope,
      version: d.version,
      updatedAt: d.updatedAt,
      deleted: !!d.deleted,
      deletedAt: d.deletedAt || null,
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

/** GET /v1/sync/usage — how much of the encrypted-blob budget is used. */
router.get('/usage', async (req, res) => {
  const agg = await sessions()
    .aggregate([
      { $match: { userId: req.user.id, deleted: { $ne: true } } },
      { $group: { _id: null, bytes: { $sum: { $strLenCP: '$envelope.data' } } } },
    ])
    .toArray();
  res.json({ bytes: agg[0]?.bytes || 0, limit: config.maxUserBytes });
});

/**
 * DELETE /v1/sync/:host — tombstone a session.
 *
 * Only the exact host is touched. We do not guess registrable domains: doing
 * `split('.').slice(-2)` turns `foo.co.uk` into `co.uk` and would delete an
 * unrelated (and enormous) subtree on the server.
 *
 * By default a request carrying X-Device-Id only tombstones that device's
 * copy. Pass `?allDevices=true` for an explicit account-wide delete.
 */
router.delete('/:host', async (req, res) => {
  const { host } = req.params;
  if (!validHost(host)) return res.status(400).json({ error: 'invalid_host' });

  const cleanHost = normalizeHost(host);
  const allDevices = req.query.allDevices === 'true';
  const deviceId = req.get('X-Device-Id') || req.query.deviceId || null;

  const filter = { userId: req.user.id, host: cleanHost };
  if (!allDevices && deviceId) filter.deviceId = deviceId;

  const result = await sessions().updateMany(filter, {
    $inc: { version: 1 },
    $set: {
      deleted: true,
      deletedAt: new Date(),
      updatedAt: new Date(),
      envelope: null,
    },
  });

  res.json({
    ok: true,
    host: cleanHost,
    tombstoned: result.modifiedCount,
    deletedCount: result.modifiedCount,
  });
});

export default router;

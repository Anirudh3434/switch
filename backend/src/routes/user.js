// Account surface: devices, sharing key, data deletion.

import { Router } from '../lib/router.js';
import { users, devices, sessions } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/** GET /v1/user/devices — every browser that has checked in. */
router.get('/devices', async (req, res) => {
  const list = await devices()
    .find({ userId: req.user.id })
    .sort({ lastSeenAt: -1 })
    .toArray();

  res.json({
    items: list.map((d) => ({
      deviceId: d.deviceId,
      systemId: d.systemId || null,
      name: d.name,
      browserInfo: d.browserInfo || null,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt || null,
    })),
  });
});

/** POST /v1/user/devices — register or update calling device */
router.post('/devices', async (req, res) => {
  const { deviceId, name, browserInfo, systemId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'device_id_required' });

  const resolvedSystemId = systemId || req.get('X-System-Id') || null;

  await devices().updateOne(
    { userId: req.user.id, deviceId },
    {
      $set: {
        name: name || 'Unnamed Device',
        systemId: resolvedSystemId,
        browserInfo: browserInfo || {},
        lastSeenAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  res.json({ ok: true });
});

/** DELETE /v1/user/devices/:deviceId */
router.delete('/devices/:deviceId', async (req, res) => {
  const result = await devices().deleteOne({
    userId: req.user.id,
    deviceId: req.params.deviceId,
  });

  // Also remove sessions synced by this revoked device
  await sessions().deleteMany({
    userId: req.user.id,
    deviceId: req.params.deviceId,
  });

  res.status(result.deletedCount ? 204 : 404).end();
});

/** PUT /v1/user/public-key — publish the key others wrap shares for me with. */
router.put('/public-key', async (req, res) => {
  const { publicKey } = req.body || {};
  if (typeof publicKey !== 'string' || publicKey.length < 64 || publicKey.length > 8192)
    return res.status(400).json({ error: 'invalid_public_key' });

  await users().updateOne(
    { email: req.user.email },
    { $set: { publicKey } },
  );
  res.status(204).end();
});

/** DELETE /v1/user/data — full erasure (GDPR/DPDP "right to be forgotten"). */
router.delete('/data', async (req, res) => {
  const userId = req.user.id;
  await Promise.all([
    sessions().deleteMany({ userId }),
    devices().deleteMany({ userId }),
  ]);
  res.status(204).end();
});

export default router;

// Account surface: devices, data export, and irreversible erasure.

import { ObjectId } from 'mongodb';
import { Router } from '../lib/router.js';
import {
  users,
  devices,
  sessions,
  refresh,
  shares,
  otps,
  recoveryKeys,
} from '../db.js';
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

/**
 * POST /v1/user/devices/adopt — merge an old install into the calling device.
 *
 * A reinstall clears extension storage, so the browser generates a new random
 * `deviceId`. Without this endpoint the previous record stays in the account
 * forever and the user sees two identical devices.
 *
 * The caller explicitly names the record to absorb. We never infer this from
 * browser/OS alone: two real machines can look identical, and silently merging
 * them would move one person's synced sessions onto another machine.
 *
 * The calling (new) device stays canonical. The adopted record's encrypted
 * sessions move across (newer version wins per host), its dead refresh tokens
 * are dropped, and the duplicate device row is removed.
 */
router.post('/devices/adopt', async (req, res) => {
  const currentDeviceId = req.get('X-Device-Id');
  const targetDeviceId = req.body?.deviceId;

  if (!currentDeviceId || currentDeviceId.length > 256) {
    return res.status(400).json({ error: 'device_id_required' });
  }
  if (
    typeof targetDeviceId !== 'string' ||
    targetDeviceId.length < 4 ||
    targetDeviceId.length > 256 ||
    /[\s\x00-\x1f]/.test(targetDeviceId)
  ) {
    return res.status(400).json({ error: 'invalid_device_id' });
  }
  if (targetDeviceId === currentDeviceId) {
    return res.status(400).json({ error: 'cannot_adopt_self' });
  }

  const userId = req.user.id;

  // Atomically claim the old record so two clients cannot adopt it twice.
  const target = await devices().findOneAndDelete({
    userId,
    deviceId: targetDeviceId,
  });
  if (!target) return res.status(404).json({ error: 'device_not_found' });

  const now = new Date();
  const current = await devices().findOne({ userId, deviceId: currentDeviceId });
  const firstSeen = [current?.createdAt, target.createdAt]
    .filter(Boolean)
    .sort((a, b) => new Date(a) - new Date(b))[0] || now;

  const name = req.body?.name || req.get('X-Device-Name') || current?.name || 'Unnamed Device';
  const browserInfo = req.body?.browserInfo || current?.browserInfo || {};
  const systemId =
    req.body?.systemId || req.get('X-System-Id') || current?.systemId || target.systemId || null;

  await devices().updateOne(
    { userId, deviceId: currentDeviceId },
    {
      $set: {
        name,
        browserInfo,
        systemId,
        createdAt: firstSeen,
        lastSeenAt: now,
      },
    },
    { upsert: true },
  );

  // Merge the old install's sessions into the calling device. The unique
  // index is (userId, deviceId, host), so a host present on both sides must
  // collapse to one row before the move.
  const [adoptedSessions, currentSessions] = await Promise.all([
    sessions().find({ userId, deviceId: targetDeviceId }).toArray(),
    sessions().find({ userId, deviceId: currentDeviceId }).toArray(),
  ]);
  const currentByHost = new Map(currentSessions.map((s) => [s.host, s]));

  let movedSessions = 0;
  let mergedSessions = 0;
  let droppedSessions = 0;

  for (const doc of adoptedSessions) {
    const existing = currentByHost.get(doc.host);

    if (!existing) {
      await sessions().updateOne(
        { _id: doc._id },
        { $set: { deviceId: currentDeviceId, deviceName: name } },
      );
      movedSessions++;
      continue;
    }

    const docVersion = doc.version || 0;
    const existingVersion = existing.version || 0;
    const targetWins =
      docVersion > existingVersion ||
      (docVersion === existingVersion &&
        new Date(doc.updatedAt).getTime() > new Date(existing.updatedAt).getTime());

    if (targetWins) {
      await sessions().updateOne(
        { _id: existing._id },
        {
          $set: {
            envelope: doc.deleted ? null : doc.envelope,
            version: docVersion,
            updatedAt: doc.updatedAt,
            deleted: !!doc.deleted,
            deletedAt: doc.deletedAt || null,
            deviceId: currentDeviceId,
            deviceName: name,
          },
        },
      );
      mergedSessions++;
    } else {
      droppedSessions++;
    }

    await sessions().deleteOne({ _id: doc._id });
  }

  // The adopted install no longer exists, so its refresh credentials must not
  // survive the merge. Access tokens still expire within the normal TTL. The
  // calling install keeps its own refresh token.
  const revokedRefreshTokens = await refresh().deleteMany({
    userId,
    deviceId: targetDeviceId,
  });

  res.json({
    ok: true,
    deviceId: currentDeviceId,
    adoptedDeviceId: targetDeviceId,
    movedSessions,
    mergedSessions,
    droppedSessions,
    revokedRefreshTokens: revokedRefreshTokens.deletedCount || 0,
  });
});

/** DELETE /v1/user/devices/:deviceId */
router.delete('/devices/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const result = await devices().deleteOne({
    userId: req.user.id,
    deviceId,
  });

  // Remove that device's synced copies and refresh tokens. Other devices keep
  // their own copies (sessions are stored per device + host).
  await Promise.all([
    sessions().deleteMany({ userId: req.user.id, deviceId }),
    refresh().deleteMany({ userId: req.user.id, deviceId }),
  ]);

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

/**
 * GET /v1/user/export — GDPR/DPDP data portability.
 *
 * Returns encrypted envelopes as stored. The server cannot decrypt them; the
 * user can open them with their master password in the extension.
 */
router.get('/export', async (req, res) => {
  const userId = req.user.id;
  const [user, deviceList, sessionList, incoming, outgoing] = await Promise.all([
    users().findOne(
      { _id: new ObjectId(userId) },
      { projection: { authHash: 0 } },
    ),
    devices().find({ userId }).toArray(),
    sessions().find({ userId }).toArray(),
    shares().find({ toUserId: userId }).toArray(),
    shares().find({ fromUserId: userId }).toArray(),
  ]);

  const payload = {
    format: 'switch-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    user: user
      ? {
          id: String(user._id),
          email: user.email,
          createdAt: user.createdAt,
          emailVerifiedAt: user.emailVerifiedAt || null,
          publicKey: user.publicKey || null,
        }
      : null,
    devices: deviceList.map((d) => ({
      deviceId: d.deviceId,
      systemId: d.systemId || null,
      name: d.name,
      browserInfo: d.browserInfo || null,
      createdAt: d.createdAt || null,
      lastSeenAt: d.lastSeenAt || null,
    })),
    sessions: sessionList.map((s) => ({
      host: s.host,
      deviceId: s.deviceId || null,
      deviceName: s.deviceName || null,
      version: s.version,
      updatedAt: s.updatedAt,
      deleted: !!s.deleted,
      envelope: s.envelope || null,
    })),
    shares: {
      incoming: incoming.map((s) => ({
        id: String(s._id),
        host: s.host,
        fromUserId: s.fromUserId,
        note: s.note,
        createdAt: s.createdAt,
        consumedAt: s.consumedAt,
      })),
      outgoing: outgoing.map((s) => ({
        id: String(s._id),
        host: s.host,
        toUserId: s.toUserId,
        note: s.note,
        createdAt: s.createdAt,
        consumedAt: s.consumedAt,
      })),
    },
  };

  res.set('Content-Disposition', 'attachment; filename="switch-export.json"');
  res.json(payload);
});

/**
 * Erase every server-side record for this account.
 *
 * This includes the account row itself, all encrypted session copies, refresh
 * tokens, device registrations, OTPs, recovery keys, and shares in both
 * directions. It is intentionally not recoverable.
 */
async function eraseAccount({ userId, email }) {
  await Promise.all([
    sessions().deleteMany({ userId }),
    refresh().deleteMany({ userId }),
    devices().deleteMany({ userId }),
    recoveryKeys().deleteMany({ userId }),
    shares().deleteMany({
      $or: [{ fromUserId: userId }, { toUserId: userId }],
    }),
    otps().deleteMany({ email }),
  ]);
  await users().deleteOne({ _id: new ObjectId(userId) });
}

/** DELETE /v1/user/account — full account erasure (GDPR/DPDP right to erasure). */
router.delete('/account', async (req, res) => {
  await eraseAccount({ userId: req.user.id, email: req.user.email });
  res.status(204).end();
});

/**
 * DELETE /v1/user/data — legacy alias for the same full erasure.
 *
 * Keeping two names is friendlier to older clients; keeping one implementation
 * is how we avoid a "delete my data" endpoint that quietly leaves the account,
 * OTPs, and shares behind.
 */
router.delete('/data', async (req, res) => {
  await eraseAccount({ userId: req.user.id, email: req.user.email });
  res.status(204).end();
});

export default router;

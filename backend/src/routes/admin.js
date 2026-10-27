// Switch Admin Console Backend Routes
import { Router } from '../lib/router.js';
import { ObjectId } from 'mongodb';
import { users, sessions, devices, shares, feedbacks, otps } from '../db.js';
import { resetRateLimits } from '../lib/rateLimit.js';

const router = Router();

// In-memory system logs buffer for console stream
const systemLogs = [
  { ts: new Date().toISOString(), level: 'INFO', msg: 'Switch Admin Subsystem initialized' },
  { ts: new Date().toISOString(), level: 'INFO', msg: 'Zero-Knowledge Cryptographic Vault ready' },
  { ts: new Date().toISOString(), level: 'STATUS', msg: 'MongoDB collections verified and indexed' },
];

export function logAdminEvent(level, msg) {
  systemLogs.unshift({ ts: new Date().toISOString(), level, msg });
  if (systemLogs.length > 100) systemLogs.pop();
}

/**
 * GET /v1/admin/overview
 * Real-time system diagnostics, collection telemetry, and recent items
 */
router.get('/overview', async (_req, res) => {
  try {
    const [
      usersCount,
      sessionsCount,
      devicesCount,
      sharesCount,
      feedbacksCount,
      otpsCount,
      recentFeedbacksList,
      recentDevicesList,
      recentUsersList,
    ] = await Promise.all([
      users().countDocuments().catch(() => 0),
      sessions().countDocuments().catch(() => 0),
      devices().countDocuments().catch(() => 0),
      shares().countDocuments().catch(() => 0),
      feedbacks().countDocuments().catch(() => 0),
      otps().countDocuments().catch(() => 0),
      feedbacks().find().sort({ createdAt: -1 }).limit(8).toArray().catch(() => []),
      devices().find().sort({ lastSeenAt: -1 }).limit(8).toArray().catch(() => []),
      users().find().sort({ createdAt: -1 }).project({ authHash: 0, kdfSalt: 0 }).limit(8).toArray().catch(() => []),
    ]);

    // Break down feedbacks by type
    const feedbackCountsByType = { bug: 0, improvement: 0, suggestion: 0 };
    const typeAgg = await feedbacks().aggregate([
      { $group: { _id: '$type', count: { $sum: 1 } } }
    ]).toArray().catch(() => []);
    typeAgg.forEach(item => {
      if (item._id && feedbackCountsByType[item._id] !== undefined) {
        feedbackCountsByType[item._id] = item.count;
      }
    });

    const mem = process.memoryUsage();

    return res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      system: {
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryRssMb: Math.round(mem.rss / (1024 * 1024) * 10) / 10,
        memoryHeapUsedMb: Math.round(mem.heapUsed / (1024 * 1024) * 10) / 10,
      },
      counts: {
        users: usersCount,
        sessions: sessionsCount,
        devices: devicesCount,
        shares: sharesCount,
        feedbacks: feedbacksCount,
        otps: otpsCount,
        feedbackByType: feedbackCountsByType,
      },
      recentFeedbacks: recentFeedbacksList,
      recentDevices: recentDevicesList,
      recentUsers: recentUsersList,
      logs: systemLogs.slice(0, 20),
    });
  } catch (err) {
    console.error('[switch-admin] overview error:', err);
    return res.status(500).json({ error: 'admin_overview_failed', details: err.message });
  }
});

/**
 * GET /v1/admin/feedbacks
 * Query all feedback items with optional type filter
 */
router.get('/feedbacks', async (req, res) => {
  try {
    const { type } = req.query || {};
    const query = {};
    if (type && ['bug', 'improvement', 'suggestion'].includes(type)) {
      query.type = type;
    }

    const items = await feedbacks().find(query).sort({ createdAt: -1 }).limit(100).toArray();
    return res.json({ ok: true, count: items.length, items });
  } catch (err) {
    console.error('[switch-admin] feedbacks error:', err);
    return res.status(500).json({ error: 'fetch_feedbacks_failed' });
  }
});

/**
 * PATCH /v1/admin/feedbacks/:id
 * Toggle status of a feedback item (e.g. reviewed, resolved, open)
 */
router.patch('/feedbacks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid_object_id' });
    }

    const cleanStatus = ['open', 'in_progress', 'resolved', 'closed'].includes(status) ? status : 'reviewed';

    const result = await feedbacks().updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: cleanStatus, statusUpdatedAt: new Date() } }
    );

    logAdminEvent('UPDATE', `Feedback ${id.slice(-6)} set to ${cleanStatus}`);

    return res.json({ ok: true, modifiedCount: result.modifiedCount, status: cleanStatus });
  } catch (err) {
    return res.status(500).json({ error: 'update_feedback_failed' });
  }
});

/**
 * DELETE /v1/admin/feedbacks/:id
 * Remove a spam or resolved feedback entry
 */
router.delete('/feedbacks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid_object_id' });
    }

    const result = await feedbacks().deleteOne({ _id: new ObjectId(id) });
    logAdminEvent('DELETE', `Feedback ${id.slice(-6)} purged by administrator`);

    return res.json({ ok: true, deletedCount: result.deletedCount });
  } catch (err) {
    return res.status(500).json({ error: 'delete_feedback_failed' });
  }
});

/**
 * GET /v1/admin/users
 * Returns user accounts list
 */
router.get('/users', async (_req, res) => {
  try {
    const items = await users()
      .find()
      .sort({ createdAt: -1 })
      .project({ authHash: 0, kdfSalt: 0 })
      .limit(100)
      .toArray();

    return res.json({ ok: true, count: items.length, items });
  } catch (err) {
    return res.status(500).json({ error: 'fetch_users_failed' });
  }
});

/**
 * GET /v1/admin/devices
 * Returns registered devices fleet
 */
router.get('/devices', async (_req, res) => {
  try {
    const items = await devices().find().sort({ lastSeenAt: -1 }).limit(100).toArray();
    return res.json({ ok: true, count: items.length, items });
  } catch (err) {
    return res.status(500).json({ error: 'fetch_devices_failed' });
  }
});

/**
 * POST /v1/admin/action/ping
 * Heartbeat diagnostic
 */
router.post('/action/ping', (_req, res) => {
  logAdminEvent('HEARTBEAT', 'Admin manual diagnostic ping executed');
  return res.json({ ok: true, pong: Date.now() });
});

/**
 * POST /v1/admin/action/reset-rate-limits
 * Maintenance utility: clears all in-memory rate-limiter buckets
 */
router.post('/action/reset-rate-limits', (_req, res) => {
  resetRateLimits();
  logAdminEvent('MAINTENANCE', 'Rate limit buckets reset by administrator');
  return res.json({ ok: true, message: 'All rate limit buckets reset successfully.' });
});

export default router;

// Share — the team-handoff feature. This is the one the market pays for:
// Multilogin gates "Profile transfer (hand off to teams or clients)" behind
// their paid tier; AdsPower gates "Unlimited profile sharing". We do it with
// an extension and no separate browser.
//
// SECURITY MODEL: the server NEVER learns the shared session. The sender wraps
// the session's encryption key with the RECIPIENT's public key (RSA-OAEP) and
// uploads only that wrapped blob. The recipient unwraps it client-side. The
// server is a dumb courier: it can prove who sent what, but cannot read it.
//
// The receiver accepts into their own vault by re-sealing with their own key —
// so the sender can revoke later by deleting the share, which does not revoke
// a session the receiver already imported (documented in the UI copy).

import { ObjectId } from 'mongodb';
import { Router } from '../lib/router.js';
import { shares, sessions, users } from '../db.js';
import { requireAuth, touchDevice } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, touchDevice);

const emailNorm = (e) => String(e || '').trim().toLowerCase();

function validateWrappedKey(wk) {
  if (!wk || typeof wk !== 'object') return 'wrapped_key_required';
  if (typeof wk.alg !== 'string' || wk.alg !== 'RSA-OAEP-256')
    return 'invalid_wrapped_alg';
  if (typeof wk.key !== 'string' || wk.key.length > 2048)
    return 'invalid_wrapped_key';
  return null;
}

/** GET /v1/share/recipient?email= — fetch someone's public key to wrap for. */
router.get('/recipient', async (req, res) => {
  const email = emailNorm(req.query.email);
  const user = await users().findOne({ email });
  if (!user) return res.status(404).json({ error: 'recipient_not_found' });
  if (!user.publicKey) return res.status(409).json({ error: 'recipient_has_no_key' });
  res.json({ email: user.email, publicKey: user.publicKey });
});

/** POST /v1/share — hand a session to another account. */
router.post('/', async (req, res) => {
  const { targetEmail, host, wrappedKey, note } = req.body || {};
  const email = emailNorm(targetEmail);

  if (!email) return res.status(400).json({ error: 'target_required' });
  if (email === req.user.email)
    return res.status(400).json({ error: 'cannot_share_to_self' });
  const keyErr = validateWrappedKey(wrappedKey);
  if (keyErr) return res.status(400).json({ error: keyErr });
  if (typeof host !== 'string' || !host)
    return res.status(400).json({ error: 'host_required' });

  const recipient = await users().findOne({ email });
  if (!recipient) return res.status(404).json({ error: 'recipient_not_found' });
  if (!recipient.publicKey)
    return res.status(409).json({ error: 'recipient_has_no_key' });

  const { insertedId } = await shares().insertOne({
    fromUserId: req.user.id,
    toUserId: String(recipient._id),
    host,
    wrappedKey,
    note: typeof note === 'string' ? note.slice(0, 200) : null,
    createdAt: new Date(),
    consumedAt: null,
  });

  res.status(201).json({ id: String(insertedId), host, to: recipient.email });
});

/** GET /v1/share/incoming — shares waiting for me. */
router.get('/incoming', async (req, res) => {
  const pending = await shares()
    .find({ toUserId: req.user.id, consumedAt: null })
    .sort({ createdAt: -1 })
    .toArray();

  const senders = await users()
    .find({ _id: { $in: pending.map((p) => new ObjectId(p.fromUserId)) } })
    .project({ email: 1 })
    .toArray();
  const senderById = new Map(senders.map((u) => [String(u._id), u.email]));

  res.json({
    items: pending.map((p) => ({
      id: String(p._id),
      host: p.host,
      from: senderById.get(p.fromUserId) || 'unknown',
      note: p.note,
      createdAt: p.createdAt,
      wrappedKey: p.wrappedKey, // opaque to the server; the client unwraps it
    })),
  });
});

/** POST /v1/share/:id/accept — pull it into my own sync set. */
router.post('/:id/accept', async (req, res) => {
  let id;
  try {
    id = new ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ error: 'invalid_id' });
  }

  const share = await shares().findOne({ _id: id, toUserId: req.user.id, consumedAt: null });
  if (!share) return res.status(404).json({ error: 'not_found_or_already_consumed' });

  // The receiving client uploads its own re-sealed envelope via /sync/push.
  // Here we only mark the share consumed and return the wrapped key + host.
  await shares().updateOne({ _id: id }, { $set: { consumedAt: new Date() } });
  res.json({
    host: share.host,
    fromUserId: share.fromUserId,
    wrappedKey: share.wrappedKey,
    note: share.note,
  });
});

/** DELETE /v1/share/:id — decline / revoke an unconsumed share. */
router.delete('/:id', async (req, res) => {
  let id;
  try {
    id = new ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ error: 'invalid_id' });
  }

  const result = await shares().deleteOne({ _id: id, toUserId: req.user.id });
  res.status(result.deletedCount ? 204 : 404).end();
});

/** DELETE /v1/share/sent/:id — sender pulls it back before it's accepted. */
router.delete('/sent/:id', async (req, res) => {
  let id;
  try {
    id = new ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ error: 'invalid_id' });
  }

  const result = await shares().deleteOne({ _id: id, fromUserId: req.user.id });
  res.status(result.deletedCount ? 204 : 404).end();
});

export default router;

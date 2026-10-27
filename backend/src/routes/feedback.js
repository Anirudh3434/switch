// Feedback route: collects bug reports, improvements, and suggestions.
import { Router } from '../lib/router.js';
import { feedbacks } from '../db.js';

const router = Router();

const VALID_TYPES = ['bug', 'improvement', 'suggestion'];

/**
 * POST /v1/feedback
 * Body: { type: 'bug' | 'improvement' | 'suggestion', description: string, email?: string }
 */
router.post('/', async (req, res) => {
  const { type, description, email } = req.body || {};

  const cleanType = String(type || '').trim().toLowerCase();
  if (!VALID_TYPES.includes(cleanType)) {
    return res.status(400).json({
      error: 'invalid_type',
      message: 'Type must be one of: bug, improvement, suggestion',
    });
  }

  const cleanDesc = String(description || '').trim();
  if (!cleanDesc || cleanDesc.length < 3) {
    return res.status(400).json({
      error: 'description_required',
      message: 'Description must be at least 3 characters',
    });
  }

  if (cleanDesc.length > 5000) {
    return res.status(400).json({
      error: 'description_too_long',
      message: 'Description cannot exceed 5000 characters',
    });
  }

  const cleanEmail = email ? String(email).trim().toLowerCase() : null;

  try {
    const feedbackDoc = {
      type: cleanType,
      description: cleanDesc,
      email: cleanEmail,
      ip: req.ip || null,
      userAgent: req.get('user-agent') || null,
      createdAt: new Date(),
    };

    const result = await feedbacks().insertOne(feedbackDoc);

    console.log(`[switch] new feedback received: [${cleanType}] "${cleanDesc.slice(0, 45)}..."`);

    return res.status(201).json({
      ok: true,
      id: result.insertedId,
      type: cleanType,
      message: 'Thank you for your feedback!',
    });
  } catch (err) {
    console.error('[switch] feedback submission error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;

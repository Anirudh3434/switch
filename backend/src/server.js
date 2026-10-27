// Switch backend — entrypoint.
//
// Boot order matters: config -> db -> middleware -> routes -> listen.
// Every error path is caught and logged without echoing internals to clients.

import express from 'express';
import { config } from './config.js';
import { connect, close } from './db.js';
import { securityHeaders, cors, rejectDisallowedOrigin } from './lib/security.js';
import { rateLimit } from './lib/rateLimit.js';
import authRoutes from './routes/auth.js';
import syncRoutes from './routes/sync.js';
import shareRoutes from './routes/share.js';
import userRoutes from './routes/user.js';
import feedbackRoutes from './routes/feedback.js';
import adminRoutes from './routes/admin.js';

export function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // accurate req.ip behind a reverse proxy
  app.use(express.json({ limit: '12mb' }));
  app.use(securityHeaders);
  app.use(cors);
  app.use(rejectDisallowedOrigin);

  // Global rate limiting
  const globalLimiter = rateLimit({ key: 'global', limit: 100, windowMs: 15 * 60 * 1000 });
  app.use(globalLimiter);

  app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  app.use('/v1/auth', authRoutes);
  app.use('/v1/sync', syncRoutes);
  app.use('/v1/share', shareRoutes);
  app.use('/v1/user', userRoutes);
  app.use('/v1/feedback', feedbackRoutes);
  app.use('/v1/admin', adminRoutes);

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large')
      return res.status(413).json({ error: 'payload_too_large' });
    if (err instanceof SyntaxError && 'body' in err)
      return res.status(400).json({ error: 'malformed_json' });

    console.error('[switch] unhandled error:', err?.message || err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

// Only auto-start when run directly (the smoke test imports buildApp()).
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[/\\]/).pop());

if (isMain) {
  try {
    await connect();
    const app = buildApp();
    const server = app.listen(config.port, () => {
      console.log(`[switch] api listening on :${config.port}`);
      console.log(`[switch] cors origins: ${config.allowedOrigins.join(', ') || '(none — browser clients blocked)'}`);
    });

    const shutdown = async (signal) => {
      console.log(`[switch] ${signal} received, shutting down`);
      server.close(async () => {
        await close();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Last-resort safety net.
    //
    // The async-safe Router (lib/router.js) routes handler failures to the
    // error middleware, but anything that escapes it — a rejected promise in
    // an event callback, a background task — would otherwise terminate the
    // process on Node >= 15. Log loudly and keep serving: a degraded API beats
    // a dead one. If this fires, the originating bug still needs fixing.
    process.on('unhandledRejection', (reason) => {
      console.error('[switch] UNHANDLED REJECTION (request survived):', reason);
    });
    process.on('uncaughtException', (err) => {
      // A truly uncaught exception leaves the process in an undefined state.
      // Log, then exit and let the supervisor restart cleanly.
      console.error('[switch] UNCAUGHT EXCEPTION, shutting down:', err);
      shutdown('uncaughtException');
    });
  } catch (e) {
    console.error('[switch] fatal boot error:', e.message);
    process.exit(1);
  }
}

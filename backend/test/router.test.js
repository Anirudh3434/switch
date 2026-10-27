// Proves a failing handler can never take the API down.
//
// Express 4 does not forward rejected promises from async handlers to the error
// middleware; without the wrapper in src/lib/router.js a throw becomes an
// unhandled rejection, which Node turns into a process exit. This suite asserts
// the containment behaviour directly, and needs no database.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { Router } from '../src/lib/router.js';

let server;
let base;
let order = [];

function buildApp() {
  const app = express();
  const r = Router();

  r.get('/ok', async (_req, res) => {
    order.push('ok');
    res.json({ ok: true });
  });

  r.get('/async-throw', async () => {
    throw new Error('boom-async');
  });

  r.get('/async-reject', () => Promise.reject(new Error('boom-reject')));

  r.get('/sync-throw', () => {
    throw new Error('boom-sync');
  });

  // Params + multiple middleware must keep working through the wrapper.
  r.get(
    '/chain/:id',
    async (_req, _res, next) => {
      order.push('mw1');
      next();
    },
    async (req, res) => {
      order.push('mw2');
      res.json({ id: req.params.id });
    },
  );

  // Error middleware must also be wrapped-through, not bypassed.
  r.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: err.message });
  });

  app.use('/t', r);
  return app;
}

before(async () => {
  server = createServer(buildApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const hit = (path) => fetch(base + path);

test('an async throw becomes a 500, not a dead process', async () => {
  const res = await hit('/t/async-throw');
  assert.equal(res.status, 500);
  // Assert the CONTENT-TYPE too: Express's default handler also returns 500,
  // but as an HTML page, which is how this bug hid the first time.
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.error, 'internal_error');
});

test('a rejected promise becomes a 500', async () => {
  const res = await hit('/t/async-reject');
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.equal((await res.json()).error, 'internal_error');
});

test('a sync throw becomes a 500', async () => {
  const res = await hit('/t/sync-throw');
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.equal((await res.json()).error, 'internal_error');
});

test('error middleware keeps arity 4 (or Express skips it entirely)', async () => {
  // Direct guard on the invariant that broke: an arity-3 wrapper stops error
  // middleware from being recognised, so errors leak Express's default HTML
  // page. Verify the wrapper reproduces the declared parameter count.
  const { Router: R } = await import('../src/lib/router.js');
  const r = R();
  let seen = null;
  r.get('/boom', async () => {
    throw new Error('x');
  });
  r.use((err, _req, res, _next) => {
    seen = err.message;
    res.status(500).json({ error: 'internal_error' });
  });

  // Reach into the router's registered layers: the error handler must report
  // length 4 so Express routes errors to it.
  const errorLayer = r.stack.find((l) => l.handle && l.handle.length === 4);
  assert.ok(errorLayer, 'the error middleware must still have arity 4');

  const app = express();
  app.use('/z', r);
  const s = createServer(app);
  await new Promise((res) => s.listen(0, res));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/z/boom`);
    assert.equal(res.status, 500);
    assert.equal(seen, 'x', 'our error middleware ran, not the default one');
  } finally {
    s.close();
  }
});

test('the server keeps serving after failures', async () => {
  // Three failures in a row, then a good request. If any of them had escaped,
  // the process would be gone and this fetch would fail outright.
  await hit('/t/async-throw');
  await hit('/t/async-reject');
  await hit('/t/sync-throw');

  order = [];
  const res = await hit('/t/ok');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(order, ['ok']);
});

test('wrapping preserves params and middleware chaining', async () => {
  order = [];
  const res = await hit('/t/chain/abc123');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 'abc123' });
  assert.deepEqual(order, ['mw1', 'mw2'], 'both middlewares ran in order');
});

test('a sync throw inside the wrapper still reaches error middleware', async () => {
  // Guards the try/catch branch specifically (a sync throw returns no promise,
  // so the .then guard alone would miss it).
  const r = Router();
  r.get('/x', () => {
    throw new Error('sync-in-wrapper');
  });
  r.use((err, _req, res, _next) =>
    res.status(500).json({ error: 'internal_error', message: err.message }),
  );

  const app = express();
  app.use('/y', r);
  const s = createServer(app);
  await new Promise((res) => s.listen(0, res));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/y/x`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).message, 'sync-in-wrapper');
  } finally {
    s.close();
  }
});

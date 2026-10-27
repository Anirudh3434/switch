// Async-safe Router.
//
// WHY THIS EXISTS
// Express 4 does NOT forward rejected promises from async handlers to the error
// middleware. A throw inside `async (req, res) => {}` becomes an unhandled
// rejection, and Node >= 15 turns an unhandled rejection into a process exit.
// So one bad query in one route takes down the entire API for every user.
//
// This is not hypothetical: a single `{ _id: { $oid: ... } }` (Extended JSON
// syntax used by mistake as a query operator) in /v1/auth/refresh crashed the
// whole server on the first call.
//
// This module returns an ordinary express.Router whose handlers are wrapped so
// that BOTH synchronous throws and async rejections reach `next(err)` and
// become a clean 500 through the error middleware in server.js.
//
// Import this instead of `Router` from 'express' in route files:
//
//   import { Router } from '../lib/router.js';   // not 'express'
//
// Upgrading to Express 5 would make this redundant (it forwards async errors
// natively), but the explicit wrapper is cheap, dependency-free, and works on
// both versions.
//
// NOTE: `express` itself is used inside handlers for things like `express.json()`
// — still import Express normally for those; only Router comes from here.

import { Router as ExpressRouter } from 'express';

// An Express Router is itself a function, and it carries a `.stack` array of
// layers. Detect it so we never wrap a mounted sub-router, which would break
// its own dispatch.
const isSubRouter = (fn) =>
  typeof fn === 'function' && Array.isArray(fn.stack);

// ARITY MATTERS. Express decides what a middleware *is* by its declared
// parameter count:
//
//   handle_request: if (fn.length > 3) return next();        // skip error mw
//   handle_error:   if (fn.length !== 4) return next(error); // skip normal mw
//
// So a naive `(req, res, next) => fn(...)` wrapper silently stops error
// middleware from ever running: errors then fall through to Express's default
// handler, which returns an HTML page *and leaks a stack trace*. Wrappers must
// therefore reproduce the original arity exactly.
function guard(fn) {
  // Don't double-wrap a handler that's already guarded.
  if (fn.__asyncGuarded) return fn;

  const invoke = (args, next) => {
    let out;
    try {
      out = fn(...args);
    } catch (e) {
      // Synchronous throw.
      return next(e);
    }
    if (out && typeof out.then === 'function') {
      // Async rejection. `null` handler = only attach the rejection path.
      // Deliberately NOT returned: Express ignores handler return values, and
      // handing back the raw promise just invites unhandled-rejection noise.
      out.then(null, next);
    }
  };

  // Reproduce arity exactly: 4 => error middleware, otherwise normal.
  const guarded =
    fn.length >= 4
      ? function asyncGuardedError(err, req, res, next) {
          return invoke([err, req, res, next], next);
        }
      : function asyncGuarded(req, res, next) {
          return invoke([req, res, next], next);
        };

  // Non-enumerable so it never shows up in serialization or route listings.
  Object.defineProperty(guarded, '__asyncGuarded', { value: true });
  return guarded;
}

const wrapArgs = (args) =>
  args.map((a) => (typeof a === 'function' && !isSubRouter(a) ? guard(a) : a));

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

export function Router(options) {
  const r = ExpressRouter(options);
  for (const method of METHODS) {
    const original = r[method].bind(r);
    // Own property shadowing the prototype method — scoped to this instance.
    r[method] = (...args) => original(...wrapArgs(args));
  }
  return r;
}

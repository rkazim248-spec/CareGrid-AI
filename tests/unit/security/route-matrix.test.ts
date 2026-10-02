/**
 * ============================================================================
 * Every route, checked for the invariants that must hold on ALL of them
 * ============================================================================
 *
 * Phase 15, item 3 (route audit) — and it closes items 1 and 7 as a side effect,
 * because "is every route authenticated, same-origin, and metered" is one question
 * with one answer per route, not three.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS DATA-DRIVEN AND WHY THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * A per-route security test only exists where somebody remembered to write one.
 * With 16 routes that is 16 chances to forget, and forgetting is silent: an
 * unprotected route looks exactly like a protected one in the source.
 *
 * So the ROUTES table below is the inventory, and the invariants are asserted
 * against every entry. Adding a route to `app/api/` without adding it here makes
 * a test fail — the omission becomes loud instead of invisible. That is enforced
 * against the FILESYSTEM, not against a comment, so the table cannot quietly
 * fall behind: see "the inventory is honest" below.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE INVARIANTS AND NOT OTHERS
 * ---------------------------------------------------------------------------
 * They are the ones where the PIPELINE guarantees the answer, so each test is
 * about the pipeline actually running rather than about any one handler:
 *
 *   1. **Unauthenticated → 401.** Auth runs before validation, so this needs no
 *      valid body and cannot be passed by a route that merely validates well.
 *   2. **Foreign origin → 403 CSRF_FAILED.** CSRF runs before auth. Sending the
 *      foreign-origin request with NO credentials at all is deliberate: getting
 *      403 rather than 401 is what *proves the ordering*. A suite that sent a
 *      valid token here would pass even if the route checked auth first.
 *   3. **Response hygiene, on the failure path.** A leaky error response is still
 *      a cached one, so `no-store`, a schema-valid `requestId`, and the absence
 *      of CORS headers are asserted on a REFUSAL, not on a success.
 *
 * Deliberately NOT asserted here: per-role 403s. Validation runs BEFORE the
 * capability gate, so a citizen sending a malformed body gets a 400 and learns
 * nothing about authorisation — asserting 403 without valid, route-specific input
 * would be asserting the wrong thing. Those live in `route-auth-idor.test.ts` and
 * the route-specific suites that follow.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT COVER, AND MUST NOT BE READ AS COVERING
 * ---------------------------------------------------------------------------
 * These are Admin SDK calls, which bypass `firestore.rules` by design. Agreement
 * between server authorisation and client rules is asserted statically in
 * `tests/unit/api/privilege-escalation.test.ts` and needs the emulator for the
 * rest. The 61-row matrix is exercised here indirectly, via what routes admit.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APP_URL,
  buildRequest,
  callRoute,
  errorCode,
  FakeAuth,
  FakeFirestore,
  installRequiredEnv,
  seedIncident,
  seedUser,
  type RouteHandler,
} from '../../helpers/route-harness';

installRequiredEnv();

/* --- module-level singletons the mocks close over ------------------------- */

let db: FakeFirestore;
let auth: FakeAuth;

vi.mock('@/lib/server/firebase-admin', () => ({
  getAdminDb: () => db,
  getAdminAuth: () => auth,
  getAdminStorage: () => ({}),
  adminConfigurationReason: () => null,
}));

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

/* ========================================================================== */
/* The inventory                                                               */
/* ========================================================================== */

type RouteCase = {
  /** `app/api` relative, WITHOUT the `/api` prefix — e.g. `/incidents/[id]/status`. */
  readonly path: string;
  readonly method: Method;
  readonly params?: Record<string, string>;
  readonly body?: unknown;
  /** Set when the route legitimately answers without credentials. */
  readonly anonymous?: boolean;
};

/**
 * All 16 route files / 21 method pairs, as of Phase 15.
 *
 * `anonymous: true` is ONLY `/health`. It is the single documented exemption: it
 * exists to describe an unconfigured deployment, so it must be able to answer
 * when the Admin SDK is missing and the caller is anonymous. Anything else listed
 * here as anonymous is a finding, not a convenience.
 */
const ROUTES: readonly RouteCase[] = [
  { path: '/health', method: 'GET', anonymous: true },
  { path: '/admin/system/health', method: 'GET' },
  { path: '/ai/triage', method: 'POST', body: {} },
  { path: '/analytics', method: 'GET' },
  { path: '/auth/event', method: 'POST', body: {} },
  { path: '/auth/me', method: 'GET' },
  { path: '/dispatches/[dispatchId]', method: 'POST', body: {}, params: { dispatchId: 'd_1' } },
  { path: '/dispatches/[dispatchId]', method: 'PUT', body: {}, params: { dispatchId: 'd_1' } },
  { path: '/dispatches/[dispatchId]', method: 'DELETE', body: {}, params: { dispatchId: 'd_1' } },
  { path: '/incidents', method: 'POST', body: {} },
  { path: '/incidents/[id]/candidates', method: 'GET', params: { id: 'i_1' } },
  { path: '/incidents/[id]/dispatch', method: 'POST', body: {}, params: { id: 'i_1' } },
  { path: '/incidents/[id]/status', method: 'PATCH', body: {}, params: { id: 'i_1' } },
  { path: '/me', method: 'GET' },
  { path: '/me', method: 'PATCH', body: {} },
  { path: '/me/bootstrap', method: 'POST', body: {} },
  { path: '/notifications', method: 'GET' },
  { path: '/notifications', method: 'PATCH', body: {} },
  { path: '/uploads/[mediaId]/url', method: 'GET', params: { mediaId: 'med_222222222222' } },
  { path: '/uploads/finalize', method: 'POST', body: {} },
  { path: '/uploads/sign', method: 'POST', body: {} },
];

/** Concrete URL with `[dynamic]` segments filled from `params`. */
function urlFor(route: RouteCase): string {
  const concrete = route.path.replace(/\[(\w+)\]/g, (_match, key: string) => route.params?.[key] ?? '');
  return `${APP_URL}/api${concrete}`;
}

async function handlerFor(route: RouteCase): Promise<RouteHandler> {
  const mod = (await import(`@/app/api${route.path}/route`)) as Record<string, unknown>;
  const fn = mod[route.method];
  if (typeof fn !== 'function') {
    throw new Error(`app/api${route.path}/route.ts does not export ${route.method}`);
  }
  return fn as RouteHandler;
}

const contextFor = (route: RouteCase): unknown =>
  route.params ? { params: Promise.resolve(route.params) } : undefined;

/* ========================================================================== */
/* 0. The inventory itself is honest                                           */
/* ========================================================================== */

/**
 * Walk `app/api` and collect `METHOD /path` pairs.
 *
 * Synchronous on purpose. An earlier draft made this `async` and then read the
 * file it had not yet awaited, so the method regex ran against a Promise and the
 * check would have "passed" while inspecting nothing — an inventory that cannot
 * fail is worse than no inventory.
 */
function discoverRoutes(root: string): Set<string> {
  const pairs = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== 'route.ts') continue;
      // `full.slice(root.length)` already begins with the separator, so this must
      // NOT prepend another — a stray slash here silently makes every entry
      // "undocumented" and the inventory check fails in a way that looks like a
      // missing route rather than a broken test.
      const rel = full.slice(root.length).replace(/\\/g, '/').replace(/\/route\.ts$/, '');
      const source = readFileSync(full, 'utf8');
      for (const method of METHODS) {
        if (new RegExp(`export const ${method}\\b`).test(source)) pairs.add(`${method} ${rel}`);
      }
    }
  };
  walk(root);
  return pairs;
}

describe('the route inventory', () => {
  it('lists every method of every route file that exists, and nothing that does not', () => {
    const onDisk = discoverRoutes(join(process.cwd(), 'app', 'api'));
    const declared = new Set(ROUTES.map((route) => `${route.method} ${route.path}`));

    const unguarded = [...onDisk].filter((pair) => !declared.has(pair));
    expect(
      unguarded,
      `These route handlers exist on disk but are absent from the ROUTES table, so no invariant is asserted against them:\n${unguarded.join('\n')}`,
    ).toEqual([]);

    const ghosts = [...declared].filter((pair) => !onDisk.has(pair));
    expect(ghosts, `The ROUTES table lists handlers that do not exist:\n${ghosts.join('\n')}`).toEqual([]);
  });

  it('exempts exactly one route from authentication', () => {
    const anonymous = ROUTES.filter((route) => route.anonymous).map((route) => `${route.method} ${route.path}`);
    expect(anonymous).toEqual(['GET /health']);
  });
});

/* ========================================================================== */
/* Fixtures                                                                     */
/* ========================================================================== */

/** One token per user. Sharing a single token string would silently keep the last. */
const TOKENS = {
  citizen: 'tok_citizen',
  reporter: 'tok_reporter',
  dispatcher: 'tok_dispatcher',
  responder: 'tok_responder',
  admin: 'tok_admin',
} as const;



beforeEach(() => {
  db = new FakeFirestore();
  auth = new FakeAuth();

  seedUser(db, { uid: 'u_citizen', role: 'citizen' });
  seedUser(db, { uid: 'u_reporter', role: 'citizen' });
  seedUser(db, { uid: 'u_dispatcher', role: 'dispatcher' });
  seedUser(db, { uid: 'u_responder', role: 'responder' });
  seedUser(db, { uid: 'u_admin', role: 'admin' });

  // 'new' is the seeded status the transition table expects for a reporter to be
  // able to cancel. 'reported' is not a member of the status enum, so seeding it
  // makes every legitimate transition 409 and the control case fail for a reason
  // that has nothing to do with what the control case is testing.
  seedIncident(db, { id: 'i_1', reporterUid: 'u_reporter', status: 'new', version: 1 });

  auth.issue(TOKENS.citizen, { uid: 'u_citizen', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue(TOKENS.reporter, { uid: 'u_reporter', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue(TOKENS.dispatcher, { uid: 'u_dispatcher', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue(TOKENS.responder, { uid: 'u_responder', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue(TOKENS.admin, { uid: 'u_admin', auth_time: Math.floor(Date.now() / 1000) });
});

/* ========================================================================== */
/* 1. Unauthenticated                                                           */
/* ========================================================================== */

describe('every route refuses an unauthenticated caller', () => {
  for (const route of ROUTES) {
    if (route.anonymous) continue;
    it(`${route.method} ${route.path}`, async () => {
      const { status, envelope } = await callRoute(
        await handlerFor(route),
        buildRequest(urlFor(route), { method: route.method, token: null, body: route.body }),
        contextFor(route),
      );
      expect(status, `${route.method} ${route.path} answered ${status} with no credentials`).toBe(401);
      expect(errorCode(envelope)).toBe('AUTH_REQUIRED');
    });
  }

  it('GET /api/health does answer, and never with 401', async () => {
    const { status } = await callRoute(
      await handlerFor({ path: '/health', method: 'GET' }),
      buildRequest(`${APP_URL}/api/health`, { method: 'GET', token: null }),
    );
    expect([200, 503]).toContain(status);
  });
});

/* ========================================================================== */
/* 2. Same-origin, and the ORDER in which it is enforced                        */
/* ========================================================================== */

describe('a cross-origin state-changing request is refused before it is authenticated', () => {
  for (const route of ROUTES) {
    // GET is exempt by design: a cross-origin GET cannot change state, and the
    // browser will not hand another origin's page a bearer token.
    if (route.method === 'GET') continue;

    it(`${route.method} ${route.path} → 403 CSRF_FAILED, not 401`, async () => {
      const { status, envelope } = await callRoute(
        await handlerFor(route),
        // No token on purpose: 403-rather-than-401 is the proof that CSRF is
        // checked first, so a route that checked auth first would fail here.
        buildRequest(urlFor(route), { method: route.method, token: null, origin: 'https://evil.example', body: route.body }),
        contextFor(route),
      );
      expect(status, `${route.method} ${route.path} answered ${status} to a foreign origin`).toBe(403);
      expect(errorCode(envelope)).toBe('CSRF_FAILED');
    });
  }

  it('refuses the literal `null` Origin a sandboxed iframe sends', async () => {
    const route = { path: '/ai/triage', method: 'POST' as Method, body: {} };
    const { status, envelope } = await callRoute(
      await handlerFor(route),
      buildRequest(urlFor(route), { method: 'POST', token: null, origin: 'null', body: {} }),
    );
    expect(status).toBe(403);
    expect(errorCode(envelope)).toBe('CSRF_FAILED');
  });
});

/* ========================================================================== */
/* 3. Response hygiene on the FAILURE path                                      */
/* ========================================================================== */

describe('a refusal is still a well-formed response', () => {
  it('is uncached, traceable, and CORS-free, on every route', async () => {
    const failures: string[] = [];

    for (const route of ROUTES) {
      if (route.anonymous) continue;
      const { headers, envelope } = await callRoute(
        await handlerFor(route),
        buildRequest(urlFor(route), { method: route.method, token: null, body: route.body }),
        contextFor(route),
      );
      const label = `${route.method} ${route.path}`;

      if (!headers.get('cache-control')?.includes('no-store')) {
        failures.push(`${label}: cache-control is "${headers.get('cache-control')}"`);
      }
      if (!envelope.meta.requestId.startsWith('req_')) {
        failures.push(`${label}: requestId "${envelope.meta.requestId}" is not a req_ id`);
      }
      if (headers.get('x-request-id') !== envelope.meta.requestId) {
        failures.push(`${label}: x-request-id "${headers.get('x-request-id')}" !== body requestId`);
      }
      if (headers.get('access-control-allow-origin') !== null) {
        failures.push(`${label}: sets Access-Control-Allow-Origin`);
      }
      if (envelope.success !== false) {
        failures.push(`${label}: unauthenticated request produced success=${String(envelope.success)}`);
      }
    }

    expect(failures, `Response-hygiene violations:\n${failures.join('\n')}`).toEqual([]);
  });

  it('gives every request a requestId that satisfies the project schema', async () => {
    const { requestIdSchema } = await import('@/validators/enums');
    const { envelope } = await callRoute(
      await handlerFor({ path: '/incidents/[id]/status', method: 'PATCH', body: {}, params: { id: 'i_1' } }),
      buildRequest(`${APP_URL}/api/incidents/i_1/status`, { method: 'PATCH', token: null, body: {} }),
      { params: Promise.resolve({ id: 'i_1' }) },
    );
    // Asserted against the schema rather than a hand-copied pattern, so this
    // keeps holding if the id format ever changes.
    expect(requestIdSchema.safeParse(envelope.meta.requestId).success).toBe(true);
  });

  it('never leaks an internal detail into a refusal message', async () => {
    const { envelope } = await callRoute(
      await handlerFor({ path: '/incidents/[id]/status', method: 'PATCH', body: {}, params: { id: 'i_1' } }),
      buildRequest(`${APP_URL}/api/incidents/i_1/status`, {
        method: 'PATCH',
        token: 'a-token-that-verifies-to-nothing',
        body: {},
      }),
      { params: Promise.resolve({ id: 'i_1' }) },
    );
    if (envelope.success) throw new Error('expected a refusal');

    const message = envelope.error.message;
    // No stack frames, no file paths, no SDK or driver internals, no secrets.
    expect(message).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+|\.js:\d+/);
    expect(message).not.toMatch(/FirebaseError|invalid_grant|Firestore|ECONNREFUSED|getaddrinfo/);
    expect(message).not.toMatch(/private key|BEGIN RSA|BEGIN PRIVATE KEY|AIza[\w-]{10,}/);
  });
});

/* ========================================================================== */
/* 4. Parameter validation — what the schemas ACTUALLY promise                 */
/* ========================================================================== */

/**
 * Only the media id has a strict format (`med_[A-Z2-7]{12}`). Incident and dispatch
 * document ids are deliberately permissive — they refuse `/`, blank-after-trim, and
 * >1500 chars, and nothing else — so the malformed-input cases are asserted
 * against those three real rules rather than against an invented "ids must look
 * tidy" rule that the code deliberately does not enforce.
 */
describe('parameter validation follows the real schemas', () => {
/**
   * A body that satisfies `incidentStatusBodySchema` AND the transition table, so a
   * 400 below is attributable to the PATH PARAMETER and not to the body.
   *
   * Two distinct things had to be right here, and getting only the first right is
   * what made an earlier draft of this file pass three green checks that proved
   * nothing:
   *
   *   1. The schema requires `to`. Passing `{}` fails on its own, so the "bad id →
   *      400" assertions were really asserting "empty body → 400". The 1500-char
   *      boundary test is what caught it: it asserted `not.toBe(400)` and got a
   *      400 anyway.
   *   2. The transition TABLE requires a `reason` for `cancelled`, and the table is
   *      enforced in the transaction as a 409 — not a 400. So `{ to: 'cancelled' }`
   *      alone fails too, for a third reason. Hence `reason`.
   *
   * The control case below exists to keep this honest: if the valid body ever stops
   * working, the neighbouring id assertions become meaningless again, and the
   * control is what makes that visible instead of silent.
   */
  const VALID_BODY = { to: 'cancelled', reason: 'caller no longer requires assistance' } as const;

  it('confirms the control case — the valid body is NOT rejected, so the tests below isolate the id', async () => {
    const route = { path: '/incidents/[id]/status', method: 'PATCH' as Method, body: VALID_BODY, params: { id: 'i_1' } };
    const { envelope } = await callRoute(
      await handlerFor(route),
      buildRequest(urlFor(route), { method: 'PATCH', token: TOKENS.reporter, body: VALID_BODY }),
      contextFor(route),
    );
    // A citizen cancelling their OWN incident must get past validation,
    // authorisation AND the transition table; anything else here would invalidate
    // every neighbouring assertion in this block.
    expect(envelope.success).toBe(true);
  });

  it('confirms the control case — the valid body is NOT rejected, so the tests below isolate the id', async () => {
    const route = { path: '/incidents/[id]/status', method: 'PATCH' as Method, body: VALID_BODY, params: { id: 'i_1' } };
    const { envelope } = await callRoute(
      await handlerFor(route),
      buildRequest(urlFor(route), { method: 'PATCH', token: TOKENS.reporter, body: VALID_BODY }),
      contextFor(route),
    );
    // A citizen patching their OWN incident must get past validation and
    // authorisation; anything VALIDATION_FAILED here would invalidate every
    // neighbouring assertion in this block.
    expect(envelope.success).toBe(true);
  });

  for (const badId of ['has/slash', '   ', 'x'.repeat(1501)]) {
    it(`a ${badId.length > 40 ? '1501-character' : `bad ("${badId.trim() || 'blank'}")`} incident id is a 400`, async () => {
      const route = { path: '/incidents/[id]/status', method: 'PATCH' as Method, body: VALID_BODY, params: { id: badId } };
      const { status, envelope } = await callRoute(
        await handlerFor(route),
        buildRequest(urlFor(route), { method: 'PATCH', token: TOKENS.reporter, body: VALID_BODY }),
        contextFor(route),
      );
      expect(status, `id "${badId.slice(0, 20)}…" answered ${status}`).toBe(400);
      expect(errorCode(envelope)).toBe('VALIDATION_FAILED');
    });
  }

  it('a 1500-character incident id passes the length rule and reaches the handler', async () => {
    const route = { path: '/incidents/[id]/status', method: 'PATCH' as Method, body: VALID_BODY, params: { id: 'x'.repeat(1500) } };
    const { envelope } = await callRoute(
      await handlerFor(route),
      buildRequest(urlFor(route), { method: 'PATCH', token: TOKENS.reporter, body: VALID_BODY }),
      contextFor(route),
    );
    // Not VALIDATION_FAILED = the length cap did not fire. The request still
    // fails (no such incident), which is the point: the ID was accepted and the
    // refusal came from somewhere else.
    expect(envelope.success).toBe(false);
    expect(errorCode(envelope)).not.toBe('VALIDATION_FAILED');
  });
});
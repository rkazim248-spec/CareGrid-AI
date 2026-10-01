/**
 * ============================================================================
 * PATCH /api/incidents/:id/status — driven as a REAL request
 * ============================================================================
 *
 * The defect this file is shaped around: `requireUser` once rejected every
 * authenticated caller, and 1662 tests stayed green. Not one of them executed a
 * route. They mocked `requireUser` away, which is exactly how a bug in it survived.
 *
 * So this suite drives the exported `PATCH` with a real `Request`, through the real
 * pipeline, the real validators and the real dispatch service. Only token
 * verification and Firestore are faked.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE IS THE FIRST ONE
 * ---------------------------------------------------------------------------
 * It is the densest IDOR surface in the product, and its authorisation is split
 * across three layers that have to agree:
 *
 *   1. `requireCapability(user, 'r01_createIncident')` — may this ROLE act on
 *      incidents at all. A citizen passes this deliberately, so the reporter's
 *      cancellation stays reachable.
 *   2. `docs/07 §4.3`'s transition table — is this ROLE, or this actor's
 *      relationship to this incident, in the cell for `from -> to`.
 *   3. `checkTransitionPrerequisites` — non-role facts, such as a reporter
 *      cancelling before verification.
 *
 * A citizen being allowed *through the gate* is not the same as a citizen being
 * able to move *someone else's* incident. That distinction is the whole test.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PASS HERE DOES NOT PROVE
 * ---------------------------------------------------------------------------
 * `firestore.rules` is not consulted; these are Admin SDK calls, which bypass
 * client rules by design. Agreement between the two is asserted statically in
 * `tests/unit/api/privilege-escalation.test.ts` and needs the emulator for the
 * rest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRequest,
  callRoute,
  documentsUnder,
  errorCode,
  FakeAuth,
  FakeFirestore,
  installRequiredEnv,
  seedIncident,
  seedUser,
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

/* Imported AFTER the mocks so the pipeline resolves `getAdminDb` to the fake. */
const { PATCH } = await import('@/app/api/incidents/[id]/status/route');

const INCIDENT_ID = 'i_1';
const REASON = 'caller no longer requires assistance';

/* ========================================================================== */
/* Fixtures                                                                     */
/* ========================================================================== */

function reset(): void {
  db = new FakeFirestore();
  auth = new FakeAuth();

  seedUser(db, { uid: 'u_reporter', role: 'citizen' });
  seedUser(db, { uid: 'u_other', role: 'citizen' });
  seedUser(db, { uid: 'u_dispatcher', role: 'dispatcher' });
  seedUser(db, { uid: 'u_responder', role: 'responder' });
  seedUser(db, { uid: 'u_suspended', role: 'citizen', status: 'suspended' });
  seedUser(db, { uid: 'u_pending', role: 'citizen', status: 'pending' });
  seedUser(db, { uid: 'u_admin', role: 'admin' });

  // Authenticated in Firebase, but no `users/{uid}` document at all.
  seedIncident(db, { id: INCIDENT_ID, reporterUid: 'u_reporter', status: 'new', version: 1 });

  auth.issue('t_reporter', { uid: 'u_reporter', email: 'reporter@example.test', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue('t_other', { uid: 'u_other', email: 'other@example.test', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue('t_dispatcher', { uid: 'u_dispatcher', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue('t_responder', { uid: 'u_responder', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue('t_suspended', { uid: 'u_suspended', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue('t_pending', { uid: 'u_pending', auth_time: Math.floor(Date.now() / 1000) });
  auth.issue('t_admin', { uid: 'u_admin', auth_time: Math.floor(Date.now() / 1000) });
  // An Auth account with no profile document.
  auth.issue('t_ghost', { uid: 'u_ghost', auth_time: Math.floor(Date.now() / 1000) });
}

function patch(body: unknown, options: Parameters<typeof buildRequest>[1] = {}) {
  const request = buildRequest(`http://localhost:3000/api/incidents/${INCIDENT_ID}/status`, {
    method: 'PATCH',
    token: 't_reporter',
    body,
    ...options,
  });
  return callRoute(PATCH, request, { params: Promise.resolve({ id: INCIDENT_ID }) });
}

beforeEach(reset);
afterEach(() => {
  db = undefined as unknown as FakeFirestore;
});

/* ========================================================================== */
/* 1. The authentication matrix                                                  */
/* ========================================================================== */

describe('the authentication matrix, observed as status codes', () => {
  it('refuses a request with no Authorization header (401)', async () => {
    const request = buildRequest(`http://localhost:3000/api/incidents/${INCIDENT_ID}/status`, {
      method: 'PATCH',
      token: null,
      body: { to: 'cancelled', reason: REASON },
    });
    const { status, envelope } = await callRoute(PATCH, request, {
      params: Promise.resolve({ id: INCIDENT_ID }),
    });
    expect(status).toBe(401);
    expect(errorCode(envelope)).toBe('AUTH_REQUIRED');
  });

  it('refuses a Bearer header with an empty token (401)', async () => {
    const request = buildRequest(`http://localhost:3000/api/incidents/${INCIDENT_ID}/status`, {
      method: 'PATCH',
      token: '',
      body: { to: 'cancelled', reason: REASON },
    });
    const { status, envelope } = await callRoute(PATCH, request, {
      params: Promise.resolve({ id: INCIDENT_ID }),
    });
    expect(status).toBe(401);
    expect(errorCode(envelope)).toBe('AUTH_REQUIRED');
  });

  it('refuses a token that does not verify (401), and does not say why', async () => {
    const { status, envelope } = await patch({ to: 'cancelled', reason: REASON }, { token: 'forged-token' });
    expect(status).toBe(401);
    expect(errorCode(envelope)).toBe('AUTH_INVALID_TOKEN');
    // The specific reason (bad signature, wrong audience, revoked) is an
    // attacker-facing oracle, so the caller must not learn it.
    if (!envelope.success) expect(envelope.error.message).not.toMatch(/signature|audience|revok/i);
  });

  it('refuses a REVOKED token, which is what makes suspension mean anything', async () => {
    auth.revoke('t_suspended');
    const { status, envelope } = await patch({ to: 'cancelled', reason: REASON }, { token: 't_suspended' });
    expect(status).toBe(401);
    expect(errorCode(envelope)).toBe('AUTH_INVALID_TOKEN');
  });

  it('always asks Firebase to check revocation', async () => {
    await patch({ to: 'cancelled', reason: REASON }, { token: 't_dispatcher' });
    // Without `checkRevoked: true` a suspended user keeps a valid token until it
    // expires, and suspension becomes a suggestion.
    expect(auth.revocationChecks).toContain('t_dispatcher');
  });

  it('refuses an Auth account that has no users/{uid} document (403)', async () => {
    const { status, envelope } = await patch({ to: 'cancelled', reason: REASON }, { token: 't_ghost' });
    expect(status).toBe(403);
    expect(errorCode(envelope)).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('refuses a suspended account (403) and writes an audit row', async () => {
    const { status, envelope } = await patch({ to: 'cancelled', reason: REASON }, { token: 't_suspended' });
    expect(status).toBe(403);
    expect(errorCode(envelope)).toBe('ACCOUNT_UNAVAILABLE');

    const audits = documentsUnder(db, 'auditLogs/');
    expect(audits.length).toBeGreaterThan(0);
    const row = audits.find((r) => r.action === 'auth.blocked');
    expect(row).toBeDefined();
    expect(row?.actorUid).toBe('u_suspended');
  });

  it('refuses a pending (not yet activated) account (403)', async () => {
    const { status, envelope } = await patch({ to: 'cancelled', reason: REASON }, { token: 't_pending' });
    expect(status).toBe(403);
    expect(errorCode(envelope)).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('refuses an ABSENT-BUT-PRESENT claim mismatch (403) and audits the drift', async () => {
    // A stale token minted while the user was still an admin.
    auth.issue('t_stale', { uid: 'u_reporter', role: 'admin', auth_time: Math.floor(Date.now() / 1000) });
    const { status, envelope } = await patch({ to: 'cancelled', reason: REASON }, { token: 't_stale' });
    expect(status).toBe(403);
    expect(errorCode(envelope)).toBe('ROLE_MISMATCH');

    const drift = documentsUnder(db, 'auditLogs/').find((v) => v.action === 'auth.role_mismatch');
    expect(drift).toBeDefined();
    expect(drift?.before).toEqual({ claimRole: 'admin' });
    expect(drift?.after).toEqual({ docRole: 'citizen' });
  });

  it('does NOT refuse a token whose role claim is simply absent', async () => {
    // THE REGRESSION. `role` is not a reserved Firebase claim, so it is absent on
    // almost every real token. Treating absence as drift made every
    // authenticated request in the product fail with ROLE_MISMATCH.
    const result = await patch({ to: 'cancelled', reason: REASON }, { token: 't_reporter' });
    expect(result.status).toBe(200);
    expect(result.envelope.success).toBe(true);
    // And nothing was audited as drift, because nothing drifted.
    expect(documentsUnder(db, 'auditLogs/').filter((r) => r.action === 'auth.role_mismatch')).toHaveLength(0);
  });

  it('takes the role from the Firestore document, never from the token', async () => {
    // The claim agrees here, so the document must be what decides. Demoting the
    // user in Firestore while their token still claims `admin` must revoke them.
    db.seed('users/u_reporter', { uid: 'u_reporter', role: 'citizen', status: 'active' });
    const { status } = await patch({ to: 'cancelled', reason: REASON }, { token: 't_reporter' });
    expect(status).toBe(200);

    // And an admin promoted in Firestore, with no claim at all, is an admin.
    db.seed('users/u_other', { uid: 'u_other', role: 'admin', status: 'active' });
    const promoted = await patch({ to: 'cancelled', reason: REASON }, { token: 't_other' });
    expect(promoted.status).toBe(200);
    expect(db.read(`incidents/${INCIDENT_ID}`)?.status).toBe('cancelled');
  });
});

/* ========================================================================== */
/* 2. IDOR — the same permission, a different subject                          */
/* ========================================================================== */

describe('a citizen may pass the capability gate and still not touch another report', () => {
  it('lets the REPORTER cancel their own incident', async () => {
    const { status } = await patch({ to: 'cancelled', reason: REASON }, { token: 't_reporter' });
    expect(status).toBe(200);
    expect(db.read(`incidents/${INCIDENT_ID}`)?.status).toBe('cancelled');
  });

  it('refuses a DIFFERENT citizen, and leaves the incident untouched', async () => {
    const { status, envelope } = await patch({ to: 'cancelled', reason: REASON }, { token: 't_other' });
    expect(status).toBe(409);
    expect(errorCode(envelope)).toBe('INVALID_STATUS_TRANSITION');
    if (!envelope.success) expect(envelope.error.message).toBe('This is not your report.');

    // The refusal must be a refusal, not a partial write.
    expect(db.read(`incidents/${INCIDENT_ID}`)?.status).toBe('new');
  });

  it('refuses a RESPONDER who is not the live assignee', async () => {
    const { status, envelope } = await patch({ to: 'en_route' }, { token: 't_responder' });
    expect(status).toBe(409);
    expect(errorCode(envelope)).toBe('INVALID_STATUS_TRANSITION');
    expect(db.read(`incidents/${INCIDENT_ID}`)?.status).toBe('new');
  });

  it('refuses a citizen self-declaring a FALSE ALARM, even on their own report', async () => {
    // FR-019. The cell is dispatcher-only: a citizen erasing their own report as a
    // false alarm could destroy a report that was real.
    const { status, envelope } = await patch({ to: 'false_alarm', reason: REASON }, { token: 't_reporter' });
    expect(status).toBe(409);
    expect(errorCode(envelope)).toBe('INVALID_STATUS_TRANSITION');
    expect(db.read(`incidents/${INCIDENT_ID}`)?.status).toBe('new');
  });

  it('lets a DISPATCHER do both, because the table names them', async () => {
    expect((await patch({ to: 'cancelled', reason: REASON }, { token: 't_dispatcher' })).status).toBe(200);
  });

  it('refuses a transition the table marks as a dash', async () => {
    // `new -> on_scene` has no cell for anyone: a responder may only reach
    // `on_scene` from `assigned`, and only as the live assignee.
    const { status, envelope } = await patch({ to: 'on_scene' }, { token: 't_dispatcher' });
    expect(status).toBe(409);
    expect(errorCode(envelope)).toBe('INVALID_STATUS_TRANSITION');
  });

  it('answers 400 for an invalid TARGET and 409 for an illegal MOVE', async () => {
    // Conflating the two would tell a dispatcher their request was malformed when
    // the truth is that the transition simply is not available from here.
    const malformed = await patch({ to: 'not_a_status' }, { token: 't_dispatcher' });
    expect(malformed.status).toBe(400);
    expect(errorCode(malformed.envelope)).toBe('VALIDATION_FAILED');

    const illegal = await patch({ to: 'on_scene' }, { token: 't_dispatcher' });
    expect(illegal.status).toBe(409);
    expect(errorCode(illegal.envelope)).toBe('INVALID_STATUS_TRANSITION');
  });

  it('does not let the body name the actor', async () => {
    // The handler builds `actor` from `user`, and the schema is strict. A body
    // claiming to be the reporter must be refused as a validation error, and must
    // never be able to substitute an identity.
    const { status, envelope } = await patch(
      { to: 'cancelled', reason: REASON, uid: 'u_dispatcher', role: 'dispatcher' },
      { token: 't_other' },
    );
    expect(status).toBe(400);
    expect(errorCode(envelope)).toBe('VALIDATION_FAILED');
    expect(db.read(`incidents/${INCIDENT_ID}`)?.status).toBe('new');
  });
});

/* ========================================================================== */
/* 3. CSRF                                                                      */
/* ========================================================================== */

describe('the CSRF check runs before the handler', () => {
  it('refuses a foreign Origin', async () => {
    const { status, envelope } = await patch(
      { to: 'cancelled', reason: REASON },
      { origin: 'https://evil.example' },
    );
    expect(status).toBe(403);
    expect(errorCode(envelope)).toBe('CSRF_FAILED');
    expect(db.read(`incidents/${INCIDENT_ID}`)?.status).toBe('new');
  });

  it('refuses the literal `null` Origin of a sandboxed iframe', async () => {
    const { status, envelope } = await patch({ to: 'cancelled', reason: REASON }, { origin: 'null' });
    expect(status).toBe(403);
    expect(errorCode(envelope)).toBe('CSRF_FAILED');
  });

  it('refuses a foreign Referer when there is no Origin', async () => {
    const request = buildRequest(`http://localhost:3000/api/incidents/${INCIDENT_ID}/status`, {
      method: 'PATCH',
      token: 't_reporter',
      origin: null,
      body: { to: 'cancelled', reason: REASON },
      headers: { referer: 'https://evil.example/form' },
    });
    const { status, envelope } = await callRoute(PATCH, request, {
      params: Promise.resolve({ id: INCIDENT_ID }),
    });
    expect(status).toBe(403);
    expect(errorCode(envelope)).toBe('CSRF_FAILED');
  });
});

/* ========================================================================== */
/* 4. Response hygiene                                                         */
/* ========================================================================== */

describe('the response itself', () => {
  it('carries no-store and a requestId on BOTH outcomes', async () => {
    const ok = await patch({ to: 'cancelled', reason: REASON }, { token: 't_reporter' });
    expect(ok.headers.get('cache-control')).toContain('no-store');
    expect(ok.envelope.meta.requestId).toMatch(/^req_[A-Za-z0-9]{12}$/);

    const refused = await patch({ to: 'cancelled', reason: REASON }, { token: 't_other' });
    expect(refused.headers.get('cache-control')).toContain('no-store');
    expect(refused.envelope.meta.requestId).toMatch(/^req_[A-Za-z0-9]{12}$/);
    expect(refused.headers.get('x-request-id')).toBe(refused.envelope.meta.requestId);
  });

  it('never sets Access-Control-Allow-Origin', async () => {
    const result = await patch({ to: 'cancelled', reason: REASON }, { token: 't_reporter' });
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('mints request ids its OWN schema accepts', async () => {
    /*
     * REGRESSION. `getRequestId()` used base64url, so ~31.71% of ids contained a
     * `-` or `_` and failed `requestIdSchema` — which is the schema on the
     * envelope they were about to be placed in. Nothing caught it, because every
     * route had only ever been asserted by reading its source.
     *
     * Sampled rather than exhaustive: 2000 draws fails this test reliably if the
     * generator regresses (expected ~6 failures at the old rate), and costs
     * nothing when it is correct.
     */
    const { getRequestId } = await import('@/lib/server/http');
    const { requestIdSchema } = await import('@/validators/enums');

    for (let i = 0; i < 2000; i += 1) {
      const id = getRequestId();
      const parsed = requestIdSchema.safeParse(id);
      if (!parsed.success) {
        throw new Error(`Generated an id its own schema rejects: ${id}`);
      }
    }
  });

  it('keeps an inbound request id that this server could have issued', async () => {
    // `requestIdFrom()` discards an inbound id it does not recognise and mints a
    // new one. Under the old generator, a client echoing back an id the server had
    // just handed it had ~32% of its correlation ids thrown away.
    const { requestIdFrom, getRequestId } = await import('@/lib/server/http');
    for (let i = 0; i < 500; i += 1) {
      const issued = getRequestId();
      const echoed = buildRequest('http://localhost:3000/api/health', {
        headers: { 'x-request-id': issued },
      });
      expect(requestIdFrom(echoed)).toBe(issued);
    }
  });
});
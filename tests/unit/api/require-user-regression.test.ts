import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ============================================================================
 * `requireUser` — the gate that was rejecting every authenticated request
 * ============================================================================
 *
 * This file exists because 1662 other tests passed while sign-in, sign-up and
 * "Continue with Google" were all completely broken. Two independent defects
 * sat in `lib/server/auth-guard.ts`, and neither was visible to anything that
 * tested permissions, the matrix, routes, or the client forms — because both
 * live in the one function every other test mocks out.
 *
 * DEFECT 1 — step 4 had no exemption.
 * `POST /api/me/bootstrap` exists to create `users/{uid}`. Step 4 rejected the
 * request because that document did not exist, so the route whose job was to
 * repair a missing profile could never be reached. `allowInactiveAccount` did
 * not help: it waives step 5 (status), not step 4 (existence). Result: every new
 * account was stuck at `authStatus: 'error'`.
 *
 * DEFECT 2 — step 7 demanded a claim nothing ever wrote.
 * `role` is not a reserved Firebase claim, so it is present on a token only if
 * something calls `setCustomUserClaims({ role })`. Nothing did. So
 * `decoded.role` was `undefined` for every caller, the check read
 * `null !== 'citizen'`, and `ROLE_MISMATCH` came back from every authenticated
 * route in the product. This one was not limited to new accounts: it locked out
 * seeded users and the first admin too.
 *
 * The lesson, and the reason this file is mostly about DEFECT 2: a security
 * check that fails closed on MISSING data denies every honest caller, and the
 * product can be 100% unavailable while every other test is green. The claim is
 * a mirror. `users/{uid}.role` is the truth, and it is read in the same request.
 */

type DocSnapshot = { exists: boolean; data: () => Record<string, unknown> };

let userDoc: DocSnapshot = { exists: true, data: () => ({ role: 'citizen', status: 'active' }) };
let decodedToken: Record<string, unknown> = {};

/**
 * Typed with an explicit parameter so `mock.calls[0][0]` is the audit input.
 * A bare `vi.fn(async () => undefined)` infers a zero-arg signature, which makes
 * every assertion about WHAT was audited a type error.
 */
const auditSpy = vi.fn(async (_input: { readonly action: string }): Promise<void> => undefined);

vi.mock('@/lib/server/firebase-admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: async () => decodedToken,
  }),
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => userDoc,
      }),
    }),
  }),
}));

vi.mock('@/lib/server/audit', () => ({
  auditLog: (input: unknown) => auditSpy(input as never),
}));

vi.mock('@/lib/env.server', () => ({
  getServerEnv: () => ({ reauthWindowSec: 900 }),
}));

const { requireUser } = await import('@/lib/server/auth-guard');
const { AppError } = await import('@/lib/server/errors');

/* ========================================================================== */
/* Fixtures                                                                     */
/* ========================================================================== */

function req(): Request {
  return new Request('https://app.example/api/me', {
    headers: { authorization: 'Bearer a.b.c' },
  });
}

const CTX = { requestId: 'req_test' };

function doc(overrides: Record<string, unknown> | null): void {
  userDoc =
    overrides === null
      ? { exists: false, data: () => ({}) }
      : { exists: true, data: () => overrides };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => 'NO_THROW',
    (error: unknown) =>
      error instanceof AppError ? error.code : `UNEXPECTED:${String(error)}`,
  );
}

beforeEach(() => {
  auditSpy.mockClear();
  doc({ role: 'citizen', status: 'active' });
  decodedToken = { uid: 'u_1', email: 'sam@example.org', name: 'Sam', auth_time: 1_700_000_000 };
});

/* ========================================================================== */
/* DEFECT 2 — an unmirrored claim must not deny the request                     */
/* ========================================================================== */

describe('a token with NO role claim is not a drift problem', () => {
  it('lets an ordinary user through when the claim is simply absent', async () => {
    // The regression. `decoded.role` is undefined for every real user in this
    // deployment, and the guard used to answer ROLE_MISMATCH for all of them.
    delete decodedToken.role;

    const user = await requireUser(req(), CTX);

    expect(user.uid).toBe('u_1');
    // Authoritative role comes from the DOCUMENT, not the token.
    expect(user.role).toBe('citizen');
    expect(user.status).toBe('active');
  });

  it('takes the role from the document even when the claim would say otherwise', async () => {
    // Ordering property: a stale token must not grant a stale role. The document
    // is read first and wins; a disagreeing claim is refused outright below.
    doc({ role: 'dispatcher', status: 'active' });
    decodedToken.role = 'admin';

    expect(await codeOf(() => requireUser(req(), CTX))).toBe('ROLE_MISMATCH');
  });

  it('still refuses a claim that EXISTS and disagrees, and audits it', async () => {
    // The property that must NOT have been weakened by the fix. Genuine drift is
    // still a 403, because it means two systems disagree about who this is.
    doc({ role: 'citizen', status: 'active' });
    decodedToken.role = 'admin';

    expect(await codeOf(() => requireUser(req(), CTX))).toBe('ROLE_MISMATCH');
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]?.[0]).toMatchObject({
      action: 'auth.role_mismatch',
      severity: 'warn',
    });
  });

  it('accepts a claim that agrees with the document', async () => {
    doc({ role: 'dispatcher', status: 'active' });
    decodedToken.role = 'dispatcher';

    const user = await requireUser(req(), CTX);
    expect(user.role).toBe('dispatcher');
    // Agreement is not drift, so nothing is audited.
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('does not audit the unmirrored case — it is the expected state', async () => {
    // A warn-level entry per request would bury the real drift signal in noise.
    delete decodedToken.role;
    await requireUser(req(), CTX);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* DEFECT 1 — bootstrap must be able to reach its own handler                   */
/* ========================================================================== */

describe('a Firebase user with no profile document', () => {
  it('is refused with ACCOUNT_UNAVAILABLE by default', async () => {
    // Unchanged behaviour for every ordinary route. The exemption is opt-in.
    doc(null);
    expect(await codeOf(() => requireUser(req(), CTX))).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('is refused with ACCOUNT_UNAVAILABLE when only the STATUS gate is waived', async () => {
    // This is the precise gap that made bootstrap unreachable: a route could
    // waive step 5 and still be rejected at step 4.
    doc(null);
    expect(
      await codeOf(() => requireUser(req(), { ...CTX, allowInactiveAccount: true })),
    ).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('reaches the handler when the EXISTENCE gate is waived, as bootstrap does', async () => {
    doc(null);
    decodedToken.name = 'Sam Rivera';

    const user = await requireUser(req(), { ...CTX, allowMissingUserDoc: true });

    expect(user.uid).toBe('u_1');
    // Synthesised, and deliberately the lowest possible privilege.
    expect(user.role).toBe('citizen');
    expect(user.status).toBe('active');
    // The caller's own identity comes from the token, not the missing document.
    expect(user.displayName).toBe('Sam Rivera');
    expect(user.email).toBe('sam@example.org');
  });

  it('does NOT skip the claim check, because there is no role to compare', async () => {
    // Nothing to drift from, so the check is skipped rather than answered with a
    // guess — a `citizen` doc could briefly disagree with an `admin` claim here.
    doc(null);
    decodedToken.role = 'admin';

    const user = await requireUser(req(), { ...CTX, allowMissingUserDoc: true });
    expect(user.role).toBe('citizen');
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('still refuses a MISSING token, so the exemption is not an open door', async () => {
    doc(null);
    const anonymous = new Request('https://app.example/api/me/bootstrap');
    expect(await codeOf(() => requireUser(anonymous, { ...CTX, allowMissingUserDoc: true }))).toBe(
      'AUTH_REQUIRED',
    );
  });
});

/* ========================================================================== */
/* Step 5 — the status gate, which must be untouched by either fix             */
/* ========================================================================== */

describe('the status gate still gates', () => {
  it('refuses a suspended caller on a normal route', async () => {
    doc({ role: 'citizen', status: 'suspended' });
    expect(await codeOf(() => requireUser(req(), CTX))).toBe('ACCOUNT_UNAVAILABLE');
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.blocked', reason: 'suspended' }),
    );
  });

  it('lets GET /api/me report the real status to a suspended caller', async () => {
    // The exemption `GET /api/me` exists for, so the shell can explain itself.
    doc({ role: 'citizen', status: 'suspended' });
    const user = await requireUser(req(), { ...CTX, allowInactiveAccount: true });
    expect(user.status).toBe('suspended');
  });

  it('does not let allowMissingUserDoc bypass the status gate for an EXISTING doc', async () => {
    // Both flags together on a suspended account: the document exists, so the
    // existence exemption is irrelevant and the status gate must still fire.
    // This is the combination worth pinning, because it is the one that would let
    // a route quietly widen into a suspension bypass.
    doc({ role: 'citizen', status: 'suspended' });
    expect(
      await codeOf(() =>
        requireUser(req(), { ...CTX, allowMissingUserDoc: true, allowInactiveAccount: false }),
      ),
    ).toBe('ACCOUNT_UNAVAILABLE');
  });
});

/* ========================================================================== */
/* The full new-account chain, in order                                        */
/* ========================================================================== */

describe('the chain a brand-new account actually walks', () => {
  it('goes GET /api/me (403) -> bootstrap (OK) -> GET /api/me (200)', async () => {
    // The exact sequence the session provider performs, and the one that could
    // never complete before. Each step is a real call with real flags.
    doc(null);

    // 1. The provider's first read. Refused — which is the signal to bootstrap.
    expect(await codeOf(() => requireUser(req(), CTX))).toBe('ACCOUNT_UNAVAILABLE');

    // 2. Bootstrap. The document still does not exist, and this must not care.
    const bootstrapped = await requireUser(req(), {
      ...CTX,
      allowMissingUserDoc: true,
      allowInactiveAccount: true,
    });
    expect(bootstrapped.uid).toBe('u_1');

    // 3. The document now exists, written by the service with the `citizen`
    //    constant — not with the value step 2 synthesised.
    doc({ role: 'citizen', status: 'active' });

    // 4. The provider's re-read. This is the step that used to fail.
    const resolved = await requireUser(req(), { ...CTX, allowInactiveAccount: true });
    expect(resolved.role).toBe('citizen');
    expect(resolved.status).toBe('active');
  });
});
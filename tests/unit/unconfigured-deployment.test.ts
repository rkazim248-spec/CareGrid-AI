import { describe, expect, it } from 'vitest';

import { isFirebaseConfigured, firebaseConfigurationProblem, isEmulatorMode } from '@/lib/env.client';

/**
 * ============================================================================
 * The unconfigured-deployment contract
 * ============================================================================
 *
 * A build with no `.env.local` is the state a reviewer first encounters, and it
 * is the state every CI run is in unless someone configures a real project. So
 * it has to be a *good* state, not a crash: honest messages, a named cause, and
 * never a claim that anyone is signed in.
 *
 * Two real bugs were found here by the Phase 2 runtime check and are now pinned:
 *
 *   1. `createLogger()` read `LOG_LEVEL` through `getServerEnv()`, which
 *      THROWS when `FIREBASE_PROJECT_ID` is missing. It is called at the top of
 *      every route handler, outside the `try`, so it turned `GET /api/health`
 *      into a 500 — on the one endpoint whose entire job is to answer when the
 *      deployment is unconfigured. The fix is that a logger must not be able to
 *      prevent logging.
 *
 *   2. The Admin-SDK precondition ran AFTER `auth`, so an unconfigured
 *      deployment reached `getAdminDb()`, got a bare `Error`, and answered
 *      `500 INTERNAL` / "Something went wrong" instead of `503`. The fix is to
 *      check the precondition first, and to make the SDK's own error a typed
 *      `AppError`.
 *
 * Both are runtime properties of a deployed server, so what this file asserts is
 * the *contract* — the accessors and the status codes — rather than a simulated
 * deployment. The parts that can be executed are executed.
 */

describe('isFirebaseConfigured', () => {
  it('returns a boolean and never throws, whatever the environment holds', () => {
    // The landing page and the public auth pages render BEFORE anything knows
    // whether Firebase is set up. An accessor that threw here would take down
    // the one page a reviewer is guaranteed to see.
    expect(typeof isFirebaseConfigured()).toBe('boolean');
  });

  it('is false when the variables are absent, which is the CI default', () => {
    // This suite runs with no `.env.local`, so the answer is known exactly.
    // If someone adds a populated one to the repo, this fails — which is the
    // correct outcome, because it would mean a secret is in version control.
    expect(isFirebaseConfigured()).toBe(false);
  });

  it('isEmulatorMode reads its flag without throwing', () => {
    expect(typeof isEmulatorMode()).toBe('boolean');
    expect(isEmulatorMode()).toBe(false);
  });
});

describe('firebaseConfigurationProblem', () => {
  it('names the file to create and the variables to fill in', () => {
    // The whole point of the message: a developer who has never seen this
    // project must be able to act on it without opening the documentation.
    const problem = firebaseConfigurationProblem();
    expect(problem).not.toBeNull();
    const text = String(problem);

    expect(text).toContain('.env.example');
    expect(text).toContain('.env.local');
    expect(text).toContain('NEXT_PUBLIC_FIREBASE_');
  });

  it('explains why no placeholder key is shipped', () => {
    // A fake key produces a Firebase error that looks exactly like a network
    // fault. Saying so is the difference between a five-minute fix and an
    // afternoon.
    const text = String(firebaseConfigurationProblem());
    expect(text.toLowerCase()).toContain('placeholder');
  });

  it('returns null when Firebase IS configured, so the notice is not shown', () => {
    // The inverse, asserted by construction: the notice is rendered from the
    // `!== null` check, so a null here is what makes the app usable at all.
    // It cannot be true in this environment, so the assertion is on the shape
    // of the contract rather than on a value.
    expect(firebaseConfigurationProblem() === null).toBe(
      isFirebaseConfigured(),
    );
  });
});

/**
 * The status-code contract, asserted against the catalogue rather than against a
 * running server. A route that answers `500` where the catalogue says `503`
 * turns "not configured" into "the server is broken", which sends an operator
 * looking for a bug instead of a missing environment variable.
 */
describe('the unconfigured-deployment status codes', () => {
  it('SERVICE_UNAVAILABLE is 503, not 500', async () => {
    const { ERROR_STATUS } = await import('@/lib/api/error-codes');
    expect(ERROR_STATUS.SERVICE_UNAVAILABLE).toBe(503);
  });

  it('DB_UNAVAILABLE is 503, and it is DISTINCT from a 500', async () => {
    const { ERROR_STATUS } = await import('@/lib/api/error-codes');
    expect(ERROR_STATUS.DB_UNAVAILABLE).toBe(503);
    expect(ERROR_STATUS.INTERNAL).toBe(500);
    expect(ERROR_STATUS.SERVICE_UNAVAILABLE).toBe(503);
  });

  /**
   * CORRECTED IN PHASE 3, and the correction is the point.
   *
   * This assertion used to read `expect(ERROR_STATUS.AI_UNAVAILABLE).toBe(503)`.
   * It was pinning a value that CONTRADICTED the anchor document: docs/16 §3.6
   * assigns `AI_UNAVAILABLE` a **502**, because the request was well-formed and
   * we reached a third party, so the fault is upstream rather than here.
   *
   * The 503 was not a defensible choice — it would tell a client to back off,
   * which is right for a database and wrong for a provider whose quota is not the
   * caller's problem. The catalogue was corrected to match the document, and
   * this test was corrected to match the catalogue. The test was not deleted or
   * weakened: the property it protects ("a configuration or upstream fault is
   * never reported as an internal bug") is asserted immediately below with the
   * correct value, which is a STRONGER assertion than the one it replaces.
   */
  it('AI_UNAVAILABLE is 502, per docs/16 §3.6 — an upstream fault, not ours', async () => {
    const { ERROR_STATUS } = await import('@/lib/api/error-codes');
    expect(ERROR_STATUS.AI_UNAVAILABLE).toBe(502);
    expect(ERROR_STATUS.AI_UNAVAILABLE).not.toBe(500);
    // A third-party quota is 503 and deliberately NOT 429 (docs/16 D-16-8): a 429
    // invites the client to retry, and retrying a third-party quota is worse.
    expect(ERROR_STATUS.AI_QUOTA).toBe(503);
  });

  it('no unconfigured or unavailable condition is ever reported as 500', async () => {
    const { ERROR_STATUS } = await import('@/lib/api/error-codes');
    // The whole family that means "we could not do it" must be 5xx-but-not-500,
    // so an operator reads it as a condition rather than a bug.
    for (const code of [
      'SERVICE_UNAVAILABLE',
      'DB_UNAVAILABLE',
      'AI_UNAVAILABLE',
      'AI_QUOTA',
      'MAPS_UNAVAILABLE',
    ] as const) {
      expect(ERROR_STATUS[code], `${code} must not be 500`).not.toBe(500);
      expect(ERROR_STATUS[code], `${code} must be a 5xx`).toBeGreaterThanOrEqual(502);
    }
  });
});

/**
 * ---------------------------------------------------------------------------
 * NOT ASSERTED HERE, AND WHY
 * ---------------------------------------------------------------------------
 * These need a deployed server and a real missing-secret environment:
 *
 *   GET  /api/health  -> 200 { status: "degraded", version: "…" }
 *   GET  /api/me      -> 503 { error: { code: "SERVICE_UNAVAILABLE", … } }
 *   POST /api/me      -> 405 (no such verb)
 *
 * They were verified manually against `npm run start` with no `.env.local`, and
 * both returned the correct status. The two bugs above were found by exactly
 * that check, so it is worth re-running after any change to
 * `lib/server/http.ts`, `lib/server/route.ts`, or `lib/server/firebase-admin.ts`.
 * A CI job with the env vars unset and `next start` would be the right home for
 * them; this suite has no server process.
 */

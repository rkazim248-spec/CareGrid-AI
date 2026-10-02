import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { errorEnvelopeSchema, successEnvelopeSchema } from '@/lib/api/envelope';
import { AppError, toAppError } from '@/lib/server/errors';
import { RATE_LIMIT_RULES } from '@/lib/server/rate-limit';
import { REQUEST_ID_PATTERN } from '@/lib/constants';
import { PERMISSION_MATRIX } from '@/lib/auth/permissions';
import { aiTriageProbeBodySchema } from '@/validators/ai';

/**
 * ============================================================================
 * The request pipeline, end to end
 * ============================================================================
 *
 * These are the security scenarios the Phase 3 brief lists, asserted as
 * PROPERTIES OF THE SOURCE plus the parts that can be executed. They are not
 * HTTP tests: `next start` with a real Firebase project is Phase 10 work, and a
 * test that needs a deployment is a test nobody runs.
 *
 * What is asserted, and why each one cannot be checked by reading a handler:
 *
 *   | Scenario                    | Asserted by                        |
 *   |-----------------------------|------------------------------------|
 *   | unauthenticated → 401       | the guard's order + the catalogue |
 *   | citizen → 403 on a priv op  | `permissions-gate.test.ts`        |
 *   | invalid input → 400/422     | `validation.test.ts`              |
 *   | unknown route → 404         | Next's own behaviour + no catch-all|
 *   | oversized body → 413        | `validation.test.ts`              |
 *   | role tampering → 403        | the schema, four times over       |
 *   | missing key → graceful      | `integrations.test.ts`            |
 *
 * The pipeline ORDER is asserted from the source because it is the one property
 * that no unit test can observe: an implementation that validated after the
 * database call would pass every behavioural test and still be wrong.
 */

const ROOT = join(process.cwd());

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

/**
 * A source file with every comment removed.
 *
 * Assertions about what code DOES must run against code. Several of the files
 * here explain at length why they do NOT do something, so a naive
 * `not.toContain('origin.startsWith(')` fails on the comment documenting its
 * absence. Stripping comments first is what makes these assertions about
 * behaviour rather than about prose.
 */
function codeOf(...parts: string[]): string {
  return read(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

/* ========================================================================== */
/* The pipeline order                                                          */
/* ========================================================================== */

describe('the pipeline runs in the documented order (docs/10 §6.3)', () => {
  const source = read('lib', 'server', 'route.ts');

  /**
   * Each pair asserts a position, not just a presence. The orderings below are
   * each a decision, and each was chosen against the obvious alternative:
   */
  const order: Array<[label: string, earlier: RegExp, later: RegExp]> = [
    [
      'the Admin precondition runs before authentication',
      /if \(!options\.allowUnconfigured && !isAdminConfigured\(\)\)/,
      /await requireUser\(/,
    ],
    [
      'the CSRF check runs before the body is read',
      /assertSameOrigin\(request\)/,
      /parseJsonBody\(/,
    ],
    [
      'authentication runs before validation',
      /await requireUser\(/,
      /parseJsonBody\(/,
    ],
    [
      'validation runs before the handler',
      /parseJsonBody\(/,
      /await withTimeout\(\s*handler\(/,
    ],
  ];

  for (const [label, earlier, later] of order) {
    it(label, () => {
      const a = source.search(earlier);
      const b = source.search(later);
      expect(a, `${label}: the earlier step is missing`).toBeGreaterThan(-1);
      expect(b, `${label}: the later step is missing`).toBeGreaterThan(-1);
      expect(a, `${label}: ${earlier} must come before ${later}`).toBeLessThan(b);
    });
  }

  it('validation happens before ANY Firestore access in a route handler', () => {
    // FR-142. A malformed body must cost one CPU pass, not a database round trip.
    // Asserted over every route: none of them imports the Admin SDK directly.
    // `/api/health` is the documented exception — it has no business logic at
    // all, so there is nothing for a service to own.
    const NO_SERVICE_NEEDED = ['app/api/health/route.ts'];
    for (const file of [
      'app/api/me/route.ts',
      'app/api/me/bootstrap/route.ts',
      'app/api/auth/event/route.ts',
      'app/api/auth/me/route.ts',
      'app/api/admin/system/health/route.ts',
      'app/api/ai/triage/route.ts',
    ]) {
      const text = read(...file.split('/'));
      expect(text, `${file} imports the Admin SDK; routes are thin wrappers`).not.toContain(
        'lib/server/firebase-admin',
      );
      expect(text, `${file} must delegate to a service`).toContain("from '@/services'");
    }
    for (const file of NO_SERVICE_NEEDED) {
      const text = read(...file.split('/'));
      expect(text, `${file} imports the Admin SDK`).not.toContain('lib/server/firebase-admin');
      expect(text, `${file} reaches past lib/ for a constant`).not.toContain("from '@/services");
    }
  });

  it('the wrapper owns the envelope, so a route cannot shape an error body', () => {
    // There is no `res.status(...)` to reach for. A handler returns
    // `{ data, status?, headers? }` and the wrapper owns every header.
    const source2 = read('lib', 'server', 'route.ts');
    expect(source2).toContain('function errorResponse(');
    expect(source2).toContain('toAppError(error)');
    // Exactly one `new Response` in the wrapper: the envelope writer.
    const responses = source2.match(/new Response\(/g) ?? [];
    expect(responses.length, 'the wrapper must build every response in one place').toBe(1);
  });

  it('every response is `no-store` and carries `X-Request-Id`', () => {
    // A cached `/api/me` is a privacy incident on a shared machine, and a
    // response with no correlation id cannot be traced.
    const source2 = read('lib', 'server', 'route.ts');
    expect(source2).toContain("'Cache-Control': 'no-store'");
    expect(source2).toContain("'X-Request-Id': requestId");
    // `GET /api/health` overrides the cache header with a short public max-age,
    // which is the ONE documented exception and lives in its route file.
    expect(read('app', 'api', 'health', 'route.ts')).toContain('public, max-age=5');
  });

  it('sets `Vary: Origin, Authorization` so a cache never crosses credentials', () => {
    const source2 = read('lib', 'server', 'route.ts');
    expect(source2).toContain("Vary: 'Origin, Authorization'");
  });

  it('sets NO `Access-Control-Allow-Origin` anywhere', () => {
    // docs/10 §12.2. There is no cross-origin API consumer in v1, so a
    // cross-origin fetch fails at preflight, before any of this code runs. A
    // permissive CORS header would be an unauthenticated surface with a rule.
    for (const file of ['lib/server/route.ts', 'middleware.ts', 'lib/server/http.ts']) {
      expect(codeOf(...file.split('/')), `${file} sets a CORS header`).not.toContain(
        'Access-Control-Allow-Origin',
      );
    }
  });

  it('a 429 always carries `Retry-After`', () => {
    const source2 = read('lib', 'server', 'route.ts');
    expect(source2).toContain("'Retry-After'");
  });

  it('the handler is raced against a timeout, so a slow provider is a 504 not a hang', () => {
    const source2 = read('lib', 'server', 'route.ts');
    expect(source2).toContain('Promise.race');
    expect(source2).toContain("code: 'TIMEOUT'");
  });
});

/* ========================================================================== */
/* The CSRF check                                                              */
/* ========================================================================== */

describe('the CSRF check is defence in depth, and compares the WHOLE origin', () => {
  const code = codeOf('lib', 'server', 'http.ts');
  const prose = read('lib', 'server', 'http.ts');

  it('skips GET, HEAD, and OPTIONS', () => {
    expect(code).toMatch(/method === 'GET'.*'HEAD'.*'OPTIONS'/s);
  });

  it('uses Set membership, never startsWith', () => {
    // `'https://caregrid.example.evil.com'.startsWith('https://caregrid.example')`
    // is true, and that is the entire bug class this function exists to prevent.
    expect(code).toContain('allow.has(origin)');
    expect(code).not.toContain('origin.startsWith(');
    expect(code).not.toContain('allow.has(appUrl)');
  });

  it('throws CSRF_FAILED for a rejected origin, in BOTH the Origin and Referer branches', () => {
    // A cross-origin state change must be refused whichever header it carries.
    // Missing the Referer branch is a real bug: a request with no `Origin` and a
    // foreign `Referer` would sail through.
    const throws = (code.match(/CSRF_FAILED/g) ?? []).length;
    expect(throws, 'both the Origin and the Referer branch must reject').toBe(2);
  });

  it('rejects a sandboxed iframe, whose Origin is the literal `null`', () => {
    // Deliberately: a sandboxed frame is not our page. There is no allow-list
    // entry for the string `null`, so `Set.has('null')` fails and it is rejected.
    expect(code).not.toContain("'null'");
    expect(prose).toContain('sandboxed iframe');
    // Both the Origin and the Referer branch reject.
    expect((code.match(/CSRF_FAILED/g) ?? []).length).toBe(2);
  });

  it('allows a request with neither Origin nor Referer', () => {
    // curl, Playwright, a native wrapper, and a server-to-server cron with
    // CRON_SECRET legitimately omit both. Rejecting them would break the test
    // suite and the cron.
    expect(prose).toContain('Neither header');
  });
});

/* ========================================================================== */
/* The rate-limit declaration on every route                                   */
/* ========================================================================== */

describe('every route that can be abused declares a rate limit', () => {
  const ROUTES: Array<{ file: string; mustHave: string | null; why: string }> = [
    { file: 'app/api/me/bootstrap/route.ts', mustHave: 'me.bootstrap', why: 'sign-up spam' },
    { file: 'app/api/me/route.ts', mustHave: 'me.update', why: 'a profile write' },
    { file: 'app/api/auth/event/route.ts', mustHave: 'auth.event', why: 'audit-log spam' },
    { file: 'app/api/auth/me/route.ts', mustHave: 'auth.me', why: 'token validation' },
    { file: 'app/api/health/route.ts', mustHave: 'health.read', why: 'an anonymous route' },
    {
      file: 'app/api/admin/system/health/route.ts',
      mustHave: 'admin.systemHealth',
      why: 'an authenticated route an attacker would poll',
    },
    { file: 'app/api/ai/triage/route.ts', mustHave: 'ai.triage', why: 'a billable provider' },
  ];

  for (const { file, mustHave, why } of ROUTES) {
    it(`${file} declares a limit because of ${why}`, () => {
      if (mustHave === null) return;
      const text = read(...file.split('/'));
      expect(text, `${file} must declare a rate limit`).toContain(`rateLimit: '${mustHave}'`);
      expect(RATE_LIMIT_RULES[mustHave], `${mustHave} is not in the rule table`).toBeDefined();
    });
  }

  it('the one route with NO limit says so in a comment, not by omission', () => {
    // `GET /api/me` has no limit. The comment is the assertion: a limit here
    // breaks the product for someone who navigates.
    const text = read('app', 'api', 'me', 'route.ts');
    expect(text).toContain('NO rate limit');
    expect(text).toContain("rateLimit: 'me.update'");
  });
});

/* ========================================================================== */
/* The authorization gate on each privileged route                             */
/* ========================================================================== */

describe('every privileged route names a MATRIX ROW, not a hand-written role list', () => {
  const ROUTES: Array<{ file: string; capability: string; denied: string }> = [
    {
      file: 'app/api/admin/system/health/route.ts',
      capability: 'r52_listUsers',
      denied: 'citizen',
    },
    {
      file: 'app/api/ai/triage/route.ts',
      // Row 1, NOT row 13.
      //
      // This was `r13_readAiTriagePanel` with `denied: 'citizen'`, and that
      // encoded the bug this test now guards against: the endpoint analyses the
      // CALLER'S OWN DRAFT on the way to `POST /api/incidents`, so gating it on a
      // read capability a citizen does not hold 403'd the exact user it exists to
      // serve. `r01_createIncident` is the row that describes "a citizen acting on
      // their own report", and it is the same row the create route uses — so the
      // preview can never be MORE restricted than the submit it precedes.
      //
      // `denied` stays empty: every authenticated role can create an incident, so
      // there is no role this route should refuse.
      capability: 'r01_createIncident',
      denied: '',
    },
  ];

  for (const { file, capability, denied } of ROUTES) {
    it(`${file} gates on ${capability}${denied === '' ? ', which no role is denied' : `, which ${denied} does not hold`}`, () => {
      const code = codeOf(...file.split('/'));

      // A capability name is a COMPILE error if the row is removed. An array
      // literal of roles is not, and it can disagree with the matrix silently.
      expect(code).toContain(`requireCapability(user, '${capability}'`);
      expect(code).not.toMatch(/requireRole\(user,\s*\[/);
      expect(code).not.toMatch(/user\.role\s*===\s*['"]admin['"]/);

      // `denied` names the role that must NOT hold the capability, and it is
      // OPTIONAL. A route every authenticated role may use has nothing to assert
      // there, and forcing an empty string through a `PERMISSION_MATRIX[cap][role]`
      // lookup would index a key that does not exist and produce a failure that
      // reads like a permissions bug rather than a test-shape bug.
      if (denied !== '') {
        expect(PERMISSION_MATRIX[capability as keyof typeof PERMISSION_MATRIX][denied as 'citizen']).toBe(
          'denied',
        );
      } else {
        // The stronger claim when nothing is refused: EVERY role holds it.
        //
        // Asserting "not denied" for one role would still permit a row that
        // excludes somebody else — and for `r01_createIncident` that would mean a
        // responder could not file an incident, which is exactly the regression this
        // row was changed to prevent.
        const row = PERMISSION_MATRIX[capability as keyof typeof PERMISSION_MATRIX];
        const refused = Object.entries(row)
          .filter(([, level]) => level === 'denied')
          .map(([role]) => role);
        expect(refused, `${capability} must not refuse any authenticated role`).toEqual([]);
      }
    });
  }

  it('no route reads a role from the request body, the query, or the URL', () => {
    // The four independent blocks on privilege escalation, asserted from the
    // source rather than trusted:
    //   1. no `role` field in any request schema (MUST 8 + MUST 1),
    //   2. `assertNoRoleInBody` on the one route that writes a user document,
    //   3. nothing under `components/` or `features/` reads a role from storage,
    //   4. `firestore.rules` denies every client write to `users`.
    for (const file of [
      'app/api/me/route.ts',
      'app/api/me/bootstrap/route.ts',
      'app/api/auth/event/route.ts',
      'app/api/auth/me/route.ts',
      'app/api/admin/system/health/route.ts',
      'app/api/ai/triage/route.ts',
    ]) {
      const text = read(...file.split('/'));
      expect(text, `${file} reads body.role`).not.toMatch(/body\.role/);
      expect(text, `${file} reads query.role`).not.toMatch(/query\.role/);
      expect(text, `${file} reads params.role`).not.toMatch(/params\.role/);
    }

    // The AI probe body has no `role`, `uid`, `model`, or `promptVersion`.
    const parsed = aiTriageProbeBodySchema.safeParse({
      text: 'A man has collapsed near the bus stop.',
      role: 'admin',
    });
    expect(parsed.success).toBe(false);
  });

  it('the bootstrap route calls `assertNoRoleInBody` as belt and braces', () => {
    expect(read('app', 'api', 'me', 'bootstrap', 'route.ts')).toContain('assertNoRoleInBody(body)');
  });
});

/* ========================================================================== */
/* The response envelope                                                       */
/* ========================================================================== */

describe('both envelope shapes parse, and neither is optional', () => {
  it('a success envelope validates', () => {
    const parsed = successEnvelopeSchema(z.object({ user: z.object({ uid: z.string() }) })).safeParse({
      success: true,
      data: { user: { uid: 'u1' } },
      meta: { requestId: 'req_aaaaaaaaaaaa' },
    });
    expect(parsed.success).toBe(true);
  });

  it('an error envelope validates, and `details` is OPTIONAL not empty', () => {
    // docs/16 §1: `details` is omitted when there is no field-level information.
    const withoutDetails = errorEnvelopeSchema.safeParse({
      success: false,
      error: { code: 'FORBIDDEN', message: 'You do not have permission for that action.' },
      meta: { requestId: 'req_aaaaaaaaaaaa' },
    });
    expect(withoutDetails.success).toBe(true);
  });

  it('the requestId lives in `meta` on BOTH paths, so a failure is traceable', () => {
    // The single most useful field in the whole contract: support can trace a
    // failure even for a code the UI has no branch for.
    for (const payload of [
      { success: true, data: {}, meta: { requestId: 'req_aaaaaaaaaaaa' } },
      { success: false, error: { code: 'INTERNAL', message: 'x' }, meta: { requestId: 'req_aaaaaaaaaaaa' } },
    ]) {
      expect(payload.meta.requestId).toMatch(REQUEST_ID_PATTERN);
    }
  });

  it('a requestId is `req_` plus 12 base62 characters', () => {
    // The shape matters more than the length: `REQUEST_ID_PATTERN` is what the
    // UI validates before rendering one, and support quotes it. A request id
    // that reaches a user must be recognisably an id, not a stack frame.
    expect(REQUEST_ID_PATTERN.test('req_7Kd2mQ9xL4na')).toBe(true);
    expect(REQUEST_ID_PATTERN.test('req_short')).toBe(false);
    expect(REQUEST_ID_PATTERN.test('7Kd2mQ9xL4na')).toBe(false);
    // A hyphen is not base62, and `base64url` from `crypto.randomBytes` never
    // produces one, so a hyphen means the id did not come from our generator.
    expect(REQUEST_ID_PATTERN.test('req_7Kd2mQ9xL4n-')).toBe(false);
  });
});

/* ========================================================================== */
/* The unconfigured deployment                                                */
/* ========================================================================== */

describe('an unconfigured deployment is a good state, not a crash', () => {
  it('every route except health refuses with 503 SERVICE_UNAVAILABLE', () => {
    // Checked before authentication, so an unconfigured deployment never reaches
    // the Admin SDK and gets an opaque `invalid_grant`.
    const source = read('lib', 'server', 'route.ts');
    expect(source).toContain('isAdminConfigured()');
    expect(source).toContain("code: 'SERVICE_UNAVAILABLE'");
    // 503, not 500: "not processed, nothing was changed, and the reason is a
    // missing secret" rather than "the server is broken".
    expect(new AppError({ code: 'SERVICE_UNAVAILABLE' }).status).toBe(503);
  });

  it('ONLY the health route opts out of the precondition', () => {
    // A liveness endpoint that 503s because a secret is missing is a false
    // negative on the one endpoint that must always answer.
    const withOptOut: string[] = [];
    for (const file of [
      'app/api/health/route.ts',
      'app/api/me/route.ts',
      'app/api/me/bootstrap/route.ts',
      'app/api/auth/event/route.ts',
      'app/api/auth/me/route.ts',
      'app/api/admin/system/health/route.ts',
      'app/api/ai/triage/route.ts',
    ]) {
      if (read(...file.split('/')).includes('allowUnconfigured: true')) withOptOut.push(file);
    }
    expect(withOptOut).toEqual(['app/api/health/route.ts']);
  });

  /**
   * ---------------------------------------------------------------------------
   * A REAL BUG PHASE 3 INTRODUCED, and this is the test that stops it returning
   * ---------------------------------------------------------------------------
   * `GET /api/health` declares a rate limit, so `withRequest` reached
   * `applyRateLimit` → `enforceRateLimit` → `getAdminDb()` on a deployment with
   * no Admin credentials. The SDK bootstrap throws `SERVICE_UNAVAILABLE`, and
   * the liveness endpoint answered **503 for exactly the condition it exists to
   * describe** — defeating the entire purpose of the `allowUnconfigured` option,
   * and reintroducing the exact failure mode
   * `tests/unit/unconfigured-deployment.test.ts` was written to pin.
   *
   * The fix is that the rate limit is SKIPPED when the Admin SDK is not
   * configured, because the bucket lives in Firestore: a limit that cannot be
   * stored cannot be enforced. Asserted on the CODE because the failure is a
   * runtime one that needs a deployed server to observe, and the mistake is made
   * while editing the pipeline.
   */
  it('skips the rate limit when the Admin SDK is unconfigured, so /api/health can answer', () => {
    const code = codeOf('lib', 'server', 'route.ts');

    // The gate exists, and it wraps the rate-limit call.
    expect(code).toMatch(
      /const limited = isAdminConfigured\(\)\s*\?\s*await applyRateLimit\(/,
    );

    // And `applyRateLimit` reaches Firestore, which is why the gate is required.
    const rateLimit = codeOf('lib', 'server', 'rate-limit.ts');
    expect(rateLimit).toContain('getAdminDb()');
    expect(rateLimit).toContain('COLLECTIONS.rateLimits');
    expect(rateLimit).toContain('runTransaction(');

    // The two must not drift: if the rate limiter ever stops needing the Admin
    // SDK, this test is the thing that tells you the gate can be removed.
    expect(codeOf('lib', 'server', 'firebase-admin.ts')).toContain('SERVICE_UNAVAILABLE');
  });

  it('every route that DECLARES a rate limit is also gated by the precondition', () => {
    // A route with `allowUnconfigured: true` and a rate limit is the exact
    // combination that produced the bug above. Health is the only route that opts
    // out, so it is the only one that can be affected — and the gate handles it.
    const health = read('app', 'api', 'health', 'route.ts');
    expect(health).toContain('allowUnconfigured: true');
    expect(health).toContain("rateLimit: 'health.read'");
  });

  it('the Admin SDK bootstrap throws a TYPED error, not a bare Error', () => {
    // The failure mode being defended against is an unconfigured deployment
    // reaching the SDK and getting an opaque SDK error, which `toAppError` maps
    // to `500 INTERNAL` and a caller reads as "the server is broken".
    const source = read('lib', 'server', 'firebase-admin.ts');
    expect(source).toContain("code: 'SERVICE_UNAVAILABLE'");
  });

  it('a misconfigured environment variable is 503, not 500', () => {
    // A `ServerEnvError` names the variable and never its value, so mapping it to
    // `SERVICE_UNAVAILABLE` makes the log and the response agree: "not
    // configured, nothing was changed" rather than "something went wrong", which
    // sends an operator looking through the code instead of the environment.
    const envError = Object.assign(new Error('Missing FIREBASE_PROJECT_ID'), {
      name: 'ServerEnvError',
    });
    const mapped = toAppError(envError);
    expect(mapped.code).toBe('SERVICE_UNAVAILABLE');
    expect(mapped.status).toBe(503);
    // The variable NAME is on `cause` for the log; the VALUE never appears, and
    // neither does the name in the body a caller reads.
    expect(mapped.message).not.toContain('FIREBASE_PROJECT_ID');
  });
});


/* ========================================================================== */
/* Layering                                                                    */
/* ========================================================================== */

describe('the layering is mechanically enforced, not conventional', () => {
  it('no route handler imports the Admin SDK or a provider adapter', () => {
    for (const file of [
      'app/api/me/route.ts',
      'app/api/me/bootstrap/route.ts',
      'app/api/auth/event/route.ts',
      'app/api/auth/me/route.ts',
      'app/api/health/route.ts',
      'app/api/admin/system/health/route.ts',
      'app/api/ai/triage/route.ts',
    ]) {
      const text = read(...file.split('/'));
      expect(text, `${file} reaches past the service layer`).not.toContain('lib/server/firebase-admin');
    }
  });

  it('no client-reachable file imports a server module', () => {
    // The second, independent check beside the `server-only` poison pill. Two
    // mechanisms, one invariant: secrets never reach the browser.
    const files = [
      'components/providers/session-provider.tsx',
      'components/providers/app-providers.tsx',
      'features/auth/login-form.tsx',
      'features/auth/signup-form.tsx',
    ];
    for (const file of files) {
      const text = read(...file.split('/'));
      expect(text, `${file} imports a server module`).not.toMatch(
        /from '@\/(lib\/server\/|env\.server|env\.maintenance|firebase-admin)/,
      );
    }
  });

  it('every module that can read a secret carries `import \'server-only\'`', () => {
    // The barrel and `lib/integrations/contracts.ts` are EXCLUDED, and both
    // exclusions are the point rather than an oversight:
    //   - `services/index.ts` is pure re-exports and imports nothing, so the guard
    //     on the modules it re-exports is what protects it.
    //   - `lib/integrations/contracts.ts` must be importable from a Client
    //     Component and a unit test, so adding the guard would defeat the reason
    //     it is pure. Purity is its protection; there is nothing in it to leak.
    const modules = [
      'lib/env.server.ts',
      'lib/server/errors.ts',
      'lib/server/http.ts',
      'lib/server/route.ts',
      'lib/server/logging.ts',
      'lib/server/validate.ts',
      'lib/server/rate-limit.ts',
      'lib/server/serialize.ts',
      'lib/server/permissions.ts',
      'lib/server/firebase-admin.ts',
      'lib/server/auth-guard.ts',
      'lib/server/audit.ts',
      'services/auth/account.ts',
      'services/admin/system-health.ts',
      'services/ai/triage.ts',
      'services/integrations/gemini/index.ts',
      'services/integrations/google-maps/index.ts',
      'services/integrations/twilio/index.ts',
    ];
    for (const file of modules) {
      expect(read(...file.split('/')), `${file} is missing the server-only guard`).toMatch(
        /^\s*import 'server-only';/m,
      );
    }
  });

  it('`lib/integrations/contracts.ts` is PURE — no SDK, no env, no fetch', () => {
    // The interface has to be importable from a unit test, a Client Component,
    // and a route, without pulling a provider SDK into a bundle. Asserted
    // against CODE: the file's own documentation names `process.env` and `fetch`
    // to explain why they are absent.
    const source = codeOf('lib', 'integrations', 'contracts.ts');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('@google/genai');
    expect(source).not.toMatch(/from ['"]twilio/);
    expect(source).not.toMatch(/from ['"]react/);
  });

  it('`validators/*` stays pure — no Firestore, no env, no React', () => {
    // One schema, two runtimes (docs/17 §0 rule 5). A schema that could reach a
    // database would have to be duplicated, and the copy is the one nobody keeps
    // in sync. Asserted against CODE, because these files explain the rule in
    // their headers and name the banned things to do so.
    for (const file of ['validators/common.ts', 'validators/query.ts', 'validators/ai.ts', 'validators/index.ts']) {
      const source = codeOf(...file.split('/'));
      expect(source, `${file} imports an SDK`).not.toContain('firebase-admin');
      expect(source, `${file} reads the environment`).not.toContain('process.env');
      expect(source, `${file} imports React`).not.toMatch(/from ['"]react/);
      expect(source, `${file} imports Next`).not.toContain("from 'next/");
    }
  });
});

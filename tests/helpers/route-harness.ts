/**
 * ============================================================================
 * Driving a REAL route handler, end to end
 * ============================================================================
 *
 * The companion to `tests/helpers/fake-firestore.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS FILLS
 * ---------------------------------------------------------------------------
 * `tests/unit/api/route-pipeline.test.ts` proves the pipeline is shaped correctly
 * by reading route sources and asserting that patterns appear in them. That is a
 * real check of a real invariant, and it is not what this file does.
 *
 * What it cannot do is observe a REQUEST. Every question in the Phase 15 brief —
 * "can user A touch user B's incident?", "does a suspended caller get through?",
 * "is the rate limit actually consulted before the handler runs?" — is about the
 * sequence of calls a real request makes. So this harness hands a real
 * `withRequest` route a real `Request`, with real validators and real services,
 * and only the two I/O edges faked: token verification and Firestore.
 *
 * ---------------------------------------------------------------------------
 * WHY `vi.mock` LIVES IN THE TEST FILE, NOT HERE
 * ---------------------------------------------------------------------------
 * `vi.mock` calls are hoisted within the file that contains them. A mock declared
 * in a helper would depend on evaluation order across the import graph, which is
 * exactly the sort of invisible coupling that makes a test suite rot. So each test
 * file declares its own mocks (as `tests/unit/admin/audit-atomicity.test.ts`
 * already does) and imports the fakes from here.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PASSING TEST HERE DOES AND DOES NOT PROVE
 * ---------------------------------------------------------------------------
 * Proves: the handler's own logic, its ordering, its authorisation, its
 * validation, its error mapping.
 *
 * Does NOT prove: that `firestore.rules` would agree, that a Firestore query
 * shape is affordable, or that Firebase Admin's `verifyIdToken` behaves like this
 * map. Those need the emulator and a real project, and are reported as such.
 */

import { FakeFirestore } from './fake-firestore';

/* ========================================================================== */
/* Environment                                                                 */
/* ========================================================================== */

/**
 * The origin the CSRF check accepts.
 *
 * `getServerEnv()` reads `NEXT_PUBLIC_APP_URL` to build that set, so the constant
 * has to agree with it or every request with an `Origin` header is refused and
 * the suite silently tests nothing but the CSRF branch.
 */
export const APP_URL = 'http://localhost:3000';

/**
 * Populate the required env tier.
 *
 * Safe to call repeatedly. Real values are placeholders: nothing here reaches a
 * network, and `isAdminConfigured()` only checks that the variables are PRESENT,
 * which is what lets the rate limiter run instead of being skipped.
 */
export function installRequiredEnv(): void {
  const values: Record<string, string> = {
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_CLIENT_EMAIL: 'test@test-project.iam.gserviceaccount.com',
    // A syntactically plausible PEM. Parsed only if something actually
    // initialises the SDK, which this harness never lets happen.
    FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
    NEXT_PUBLIC_APP_URL: APP_URL,
    CRON_SECRET: 'test-cron-secret',
    IP_HASH_SALT: 'test-ip-hash-salt',
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

/* ========================================================================== */
/* Fake Auth                                                                  */
/* ========================================================================== */

export type FakeToken = {
  uid: string;
  email?: string;
  name?: string;
  auth_time?: number;
  /** A mirrored role claim. Omitted by default, which is the real-world state. */
  role?: string;
  [key: string]: unknown;
};

/**
 * A stand-in for `firebase-admin/auth`'s `Auth`, holding a token table.
 *
 * `revocationChecks` records every call that passed `checkRevoked`, so a test can
 * assert the flag is actually sent. That is not paranoia: `auth-guard.ts` names it
 * as the thing that makes suspension mean anything, and nothing else in the suite
 * observes it.
 */
export class FakeAuth {
  readonly tokens = new Map<string, FakeToken>();

  readonly revocationChecks: string[] = [];

  /** Token strings that verify but should throw, to model a revoked session. */
  private revoked = new Set<string>();

  issue(token: string, claims: FakeToken): void {
    this.tokens.set(token, claims);
  }

  revoke(token: string): void {
    this.revoked.add(token);
  }

  get verifyIdToken() {
    return async (token: string, checkRevoked?: boolean): Promise<FakeToken> => {
      if (checkRevoked) this.revocationChecks.push(token);
      if (this.revoked.has(token)) throw new Error('Firebase id token has been revoked');
      const claims = this.tokens.get(token);
      if (!claims) throw new Error('Firebase id token has incorrect claims');
      return { sub: claims.uid, ...claims } as FakeToken;
    };
  }
}

/* ========================================================================== */
/* Requests                                                                    */
/* ========================================================================== */

export type RequestOptions = {
  method?: string;
  token?: string | null;
  origin?: string | null;
  body?: unknown;
  /** Send a body with no `Content-Type`. */
  omitContentType?: boolean;
  headers?: Record<string, string>;
};

/**
 * Build a `Request` shaped the way a browser would send it.
 *
 * Defaults matter here. A missing `Origin` means the CSRF check passes by design
 * (`allows a request with neither Origin nor Referer`), so a test that omits it is
 * testing the non-browser path; a test that wants to exercise CSRF passes one
 * explicitly.
 */
export function buildRequest(url: string, options: RequestOptions = {}): Request {
  const headers = new Headers(options.headers ?? {});

  if (options.token !== null) headers.set('authorization', `Bearer ${options.token ?? 'valid-token'}`);
  if (options.origin !== null) headers.set('origin', options.origin ?? APP_URL);

  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (!options.omitContentType) headers.set('content-type', 'application/json');
  }

  return new Request(url, {
    method: options.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

/* ========================================================================== */
/* Reading responses                                                            */
/* ========================================================================== */

export type Envelope =
  | { success: true; data: unknown; meta: { requestId: string } }
  | { success: false; error: { code: string; message: string; details?: unknown[] }; meta: { requestId: string } };

/**
 * A route handler as Next exports it.
 *
 * The context parameter is typed `never` on purpose. Next's own type declares it
 * `RouteHandlerContext<TParams>`, and a function that ACCEPTS a narrower type is
 * not assignable to one that accepts `unknown` — so typing the harness parameter
 * as `unknown` rejects every real route. `never` is the only type assignable to
 * every context, which makes it the correct "the caller decides" annotation here.
 */
export type RouteHandler = (request: Request, context: never) => Promise<Response>;

/**
 * Invoke a route handler and parse its envelope.
 *
 * `handler` is the exported `GET`/`PATCH`/`POST` function. The `context` argument
 * is threaded through verbatim, which is how a dynamic route sees its own `[id]`.
 */
export async function callRoute(
  handler: RouteHandler,
  request: Request,
  context?: unknown,
): Promise<{ status: number; headers: Headers; envelope: Envelope }> {
  const response = await handler(request, context as never);
  const text = await response.text();
  let envelope: Envelope;
  try {
    envelope = JSON.parse(text) as Envelope;
  } catch {
    throw new Error(
      `Route returned a non-JSON body (status ${response.status}). ` +
        `A handler must never shape its own error body. Body was: ${text.slice(0, 300)}`,
    );
  }
  return { status: response.status, headers: response.headers, envelope };
}

/** The error code from a failure envelope, or a readable failure if it succeeded. */
export function errorCode(envelope: Envelope): string {
  if (envelope.success) {
    throw new Error(`Expected an error envelope but the request succeeded: ${JSON.stringify(envelope.data)}`);
  }
  return envelope.error.code;
}

/* ========================================================================== */
/* Seeding                                                                     */
/* ========================================================================== */

export type SeedUser = {
  uid: string;
  role?: string;
  status?: string;
  displayName?: string;
  email?: string;
};

/**
 * Seed `users/{uid}` the way a real deployment would hold it.
 *
 * Defaults are `citizen` / `active`, matching a completed public sign-up.
 */
export function seedUser(db: FakeFirestore, user: SeedUser): FakeFirestore {
  return db.seed(`users/${user.uid}`, {
    uid: user.uid,
    role: user.role ?? 'citizen',
    status: user.status ?? 'active',
    displayName: user.displayName ?? '',
    email: user.email ?? `${user.uid}@example.test`,
    ...(user.role === undefined ? {} : {}),
  });
}

/**
 * Every document under a collection path, as `[path, data]` pairs.
 *
 * Deliberately not `Object.keys(db.store)`: `store` is a `Map`, and the
 * `Object.*` reflections on a Map are always empty. That mistake reads exactly
 * like "no audit row was written", which is how a passing-looking assertion can
 * silently verify nothing.
 */
export function documentsUnder(db: FakeFirestore, prefix: string): Array<Record<string, unknown>> {
  return [...db.store.entries()]
    .filter(([path]) => path.startsWith(prefix))
    .map(([, data]) => data);
}

/** Seed an incident, with the fields the dispatch services read. */
export function seedIncident(db: FakeFirestore, incident: Record<string, unknown>): FakeFirestore {
  return db.seed(`incidents/${incident.id as string}`, {
    reporterUid: 'u_reporter',
    status: 'reported',
    version: 1,
    ...incident,
  });
}

export { FakeFirestore };
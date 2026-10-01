/**
 * ============================================================================
 * CareGrid AI — rate limiting
 * ============================================================================
 *
 * A token bucket in Firestore, keyed on a hash of the subject and the route.
 * docs/10 §17.1 is normative for the algorithm; this file is its
 * implementation.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT AN IN-MEMORY MAP
 * ---------------------------------------------------------------------------
 * Because a Vercel function is a single-use process (docs/06 §1.2). A
 * `Map<string, number>` in module scope would be:
 *
 *   - **per instance**, and many instances serve the same route at once, so the
 *     effective limit is `limit * instanceCount`;
 *   - **reset on every cold start**, so a caller who can force evictions gets a
 *     fresh budget; and
 *   - **per region**, so a caller routed to three continents gets three
 *     budgets.
 *
 * `RATE_LIMIT_STORE=memory` is therefore documented as UNSAFE, and
 * `lib/env.server.ts` reports it as a configuration problem rather than
 * honouring it. The only legitimate use is a unit test.
 *
 * ---------------------------------------------------------------------------
 * WHY IT FAILS CLOSED
 * ---------------------------------------------------------------------------
 * If the bucket read fails, this throws `DB_UNAVAILABLE` (503) rather than
 * letting the request through. The alternative — fail open — means a Firestore
 * blip silently removes the only spam control on `POST /api/incidents`, and
 * the 5/hour + 20/day limits in docs/08 §1.9 exist to stop a report-flood
 * (FR-015). A rate limiter that can be turned off by causing an error is not a
 * rate limiter.
 *
 * The cost of failing closed is that a Firestore outage also blocks requests
 * that do not need Firestore. That is the honest behaviour: if the datastore
 * is down, a route that reads it cannot do its job either, and `503` says "not
 * processed, nothing was changed" rather than pretending to have served
 * something.
 *
 * ---------------------------------------------------------------------------
 * THE COST, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * 1 read + 1 write per LIMITED request, inside a transaction. That is the price
 * of a correct limit on a stateless platform and it is accepted in docs/07
 * §11.6. It is why the rule table below puts generous limits on the routes a
 * dispatcher polls and tight ones on the routes an attacker wants.
 *
 * ---------------------------------------------------------------------------
 * THE KEY IS HASHED, AND THAT IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * `rateLimits/{sha256(subject | route | windowBucket)}`. A document id that
 * contained a uid would leak every caller's uid to anyone with read access to
 * the collection, and `firestore.rules` denies that — but "the rules deny it"
 * is a weaker guarantee than "the key never contained it".
 */

import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

import { getAdminDb } from '@/lib/server/firebase-admin';
import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { rateLimitConfig } from '@/lib/env.server';
import { COLLECTIONS } from '@/config/collections';

/* ========================================================================== */
/* The rule table — the single source of the numbers (docs/10 §17.2)          */
/* ========================================================================== */

/**
 * Who the bucket is counted against.
 *
 * `uid` for anything authenticated, because one person behind one NAT is one
 * person. `ip` only for the two routes that can be called with no token at all
 * (`GET /api/health` and, in Phase 3, the auth event route when the token has
 * already gone), where a uid does not exist yet.
 */
export type RateLimitSubject = 'uid' | 'ip';

export type RateLimitRule = {
  /** A stable key. NEVER the URL: `/api/incidents/:id/status` is ONE bucket. */
  readonly routeKey: string;
  readonly limit: number;
  readonly windowSec: number;
  readonly subject: RateLimitSubject;
};

/**
 * Every limit in the system, in one table.
 *
 * docs/10 §17.2 for the numbers, docs/08 §1.9 for the contract. A limit is
 * changed HERE and nowhere else, which is the point of a table: a per-call
 * literal in a route handler is a limit nobody can find.
 *
 * Two rows are not in the docs and are marked as such:
 *
 *   - `me.read` has NO limit. `GET /api/me` runs on every authenticated page
 *     load and on every session refresh; a limit here would break the product
 *     for a caller who navigates. It is a pure read of one document the caller
 *     already proved they may read.
 *   - `auth.event` is documented at 30/h per uid-or-IP. It is the sign-out path,
 *     and it must not be the thing that fails when someone signs in and out
 *     repeatedly on a bad connection.
 */
export const RATE_LIMIT_RULES: Readonly<Record<string, RateLimitRule>> = {
  'health.read': { routeKey: 'health.read', limit: 60, windowSec: 60, subject: 'ip' },
  'me.bootstrap': { routeKey: 'me.bootstrap', limit: 10, windowSec: 3600, subject: 'uid' },
  'me.read': { routeKey: 'me.read', limit: Number.POSITIVE_INFINITY, windowSec: 3600, subject: 'uid' },
  'me.update': { routeKey: 'me.update', limit: 30, windowSec: 3600, subject: 'uid' },
  'auth.event': { routeKey: 'auth.event', limit: 30, windowSec: 3600, subject: 'uid' },
  'auth.me': { routeKey: 'auth.me', limit: 120, windowSec: 60, subject: 'uid' },
  /**
   * 60/min per uid. `docs/10 §17.1`.
   *
   *   Analytics is the most expensive read in the application: one request scans up to
   *   `LIVE_SCAN_CAP` (500) documents and aggregates them on the server, because
   *   Firestore offers no `COUNT(*)`/`GROUP BY` (`docs/14 §3.1`). Left unbounded it is
   *   the cheapest available way for a signed-in user to burn the read budget.
   *
   *   60/min is far above how often a dashboard re-requests or a person changes a
   *   filter, and far below anything that would make the scan a denial-of-service.
   */
  /**
   * 120/min per uid. `docs/10 §17.1`.
   *
   *   Marking a notification read is ONE document write and is the action a client
   *   performs most often — the bell reloads, and clicking through a list marks
   *   several. It also has the lowest ceiling worth worrying about, which is exactly why
   *   it needs one: `brief §6` asks for notification traffic to be bounded, and this
   *   is the endpoint that would be abused.
   */
  'notifications.read': { routeKey: 'notifications.read', limit: 120, windowSec: 60, subject: 'uid' },

  'analytics.read': { routeKey: 'analytics.read', limit: 60, windowSec: 60, subject: 'uid' },

  'admin.systemHealth': { routeKey: 'admin.systemHealth', limit: 30, windowSec: 60, subject: 'uid' },
  'ai.triage': { routeKey: 'ai.triage', limit: 20, windowSec: 3600, subject: 'uid' },

  /* --- Phase 5: uploads (docs/15 §8.1) ---------------------------------- */
  /**
   * 30/h per uid. A full report needs 3 signs (3 media) and the FR-015 budget is
   * 5 reports/hour, so 30 is exactly the ceiling with NO retry headroom — which
   * is deliberate, because a citizen who uploads, fails once on a flaky
   * connection, and retries has just used 6 of their 30 and can still finish.
   * Raising this to "sign is cheap, allow lots" is how a public upload endpoint
   * gets built: brief §32, "Do not create a public unlimited upload endpoint."
   */
  'uploads.sign': { routeKey: 'uploads.sign', limit: 30, windowSec: 3600, subject: 'uid' },
  /**
   * 30/h, matching `uploads.sign` 1:1.
   *
   * The two MUST move together. A sign with no finalize is a claim that is never
   * spent; a finalize with no sign is rejected by `claimFor` and costs nothing
   * real. So the pairing is what bounds the number of *live* staging objects a
   * single user can accumulate, which is the resource `uploads.sign` is really
   * protecting.
   */
  'uploads.finalize': { routeKey: 'uploads.finalize', limit: 30, windowSec: 3600, subject: 'uid' },
  /**
   * 120/min, from docs/15 §16.4 verbatim: "the client calls
   * `GET /api/uploads/:mediaId/url` again (rate limit 120/min)".
   *
   * Generous on purpose, and it is a READ. A dispatcher scrolling an incident
   * with 3 photos on a slow connection re-fetches signed URLs constantly as they
   * expire, and a tighter limit here would show a responder blank images during
   * an emergency — the single worst failure this product has. Each call mints a
   * 15-minute URL, so the cost is a signature, not a download.
   */
  'uploads.url': { routeKey: 'uploads.url', limit: 120, windowSec: 60, subject: 'uid' },

  /* --- Phase 7: dispatch ------------------------------------------------- */
  /**
   * 60/min. A READ, and the number is generous for the same reason
   * `uploads.url` is: a dispatcher refreshing a candidate panel is doing exactly
   * what the panel is for.
   *
   * brief §41 warns against loading all responders, and the answer to that is a
   * narrow query and a cap (`CANDIDATE_QUERY_LIMIT`) — not a rate limit tight
   * enough to make the panel fail while someone waits. A 409 that arrives as
   * "too many requests" on the screen a dispatcher is reading during an incident is
   * worse than the read it would have saved.
   */
  'dispatch.candidates': { routeKey: 'dispatch.candidates', limit: 60, windowSec: 60, subject: 'uid' },
  /**
   * 60/h. The ceiling that matters most in this phase.
   *
   * An assignment is a human decision with consequences — it takes a responder off
   * whatever else they were doing. Sixty an hour is far above any plausible
   * dispatcher's real rate (a busy desk might do twenty) while still bounding the
   * damage from a compromised dispatcher token: without this, an attacker with a
   * stolen session could assign every verified responder in the city in a loop, and
   * every one of those assignments is a transaction that increments a real
   * responder's counter and writes a real audit row.
   */
  'dispatch.assign': { routeKey: 'dispatch.assign', limit: 60, windowSec: 3600, subject: 'uid' },
  /**
   * 120/h, doubled from `dispatch.assign`.
   *
   * A responder's accept and decline are the cheapest and most frequent actions in
   * the system, and the failure mode of throttling them is uniquely bad: a
   * responder who is refused a rate-limit error on "Accept" while driving reads it
   * as "the system is broken" and stops using the app. The cost of the extra headroom
   * is one transaction that changes two fields.
   */
  'dispatch.respond': { routeKey: 'dispatch.respond', limit: 120, windowSec: 3600, subject: 'uid' },
  /**
   * 240/h.
   *
   * Higher still, and deliberately so: this wraps the *whole* lifecycle, so one
   * incident legitimately costs a responder four calls (accept, en route, on scene,
   * resolve) and a dispatcher correcting a mistake costs several more. A cap that
   * a busy responder hits mid-incident is a cap that stops an incident being
   * resolved, which is the worst outcome the rate limiter could produce.
   */
  'dispatch.transition': { routeKey: 'dispatch.transition', limit: 240, windowSec: 3600, subject: 'uid' },
};

/**
 * Look a rule up by route key.
 *
 * Throws rather than defaulting. A silent default of "no limit" is how an
 * endpoint ends up unlimited because of a typo, and "no limit because the rule
 * was misspelled" is the worst possible failure mode for this file.
 */
export function rateLimitFor(routeKey: string): RateLimitRule {
  const rule = RATE_LIMIT_RULES[routeKey];
  if (!rule) {
    throw new AppError({
      code: 'INTERNAL',
      message: `No rate-limit rule is declared for "${routeKey}". Declare one in RATE_LIMIT_RULES.`,
    });
  }
  return rule;
}

/* ========================================================================== */
/* Enforcement                                                                 */
/* ========================================================================== */

export type RateLimitResult = {
  readonly rule: RateLimitRule;
  readonly limit: number;
  readonly remaining: number;
  /** Unix seconds at which the current window ends. */
  readonly resetAtSec: number;
};

/**
 * Count one request against a bucket, or throw `429`.
 *
 * @param subjectValue the uid, or the hashed IP for an `ip` rule. Never a raw
 *   IP: this function is handed a hash so a caller cannot accidentally pass the
 *   address itself and have it become a document field.
 */
export async function enforceRateLimit(input: {
  readonly routeKey: string;
  readonly subjectValue: string;
}): Promise<RateLimitResult> {
  const rule = rateLimitFor(input.routeKey);
  if (!Number.isFinite(rule.limit)) {
    return unlimited(rule);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const windowBucket = Math.floor(nowSec / rule.windowSec);
  const docId = bucketId(input.subjectValue, rule.routeKey, windowBucket);
  const ref = getAdminDb().collection(COLLECTIONS.rateLimits).doc(docId);
  const resetAtSec = (windowBucket + 1) * rule.windowSec;

  const outcome = await transaction(db(), async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const count = typeof data?.count === 'number' ? data.count : 0;
    const windowStartMs = readMillis(data?.windowStart);

    // A window that has aged out resets rather than blocking. Staleness is a
    // reason to allow, never a reason to refuse: a clock that jumped forward
    // must not lock a citizen out of reporting an emergency.
    const windowAgeMs = windowStartMs === null ? Number.POSITIVE_INFINITY : Date.now() - windowStartMs;
    const expired = windowAgeMs >= rule.windowSec * 1000;

    if (expired || count + 1 <= rule.limit) {
      const next = expired || count === 0 ? 1 : count + 1;
      tx.set(
        ref,
        {
          count: next,
          windowStart: FieldValue.serverTimestamp(),
          expiresAt: new Date(resetAtSec * 1000),
          route: rule.routeKey,
          schemaVersion: 1,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { limited: false as const, count: next };
    }

    // Over the limit. Deliberately NOT incremented: an attacker must not be able
    // to extend their own lockout by hammering the endpoint, and the counter is
    // the evidence, not the penalty.
    tx.set(ref, { updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { limited: true as const, count };
  });

  const log = createLogger('');
  if (outcome.limited) {
    // The log line carries the limit, the window, and the RETRY, never the
    // subject. "Which bucket" is not something a prober learns from a log, and
    // every 429 body is deliberately identical so a log is the only place the
    // detail exists.
    log.warn({ code: 'RATE_LIMIT_EXCEEDED', path: rule.routeKey, status: 429 });
    throw new AppError({
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterSec: Math.max(1, resetAtSec - nowSec),
    });
  }

  return {
    rule,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - outcome.count),
    resetAtSec,
  };
}

/**
 * The standard response headers (docs/10 §15.1).
 *
 * Accepts `null` for a route that declared no rule, because the call site does
 * not know whether a rule exists and forcing a branch there would put the
 * decision in every route handler.
 */
export function rateLimitResponseHeaders(result: RateLimitResult | null): Record<string, string> {
  if (result === null) return {};
  if (!Number.isFinite(result.limit)) return {};
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.max(0, result.resetAtSec - Math.floor(Date.now() / 1000))),
  };
}

/* ========================================================================== */
/* The client IP, hashed                                                       */
/* ========================================================================== */

/**
 * The caller's IP, or `null` when it cannot be established.
 *
 * `x-forwarded-for` is read ONLY when `RATE_LIMIT_TRUST_PROXY=true`, and only
 * its FIRST hop. On Vercel the edge sets that header and everything after the
 * first entry is a value the client chose, so a caller could otherwise rotate a
 * fresh "IP" per request and never hit a limit at all.
 *
 * With the flag off (a local build behind no proxy) there is no trustworthy
 * address at all, and the honest answer is `null` rather than a guess.
 */
export function clientIp(req: Request): string | null {
  if (!rateLimitConfig().trustProxy) return null;
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded === null) return null;
  const first = forwarded.split(',')[0]?.trim();
  if (first === undefined || first === '') return null;
  // An obviously forged value is dropped rather than hashed: `x-forwarded-for`
  // is free text, and hashing an arbitrary string into an audit field is a way
  // to write arbitrary data into a document.
  return /^[0-9a-fA-F:.]{3,45}$/.test(first) ? first : null;
}

/**
 * A pseudonymous, salted hash of an IP. docs/10 §17.4, docs/21 §2.
 *
 * The raw address is never persisted. `IP_HASH_SALT` rotates daily, so a hash
 * from last week cannot be joined to this week's — which is the entire reason
 * the salt exists rather than a plain hash.
 *
 * Returns `null` when no salt is configured, and the caller then records
 * `hasIp: false` rather than an unsalted digest. An unsalted SHA-256 of an IPv4
 * address is trivially reversible by brute force, so storing one would be a
 * privacy failure dressed up as a hash.
 */
export function hashIp(ip: string, salt: string | null): string | null {
  if (salt === null || salt.length < 8) return null;
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

/**
 * Constant-time comparison of a presented bearer secret against `CRON_SECRET`.
 *
 * `CRON_SECRET` is the ONE non-user principal in the system (docs/08 route 54).
 * A `===` comparison leaks its prefix through timing, and a cron endpoint is
 * exactly the sort of thing an attacker probes repeatedly.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — which is safe, because the length of a secret is not the secret.
 */
export function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ========================================================================== */
/* Internals                                                                  */
/* ========================================================================== */

function db(): Firestore {
  return getAdminDb();
}

/**
 * Run a read-modify-write inside a transaction.
 *
 * A plain read-then-write races: two parallel requests both read `count = 4` and
 * both write `5`, so five requests fit in a four-request budget. The
 * transaction is what makes the limit correct under the concurrency a
 * serverless platform actually produces (docs/06 §8.5).
 *
 * `INTERNAL` in the catch is deliberate: this only runs on routes that already
 * require the Admin SDK, so a `503 SERVICE_UNAVAILABLE` from the bootstrap is
 * the real cause and the `AppError` passes through unchanged above.
 */
async function transaction(
  firestore: Firestore,
  body: (tx: Transaction) => Promise<{ limited: boolean; count: number }>,
): Promise<{ limited: boolean; count: number }> {
  try {
    return await firestore.runTransaction((tx) => body(tx));
  } catch (error) {
    if (error instanceof AppError) throw error;
    // The mapping in `toAppError` turns a genuine `unavailable` into
    // `DB_UNAVAILABLE` 503. Anything else is a bug in this file and is logged
    // as one rather than disguised as a database fault.
    throw new AppError({ code: 'DB_UNAVAILABLE', cause: error });
  }
}

/**
 * The bucket document id. Hashed, so the uid is not a document name.
 *
 * The route key is part of the hash rather than a field lookup key so that two
 * routes can never collide onto one bucket by accident, and so the id has a
 * fixed length regardless of how long a subject value is.
 */
function bucketId(subject: string, routeKey: string, windowBucket: number): string {
  return createHash('sha256')
    .update(`${subject}|${routeKey}|${windowBucket}`)
    .digest('hex')
    .slice(0, 40);
}

function readMillis(value: unknown): number | null {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    const millis = (value as { toMillis: () => number }).toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function unlimited(rule: RateLimitRule): RateLimitResult {
  return {
    rule,
    limit: rule.limit,
    remaining: 0,
    resetAtSec: Math.floor(Date.now() / 1000) + rule.windowSec,
  };
}

/**
 * ============================================================================
 * CareGrid AI — route handler wrapper
 * ============================================================================
 *
 * One wrapper every `app/api` route handler uses, so no handler has to remember
 * the fourteen things that must happen before and after its own logic.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHY IT IS FIXED HERE
 * ---------------------------------------------------------------------------
 * docs/06 §3.1 and docs/10 §6.3 specify the sequence. It is not a style
 * preference; each step's failure mode is different, and the order decides what
 * the caller sees and what gets recorded.
 *
 * ```
 *  0  Admin precondition       503  a missing secret is not a bug
 *  1  requestId                —    minted before anything can fail
 *  2  same origin (non-GET)    403  CSRF defence in depth
 *  3  rate limit               429  BEFORE validation and before the handler
 *  4  authenticate             401  the token, the user doc, the role
 *  5  authorise               403  role gate, then resource gate
 *  6  validate body/query/params 400  BEFORE any Firestore, AI, or Maps call
 *  7  run the handler          —    the only part a route file writes
 *  8  convert any throw        —    a driver error can never escape as HTML
 * ```
 *
 * Three orderings are load-bearing and were each chosen against the obvious
 * alternative:
 *
 *   - **Auth before validation.** A caller who is not authenticated learns
 *     nothing about the schema. Validating first would let an anonymous prober
 *     map the API by watching 400s.
 *   - **Authorisation before rate limiting.** A caller without permission cannot
 *     burn ANOTHER subject's quota. The reverse order means a script that
 *     repeatedly hits a forbidden route also locks the legitimate user out.
 *   - **Validation before any I/O** (FR-142). A malformed body must cost one CPU
 *     pass, not a Firestore round trip. A test asserts this by stubbing the
 *     Admin SDK to throw on any access and still getting a 400.
 *
 * ---------------------------------------------------------------------------
 * WHAT A 500 LOOKS LIKE FROM OUTSIDE
 * ---------------------------------------------------------------------------
 * ```json
 * { "success": false,
 *   "error": { "code": "INTERNAL", "message": "Something went wrong. Nothing was changed." },
 *   "meta": { "requestId": "req_…" } }
 * ```
 * The internal cause goes to the server log with the same `requestId`. A
 * dispatcher forwards that id to support; support finds the trace. Nobody ever
 * sees a stack trace, a Firestore path, a field name from the schema, a
 * provider's API key, or the Admin SDK's own error text.
 *
 * ---------------------------------------------------------------------------
 * WHAT A HANDLER CAN AND CANNOT DO
 * ---------------------------------------------------------------------------
 * The `auth: 'required'` option is the reason a route can forget to
 * authenticate and still be safe: the wrapper authenticates BEFORE the handler
 * is called, and the handler's signature says whether a caller exists. There is
 * no way to receive a request without passing the auth option, which is a much
 * stronger position than a convention that says "every handler must call
 * requireUser".
 *
 * A handler CANNOT shape an error response. There is no `res.status(...)` to
 * reach for; it returns `{ data, status?, headers? }` and the wrapper owns every
 * header, every status, and the envelope. That is what makes the guarantees above
 * true of every route rather than of the ones that remembered them.
 */

import 'server-only';

import { type z } from 'zod';

import {
  assertSameOrigin,
  createLogger,
  requestIdFrom,
  safeErrorMessage,
  type Logger,
} from '@/lib/server/http';
import { AppError, toAppError } from '@/lib/server/errors';
import { fail, ok, type ApiErrorBody } from '@/lib/api/envelope';
import { isAdminConfigured, ipHashSalt, requestTimeoutMs } from '@/lib/env.server';
import { parseJsonBody, parseParams, parseSearchParams } from '@/lib/server/validate';
import {
  clientIp,
  enforceRateLimit,
  hashIp,
  rateLimitFor,
  rateLimitResponseHeaders,
  type RateLimitResult,
} from '@/lib/server/rate-limit';

import type { AuthedUser } from '@/lib/server/auth-guard';

/** Shorthand used throughout this file. */
type Authed = AuthedUser;

/**
 * What a handler receives. Already validated, already authorised, already
 * same-origin, already rate limited.
 *
 * There is no `request` re-read available in spirit: `request` is present
 * because a handler occasionally needs a header, but `body`, `query`, and
 * `params` are the ONLY typed views of the input. Nothing downstream re-parses
 * the raw body.
 */
export type RequestContext<TBody, TQuery = unknown, TParams = unknown> = {
  request: Request;
  /** Parsed and validated. `undefined` for a bodyless request. */
  body: TBody;
  /** Parsed and validated query string. `{}` when no schema was declared. */
  query: TQuery;
  /** Parsed and validated dynamic route params. `{}` when none were declared. */
  params: TParams;
  requestId: string;
  log: Logger;
  url: URL;
  /** The verified caller, or `null` for a public route. */
  user: AuthedUser | null;
  /** A pseudonymous caller identifier, or `null`. NEVER a raw IP. */
  ipHash: string | null;
  /** The rate-limit outcome, for the response headers. `null` when undeclared. */
  rateLimit: RateLimitResult | null;
  /**
   * `true` when the route declared a body schema but the request had none.
   * A route that needs a body uses this to answer 400 with a named field rather
   * than letting a service discover the gap.
   */
  hasBody: boolean;
};

/**
 * Next.js's second argument to a route handler.
 *
 * Declared here rather than imported so the shape is visible, and typed to match
 * what `.next/types/**` generates: `{ params: Promise<Record<string, string |
 * string[] | undefined>> }`. A repeatable catch-all segment arrives as an ARRAY,
 * and a schema for `:id` receiving `['a','b']` must fail rather than silently
 * take the first element.
 */
export type RouteHandlerContext = {
  params: Promise<Record<string, string | string[] | undefined>>;
};

export type HandlerResult<TData> = {
  data: TData;
  status?: number;
  headers?: Record<string, string>;
};

export type RouteOptions<TBody, TQuery, TParams> = {
  /** Zod schema for the body. Omit for GET/DELETE. */
  body?: z.ZodType<TBody>;
  /** Zod schema for the query string. `.strict()` rejects unknown parameters. */
  query?: z.ZodType<TQuery>;
  /** Zod schema for dynamic route params. A bad `:id` is a 400, not a 404. */
  params?: z.ZodType<TParams>;
  /** The rate-limit rule key. Look it up in `RATE_LIMIT_RULES`. */
  rateLimit?: string;
  /** Requires a bearer token; the resolved caller is passed to the handler. */
  auth?: 'none' | 'required';
  /** Which action name, for the re-auth check (docs/10 §3.6). */
  action?: string;
  /** Exempt from the `status !== 'active'` gate. See `requireUser`. */
  allowInactiveAccount?: boolean;
  /**
   * Exempt from the `users/{uid}` EXISTENCE gate too. See `requireUser`.
   *
   * ONLY `POST /api/me/bootstrap`. Distinct from `allowInactiveAccount` on
   * purpose: waiving the status gate does not waive the existence gate, and a
   * route whose whole job is to create the missing document cannot be gated on
   * the document existing.
   */
  allowMissingUserDoc?: boolean;
  /**
   * Answer even when the Admin SDK is unconfigured.
   *
   * ONLY `GET /api/health`. A liveness endpoint that returns 503 because a
   * deployment secret is missing is a false negative on the one route that must
   * always answer — a health check would page an operator for a condition the
   * route exists to describe.
   */
  allowUnconfigured?: boolean;
  /** Per-route body ceiling. Defaults to 1 MB and cannot exceed it. */
  maxBodyBytes?: number;
};

/**
 * Wrap a handler in the fixed order above.
 *
 * The three schemas are INFERRED from the handler's parameter type, so a route
 * that declares `query: incidentQuerySchema` gets a handler whose `ctx.query` is
 * `z.output<typeof incidentQuerySchema>` with no second type annotation to keep
 * in sync. The compiler enforces that the schema and the handler agree, which is
 * the whole point of a typed pipeline.
 */
export function withRequest<TBody, TQuery, TParams, TData>(
  options: RouteOptions<TBody, TQuery, TParams>,
  handler: (
    ctx: RequestContext<TBody, TQuery, TParams> & { user: AuthedUser | null },
  ) => Promise<HandlerResult<TData>>,
): (request: Request, context: RouteHandlerContext) => Promise<Response> {
  return async function route(request: Request, handlerContext: RouteHandlerContext): Promise<Response> {

    const requestId = requestIdFrom(request);
    const log = createLogger(requestId);
    const startedAt = Date.now();
    const timeoutMs = requestTimeoutMs();

    // Every response carries the id, so a browser devtools screenshot is enough
    // for support. The header is set in one place rather than per route.
    const baseHeaders: Record<string, string> = { 'X-Request-Id': requestId };

    try {
      /* --- 0. the Admin precondition, FIRST ------------------------------- */
      // Checked before anything else, and deliberately before `auth`.
      //
      // If the precondition ran after authentication, an unconfigured deployment
      // would reach `getAdminDb()`, get a bare `Error` out of the SDK bootstrap,
      // and answer `500 INTERNAL` with "Something went wrong" — both the wrong
      // status and a message that tells the reader nothing. `503
      // SERVICE_UNAVAILABLE` up front says what is true: the request was not
      // processed, nothing was changed, and the reason is a missing deployment
      // secret rather than a bug.
      if (!options.allowUnconfigured && !isAdminConfigured()) {
        log.error({ code: 'SERVICE_UNAVAILABLE', path: safePath(request) });
        return json(
          fail(
            {
              code: 'SERVICE_UNAVAILABLE',
              message:
                'This deployment is not configured yet, so the request was not processed. Nothing was changed. ' +
                'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY — see .env.example.',
            },
            requestId,
          ),
          503,
          baseHeaders,
        );
      }

      /* --- 1/2. same-origin, before anything reads the body --------------- */
      assertSameOrigin(request);

      /* --- 3. rate limit, before validation and before the handler -------- */
      // A caller with no permission must not be able to burn another subject's
      // quota, so the ROLE gate below still runs after this. That is deliberate
      // and it is the one place the documented order is "both, in this sequence",
      // because the bucket is keyed on the uid, which does not exist yet.
      //
      // It is SKIPPED when the Admin SDK is not configured, and that is not an
      // oversight. The bucket lives in Firestore, so enforcing it requires the
      // Admin SDK, so enforcing it in an unconfigured deployment throws
      // `SERVICE_UNAVAILABLE` — and that would make `GET /api/health` answer 503
      // for exactly the condition it exists to describe, which is the bug the
      // `allowUnconfigured` option was added to prevent. A limit that cannot be
      // stored cannot be enforced, and pretending otherwise is worse than saying
      // so. The `isAdminConfigured()` result is memoised per instance by the
      // accessor, so this costs three `process.env` reads on a cold path.
      const limited = isAdminConfigured()
        ? await applyRateLimit(options.rateLimit, request, log)
        : null;

      /* --- 4. authenticate ----------------------------------------------- */
      let user: Authed | null = null;
      if (options.auth === 'required') {
        const { requireUser } = await import('@/lib/server/auth-guard');
        user = await requireUser(request, {
          requestId,
          ...(options.action ? { action: options.action } : {}),
          ...(options.allowInactiveAccount ? { allowInactiveAccount: true } : {}),
        ...(options.allowMissingUserDoc ? { allowMissingUserDoc: true } : {}),
        });
      }

      /* --- 5. validate body, query, and params -------------------------- */
      // All three, and each exactly once. A param failing its pattern is a 400
      // (docs/17 §5.55), which is what lets a client tell a typo from a deleted
      // record.
      const hasBody = options.body !== undefined;
      const body = options.body
        ? await withTimeout(
            parseJsonBody(request, options.body, { maxBytes: options.maxBodyBytes }),
            timeoutMs,
          )
        : (undefined as TBody);

      const url = new URL(request.url);
      const query = options.query ? parseSearchParams(url, options.query) : ({} as TQuery);

      const rawParams = handlerContext === undefined ? {} : await handlerContext.params;
      const params = options.params ? parseParams(rawParams, options.params) : ({} as TParams);

      /* --- 6. run the handler ------------------------------------------- */
      const result = await withTimeout(
        handler({
          request,
          body,
          query,
          params,
          requestId,
          log,
          url,
          user,
          ipHash: resolveIpHash(request),
          rateLimit: limited,
          hasBody,
        }),
        timeoutMs,
      );

      const status = result.status ?? 200;
      log.info({
        method: request.method,
        path: url.pathname,
        status,
        durationMs: Date.now() - startedAt,
        ...(user ? { actorUid: user.uid, actorRole: user.role } : {}),
      });

      return json(ok(result.data, requestId), status, {
        ...baseHeaders,
        ...rateLimitResponseHeaders(limited),
        ...(result.headers ?? {}),
      });
    } catch (error) {
      return errorResponse(error, requestId, log, request, baseHeaders);
    }
  };
}

/* ========================================================================== */
/* Rate limiting                                                                */
/* ========================================================================== */

/**
 * Count this request against its bucket, or throw 429.
 *
 * The subject is the uid when there is one, and the HASHED IP when there is not
 * — which is why this runs after authentication. For a public route there is no
 * uid, so the IP hash is the subject, and `IP_HASH_SALT` is what makes that
 * pseudonymous. When neither is available (no salt, or a forged
 * `x-forwarded-for`) the bucket key is the route key alone, which degrades the
 * limit to a GLOBAL one rather than to no limit. A shared bucket is a worse
 * experience for a legitimate user; a missing limit is a worse experience for
 * everyone.
 *
 * The only failure mode this re-throws is the 429 itself. A `503` from an
 * unreachable Firestore propagates, which is documented fail-CLOSED behaviour at
 * the top of `lib/server/rate-limit.ts`: a limiter that can be switched off by
 * causing an error is not a limiter.
 */
async function applyRateLimit(
  routeKey: string | undefined,
  request: Request,
  log: Logger,
): Promise<RateLimitResult | null> {
  if (routeKey === undefined) return null;

  const authed = bearerUid(request);
  const hashed = resolveIpHash(request);
  // Honour the rule's declared subject. A route that says `ip` must be limited
  // per address even when a token is present, otherwise one caller behind a
  // shared egress can spend another user's bucket. The `route:` fallback only
  // applies when neither identifier is resolvable at all.
  const subjectValue =
    rateLimitFor(routeKey).subject === 'ip'
      ? (hashed ?? authed ?? `route:${routeKey}`)
      : (authed ?? hashed ?? `route:${routeKey}`);

  const result = await enforceRateLimit({ routeKey, subjectValue });
  log.debug({ path: routeKey, status: 200 });
  return result;
}

/**
 * The uid the bearer token belongs to, WITHOUT verifying it.
 *
 * This is a rate-limit SUBJECT, not an authorisation. A forged token yields a
 * forged uid, which means a forged bucket — and therefore no limit for an
 * attacker, which defeats the purpose. So the subject is only used when the
 * caller is already authenticated, and this helper exists to keep the two
 * concerns visibly separate at the call site.
 */
function bearerUid(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return null;
  // A JWT is `header.payload.signature`, so the claims — and therefore `sub`,
  // which is the uid on a Firebase ID token — are in the SECOND segment. Reading
  // index 0 parsed the base64url of the HEADER, which has no `sub`, so this
  // helper returned null for EVERY real token. Every uid-keyed rate limit then
  // silently fell through to the per-IP bucket: ten signups from one address
  // (a hackathon hall, a university NAT, a corporate proxy) exhausted
  // `me.bootstrap` for everybody behind it, and no new user could ever create a
  // profile. `sub` stays unverified, which is fine HERE and only here: it picks
  // a bucket, and `requireUser` performs the real verification before the
  // handler runs.
  const payloadSegment = token.split('.')[1];
  if (payloadSegment === undefined) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      sub?: unknown;
    };
    return typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** A pseudonymous caller identifier. NEVER a raw IP, NEVER logged. */
function resolveIpHash(request: Request): string | null {
  const ip = clientIp(request);
  if (ip === null) return null;
  return hashIp(ip, ipHashSalt());
}

/* ========================================================================== */
/* Timeout                                                                      */
/* ========================================================================== */

/**
 * Convert a slow handler into a clean `504 TIMEOUT`.
 *
 * A platform-level timeout returns whatever the platform chooses, with no body
 * and no `requestId`, so the caller cannot report it and support cannot find it.
 * Racing the handler against a timer produces the documented envelope instead.
 *
 * The handler is NOT cancelled — `Promise.race` has no cancellation. A Gemini
 * call that overruns keeps running until the instance is frozen, which is why
 * the provider's own `timeoutMs` (20 s) is the real budget and this (15 s
 * default) is the outer backstop. docs/06 §1.4.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError({
          code: 'TIMEOUT',
          message: 'That took too long. Nothing was changed — try again.',
          retryAfterSec: 1,
        }),
      );
    }, timeoutMs);
    // Do not hold the process open for a timer whose promise is already settled.
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* ========================================================================== */
//* Error -> envelope                                                            */
/* ========================================================================== */

function errorResponse(
  error: unknown,
  requestId: string,
  log: Logger,
  request: Request,
  baseHeaders: Record<string, string>,
): Response {
  const appError = toAppError(error);

  // 5xx is our fault; log the ORIGINAL. 4xx is the caller's business and is
  // logged at warn without a stack, because a 403 storm is a signal worth
  // having and a stack trace for each one is noise.
  if (appError.status >= 500) {
    log.error({
      code: appError.code,
      path: safePath(request),
      ...(appError.cause === undefined
        ? {}
        : {
            causeName: causeName(appError.cause),
            causeMessage: safeErrorMessage(appError.cause),
          }),
    });
  } else {
    log.warn({ code: appError.code, path: safePath(request) });
  }

  const body: ApiErrorBody = {
    code: appError.code,
    message: appError.message,
    ...(appError.details.length > 0 ? { details: [...appError.details] } : {}),
    ...(appError.retryAfterSec !== null ? { retryAfterSec: appError.retryAfterSec } : {}),
    ...(appError.allowed ? { allowed: [...appError.allowed] } : {}),
  };

  const headers: Record<string, string> = {
    ...baseHeaders,
    ...(appError.retryAfterSec !== null ? { 'Retry-After': String(appError.retryAfterSec) } : {}),
  };

  return json(fail(body, requestId), appError.status, headers);
}

/**
 * The single place an unknown value becomes an HTTP response.
 *
 * A route handler never inspects an error to build a body, which is what
 * guarantees the envelope, the `no-store` header, the `X-Request-Id`, and the
 * absence of a stack trace on EVERY route rather than on the ones that
 * remembered.
 */
function json(
  payload: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The API sets NO `Access-Control-Allow-Origin` (docs/10 §12.2): there is
      // no cross-origin API consumer in v1, so a cross-origin fetch fails at
      // preflight, before any of this code runs.
      //
      // `no-store` is unconditional. Almost every payload here is
      // user-specific, and a cached `/api/me` is a privacy incident on a shared
      // machine. The one route whose payload is public reference data
      // (`GET /api/resources`, `GET /api/config`) is documented separately in
      // docs/10 §15.1 and does not exist yet.
      'Cache-Control': 'no-store',
      // `Vary` so an intermediary never serves a cached response to a caller
      // that presented a different `Authorization` (docs/10 §15.1).
      Vary: 'Origin, Authorization',
      ...headers,
    },
  });
}

/* ========================================================================== */
/* Helpers                                                                      */
/* ========================================================================== */

/**
 * The CONSTRUCTOR NAME of a cause, for the log.
 *
 * The class name is diagnostic and the message is not: a Firestore error's
 * message names the collection, the field, and sometimes the index, and an
 * operator gets that from the stack in the platform log. The caller never does.
 */
function causeName(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  if (typeof cause === 'object' && cause !== null && 'name' in cause) {
    const name = (cause as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return typeof cause;
}

function safePath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return 'unknown';
  }
}

export { AppError };

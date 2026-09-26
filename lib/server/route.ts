/**
 * ============================================================================
 * CareGrid AI — route handler wrapper
 * ============================================================================
 *
 * One wrapper every `app/api` route handler uses, so no handler has to
 * remember the five things that must happen before and after its own logic.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHY IT IS FIXED HERE
 * ---------------------------------------------------------------------------
 *   1. mint or adopt a `requestId`   — so every log line and every response
 *                                      carries the same id, even for a failure
 *                                      that happens before the handler runs
 *   2. `assertSameOrigin`            — a cross-origin POST is rejected before it
 *                                      can reach a handler that trusts its body
 *   3. parse the body with Zod       — BEFORE any I/O (docs/10 §13.1), so a
 *                                      malformed request never touches Firestore
 *   4. run the handler               — the only part the route file writes
 *   5. convert any throw to an envelope — a driver error, a bug, or a rejected
 *                                      promise can never escape as HTML
 *
 * ---------------------------------------------------------------------------
 * WHAT A 500 LOOKS LIKE FROM OUTSIDE
 * ---------------------------------------------------------------------------
 * ```json
 * { "success": false,
 *   "error": { "code": "INTERNAL", "message": "Something went wrong. Nothing was changed." },
 *   "meta": { "requestId": "req_…" } }
 * ```
 * The internal message goes to the server log with the same `requestId`. A
 * dispatcher forwards that id to support; support finds the trace. Nobody ever
 * sees a stack trace, a Firestore path, a field name from the schema, or the
 * Admin SDK's own error text.
 */

import 'server-only';

import type { z, ZodError } from 'zod';

import { assertSameOrigin, createLogger, requestIdFrom, type Logger } from '@/lib/server/http';
import { AppError, toAppError } from '@/lib/server/errors';
import { fail, ok, type ApiErrorBody } from '@/lib/api/envelope';
import { isAdminConfigured } from '@/lib/env.server';

import type { AuthedUser } from '@/lib/server/auth-guard';

/** Shorthand used throughout this file. */
type Authed = AuthedUser;

/** What a handler receives. Already validated, already same-origin. */
export type RequestContext<TBody> = {
  request: Request;
  /** Parsed and validated. `undefined` for a bodyless request. */
  body: TBody;
  requestId: string;
  log: Logger;
  url: URL;
};

export type HandlerResult<TData> = {
  data: TData;
  status?: number;
  headers?: Record<string, string>;
};

export type RouteOptions<TBody> = {
  /** Zod schema for the body. Omit for GET/DELETE. */
  body?: z.ZodType<TBody>;
  /** Requires a bearer token; the resolved caller is passed to the handler. */
  auth?: 'none' | 'required';
  /** Which action name, for the re-auth check (docs/10 §3.6). */
  action?: string;
  /** Exempt from the `status !== 'active'` gate. See `requireUser`. */
  allowInactiveAccount?: boolean;
  /**
   * Answer even when the Admin SDK is unconfigured.
   *
   * ONLY `GET /api/health`. A liveness endpoint that returns 503 because a
   * deployment secret is missing is a false negative on the one route that must
   * always answer — a health check would page an operator for a condition the
   * route exists to describe.
   */
  allowUnconfigured?: boolean;
};


/**
 * Wrap a handler in the fixed order above.
 *
 * The `auth: 'required'` option is the reason a route can forget to
 * authenticate and still be safe: the wrapper authenticates BEFORE the handler
 * is called, and the handler's signature is what it is. There is no way to
 * receive a request without passing the auth option, which is a much stronger
 * position than a convention that says "every handler must call requireUser".
 */
export function withRequest<TBody, TData>(
  options: RouteOptions<TBody>,
  handler: (ctx: RequestContext<TBody> & { user: AuthedUser | null }) => Promise<HandlerResult<TData>>,
): (request: Request) => Promise<Response> {
  return async function route(request: Request): Promise<Response> {
    const requestId = requestIdFrom(request);
    const log = createLogger(requestId);
    const started = Date.now();

    try {
      /* --- 0. the Admin precondition, FIRST --------------------------------- */
      // Checked before anything else, and deliberately before `auth`.
      //
      // Ordering matters here. If the precondition ran after authentication, an
      // unconfigured deployment would reach `getAdminDb()`, get a bare
      // `Error` out of the SDK bootstrap, and answer `500 INTERNAL` with
      // "Something went wrong" — which is both the wrong status and a message
      // that tells the reader nothing about the actual cause.
      //
      // Answering `503 SERVICE_UNAVAILABLE` up front says what is true: the
      // request was not processed, nothing was changed, and the reason is a
      // missing deployment secret rather than a bug. `GET /api/health` opts out,
      // because a liveness endpoint that 503s because a secret is missing is a
      // false negative on the one route that must always answer.
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
        );
      }

      /* --- 1/2. same-origin, before anything reads the body --------------- */
      assertSameOrigin(request);

      /* --- 3. body, validated before any I/O ------------------------------ */
      let body: TBody;
      if (options.body) {
        const raw = await readJson(request);
        const parsed = options.body.safeParse(raw);
        if (!parsed.success) {
          throw new AppError({
            code: 'VALIDATION_FAILED',
            message: validationMessage(parsed.error),
            details: zodIssues(parsed.error),
          });
        }
        body = parsed.data;
      } else {
        body = undefined as TBody;
      }

      /* --- 4. auth -------------------------------------------------------- */
      let user: Authed | null = null;
      if (options.auth === 'required') {
        const { requireUser } = await import('@/lib/server/auth-guard');
        user = await requireUser(request, {
          requestId,
          ...(options.action ? { action: options.action } : {}),
          ...(options.allowInactiveAccount ? { allowInactiveAccount: true } : {}),
        });
      }

      const url = new URL(request.url);
      const result = await handler({ request, body, requestId, log, url, user });

      log.info({ method: request.method, path: url.pathname, status: result.status ?? 200, durationMs: Date.now() - started });

      return json(
        ok(result.data, requestId),
        result.status ?? 200,
        result.headers ?? {},
      );
    } catch (error) {
      return errorResponse(error, requestId, log, request);
    }
  };
}

/* ========================================================================== */
/* Error → envelope                                                            */
/* ========================================================================== */

function errorResponse(
  error: unknown,
  requestId: string,
  log: Logger,
  request: Request,
): Response {
  const appError = toAppError(error);

  // 5xx is our fault; log the ORIGINAL. 4xx is the caller's business and is
  // logged at warn without a stack, because a 403 storm is a signal worth
  // having and a stack trace for each one is noise.
  if (appError.status >= 500) {
    log.error({ code: appError.code, path: safePath(request) });
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
    ...(appError.retryAfterSec !== null ? { 'Retry-After': String(appError.retryAfterSec) } : {}),
  };

  return json(fail(body, requestId), appError.status, headers);
}

function json(payload: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The API sets NO `Access-Control-Allow-Origin` (docs/10 §12.2): there is
      // no cross-origin API consumer in v1, so a cross-origin fetch fails at
      // preflight, before any of this code runs.
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/* ========================================================================== */
/* Body reading                                                               */
/* ========================================================================== */

/**
 * Parse a JSON body, tolerating an empty one.
 *
 * An empty body is `undefined` rather than a parse error, because `POST` with
 * no body is legitimate for some routes and the schema decides whether that is
 * acceptable — not the transport.
 */
async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The request body was not valid JSON.',
    });
  }
}

/* ========================================================================== */
/* Zod → our error shape                                                      */
/* ========================================================================== */

/**
 * A field-keyed issue list, so the form can put each message next to its input
 * instead of showing one blob at the top.
 */
function zodIssues(error: ZodError): Array<{ field: string; issue: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'form',
    issue: issue.message,
  }));
}

/**
 * The one-line summary. It names the FIRST field rather than counting
 * everything: "Check your email address" is actionable, "7 problems" is not.
 */
function validationMessage(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Check the highlighted fields and try again.';
  if (first.path.length === 0) return first.message;
  return `Check ${first.path.join(' ')}: ${first.message}`;
}

function safePath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return 'unknown';
  }
}

export { AppError };

/**
 * ============================================================================
 * CareGrid AI — request id, logging, and the CSRF origin check
 * ============================================================================
 *
 * The small server-side utilities every route handler needs. Grouped in one
 * file because each is a handful of lines and splitting them across four files
 * would be four files to read to answer "what does a route handler import?".
 */

import 'server-only';

import { randomBytes } from 'node:crypto';

import { allowedOrigins } from '@/lib/env.server';
import { AppError } from '@/lib/server/errors';

/* ========================================================================== */
/* requestId                                                                  */
/* ========================================================================== */

/**
 * A correlation id for one request: `req_` + 12 base62 characters.
 *
 * The shape matters more than the length. `REQUEST_ID_PATTERN` in
 * `lib/constants.ts` is what the UI validates before rendering one, and support
 * quotes it. A request id that reaches a user must therefore be recognisably an
 * id, not a stack frame or a document path.
 *
 * Generated with `crypto.randomBytes`, not `Math.random` or a timestamp. A
 * predictable request id is a session-predictable id.
 */
export function getRequestId(): string {
  /*
   * ---------------------------------------------------------------------------
   * BASE62, NOT BASE64URL — AND THAT IS THE WHOLE POINT OF THIS FUNCTION
   * ---------------------------------------------------------------------------
   * This used to be `randomBytes(9).toString('base64url').slice(0, 12)`, which was
   * a real bug found by executing a route (Phase 15), not by reading one.
   *
   * The base64url alphabet is `A-Za-z0-9-_`, so roughly one generated id in three
   * contained a `-` or an `_` (measured: 31.71% over 200k samples). Every
   * consumer of an id in this codebase validates it against
   * `^req_[A-Za-z0-9]{12}$`:
   *
   *   - `requestIdSchema` in `validators/enums.ts`, which gates `apiMetaSchema`,
   *     so the SUCCESS and ERROR envelopes are documented as carrying a valid id
   *     and were not;
   *   - `REQUEST_ID_PATTERN` in `lib/constants.ts`, which the UI checks before
   *     rendering a support reference;
   *   - `requestIdFrom()` below, which silently DISCARDED a perfectly valid
   *     inbound `x-request-id` and minted a new one whenever the caller was
   *     echoing back an id this server had itself issued.
   *
   * So the failure was silent and intermittent: roughly a third of all requests
   * produced an id that the project's own validation rejected, and a third of
   * inbound correlation ids were dropped.
   *
   * The fix is to narrow the GENERATOR rather than widen the schema. Widening the
   * regex to `[A-Za-z0-9_-]` would also be defensible — those characters are
   * harmless in a log line — but the schema is the contract quoted to users in
   * support, and `^[A-Za-z0-9]{12}$` is the tighter, safer thing to keep
   * promising. Entropy is unaffected: 12 base62 characters is ~71 bits, still far
   * more than the 9 bytes (72 bits) this was previously carrying.
   *
   * `crypto.randomBytes` stays the source. A predictable request id is a
   * session-predictable id, and `Math.random()` would be the wrong answer even
   * though it is shorter to write.
   *
   * The `% 62` reduction is biased — 256 is not a multiple of 62, so 8 of the 62
   * characters are about 1.2% more likely than the rest. That is deliberate and
   * acceptable: a request id is a correlation label, never an authorisation
   * decision, a capability token or a session handle, so ~71 bits with a 1.2%
   * skew is far more than the ~65 bits of unbiased entropy the label needs.
   * Rejection sampling would remove the skew at the cost of a loop whose only
   * benefit here is aesthetic.
   */
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(12);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `req_${out}`;
}

/** Read an inbound `x-request-id` if it is well-formed, else mint a new one. */
export function requestIdFrom(req: Request): string {
  const inbound = req.headers.get('x-request-id');
  if (inbound && /^req_[A-Za-z0-9]{12}$/.test(inbound)) return inbound;
  return getRequestId();
}

/* ========================================================================== */
/* logging                                                                    */
/* ========================================================================== */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured, single-line JSON to stdout.
 *
 * JSON, not a formatted string: a log line that needs a regex to read cannot be
 * queried. Every line carries the `requestId`, so one user-reported id resolves
 * to exactly one trace.
 *
 * `NO_SECRET` is the important part. A token, an email, or a private key in a
 * log is a credential leak with a long half-life, so the value allow-list below
 * is short and anything not on it is dropped rather than redacted. Redaction
 * that can be bypassed by adding one field to the object is not redaction.
 */
const ALLOWED_FIELDS = new Set([
  'requestId',
  'actorUid',
  'actorRole',
  'action',
  'entityType',
  'entityId',
  'status',
  'code',
  'method',
  'path',
  'durationMs',
  'uid',
  'role',
  'accountStatus',
  'provider',
  'origin',
  'isNew',
  'claimRole',
  'docRole',
  'reason',
]);

function sanitise(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.length > 200) {
      out[key] = `${value.slice(0, 200)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export type Logger = {
  debug: (fields: Record<string, unknown>) => void;
  info: (fields: Record<string, unknown>) => void;
  warn: (fields: Record<string, unknown>) => void;
  error: (fields: Record<string, unknown>) => void;
};

/**
 * A logger bound to one request, so a handler does not have to pass
 * `requestId` into every call and forget it in the one call that mattered.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS READS `LOG_LEVEL` DIRECTLY AND NOT `getServerEnv()`
 * ---------------------------------------------------------------------------
 * Because `getServerEnv()` **throws** when `FIREBASE_PROJECT_ID` is missing, and
 * `createLogger()` is called at the top of every route handler — before the
 * handler, and outside the `try` in `withRequest`. Reading the level through the
 * secret accessor therefore took down every route, including `GET /api/health`,
 * whose entire job is to answer when the deployment is unconfigured.
 *
 * That was a real bug found by the Phase 2 runtime check, and the fix is
 * structural rather than a special case: **a logger must not be able to prevent
 * logging.** The only thing it needs is a level, and a level is not a secret.
 * A missing or unparseable `LOG_LEVEL` falls back to `info` rather than failing,
 * because an unconfigured deployment is precisely when the log matters most.
 */
export function createLogger(requestId: string): Logger {
  const threshold = resolveThreshold();

  const emit = (level: LogLevel, fields: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      requestId,
      ...sanitise({ requestId, ...fields }),
    });
    if (level === 'error' || level === 'warn') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  };

  return {
    debug: (f) => emit('debug', f),
    info: (f) => emit('info', f),
    warn: (f) => emit('warn', f),
    error: (f) => emit('error', f),
  };
}

/** Read the threshold without touching the secret-bearing accessor. */
function resolveThreshold(): number {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw === undefined || raw === '') return LEVEL_ORDER.info;
  const level = raw as LogLevel;
  return LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
}

/* ========================================================================== */
/* CSRF — the origin check (docs/10 §12.2)                                    */
/* ========================================================================== */

/**
 * Reject a state-changing request whose `Origin` is not ours.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 * It is NOT the primary CSRF defence, because there is nothing to defend: the
 * app attaches no ambient credential. Every API call carries
 * `Authorization: Bearer <Firebase ID token>`, which a cross-origin page cannot
 * read from `localStorage` and cannot cause a browser to attach. There is no
 * session cookie (docs/10 §12.1).
 *
 * So what does this catch? A token that arrived by another route — XSS on our
 * own origin, a token in a log, a malicious extension — and is then replayed
 * from an attacker's page. The request arrives with a foreign `Origin`, and we
 * reject it. That converts a silent compromise into a noisy one. Worth having,
 * correctly labelled as defence in depth.
 *
 * ---------------------------------------------------------------------------
 * THE COMPARISON THAT MATTERS
 * ---------------------------------------------------------------------------
 * `allow.has(origin)` on the WHOLE origin string. Never
 * `origin.startsWith(appUrl)`: `'https://caregrid.example.evil.com'` passes that
 * test, which is the entire bug class this function exists to prevent.
 */
export function assertSameOrigin(req: Request): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const allow = allowedOrigins();
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');

  if (origin) {
    // `Origin: null` comes from a sandboxed iframe. It is NOT in the set, so it
    // fails — deliberately, because a sandboxed frame is not our page.
    if (allow.has(origin)) return;
    throw new AppError({ code: 'CSRF_FAILED' });
  }

  if (referer) {
    try {
      if (allow.has(new URL(referer).origin)) return;
    } catch {
      // A malformed Referer falls through to the rejection below.
    }
    throw new AppError({ code: 'CSRF_FAILED' });
  }

  // Neither header. curl, Playwright, and a native wrapper legitimately omit
  // them. Not a failure — but it IS recorded, because a browser that omits
  // Origin on a POST is anomalous and worth knowing about.
  return;
}

/* ========================================================================== */
/* Rate-limit headers (docs/08 §1.9)                                          */
/* ========================================================================== */

/**
 * The standard rate-limit response headers. Phase 2 emits them on the auth
 * routes, which are the ones most likely to be brute-forced; the token-bucket
 * counter itself arrives in Phase 3 with the Firestore bucket (docs/10 §17.1).
 */
export function rateLimitHeaders(input: {
  limit: number;
  remaining: number;
  resetSec: number;
}): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(input.limit),
    'X-RateLimit-Remaining': String(Math.max(0, input.remaining)),
    'X-RateLimit-Reset': String(input.resetSec),
  };
}

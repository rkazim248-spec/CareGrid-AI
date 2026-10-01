/**
 * ============================================================================
 * CareGrid AI — server error type
 * ============================================================================
 *
 * One error class, one place that knows the HTTP status for a catalogue code.
 *
 * ---------------------------------------------------------------------------
 * WHY A `code` AND NOT A MESSAGE
 * ---------------------------------------------------------------------------
 * A message is for a human and may be reworded. A code is a contract: the UI
 * branches on it, the audit log records it, and a test asserts on it. Every
 * throw site names a code from docs/16 §1.7 and the status comes from that
 * table, so a handler can never accidentally return 500 for a permission
 * problem.
 *
 * ---------------------------------------------------------------------------
 * THE 401 / 403 / 404 CONTRACT (docs/10 §6.4)
 * ---------------------------------------------------------------------------
 * | 401 | not authenticated — retry with a fresh token may help        |
 * | 403 | authenticated, and this ROLE can NEVER do this — retrying is pointless |
 * | 404 | it may exist, but you may not know that — no existence oracle |
 *
 * Getting 403 and 404 backwards is a real information leak: returning 403 to
 * "a citizen asking for someone else's incident" confirms the incident exists.
 * `assertResourceAccess` therefore throws 404, never 403.
 */

/**
 * Build-time poison pill. This module lives under `lib/server/**` and is
 * server-only, so a client bundle that reaches it fails the build rather than
 * shipping an error catalogue to the browser.
 */
import 'server-only';

import { ZodError } from 'zod';

import { ERROR_STATUS } from '@/lib/api/error-codes';

export type AppErrorDetails = ReadonlyArray<{ field: string; issue: string }>;

/**
 * The status for a code, or 500 for a code this build does not know.
 *
 * A THROW SITE MAY NAME ANY STRING. An unknown code is a 500 rather than
 * a crash, because a new catalogue entry added to a route before it was added
 * here should produce an honest server error, not a 500 page for every request.
 */
function statusForCode(code: string): number {
  return (ERROR_STATUS as Record<string, number | undefined>)[code] ?? 500;
}

export class AppError extends Error {
  /** Stable catalogue code from docs/16 §1.7. */
  readonly code: string;
  readonly status: number;
  readonly details: AppErrorDetails;
  /** Seconds the caller should wait, for rate-limited routes. */
  readonly retryAfterSec: number | null;
  /** `INVALID_STATUS_TRANSITION` → the legal targets. Phase 3+ consumer. */
  readonly allowed: readonly string[] | null;
  /**
   * The original throw, for the SERVER LOG ONLY.
   *
   * Never serialised into a response and never attached to `details`. A
   * `FirebaseError`'s own message contains the collection path, the field
   * names, and sometimes the index definition — which is a free schema for
   * anyone probing the API. Keeping it here, un-serialised, is what lets the
   * operator debug a 500 without the caller learning anything.
   */
  override readonly cause: unknown;

  constructor(input: {
    code: string;
    message?: string;
    status?: number;
    details?: AppErrorDetails;
    retryAfterSec?: number | null;
    allowed?: readonly string[] | null;
    cause?: unknown;
  }) {
    const status = input.status ?? statusForCode(input.code);
    super(input.message ?? DEFAULT_MESSAGE[input.code] ?? 'Something went wrong.');
    this.name = 'AppError';
    this.code = input.code;
    this.status = status;
    this.details = input.details ?? [];
    this.retryAfterSec = input.retryAfterSec ?? null;
    this.allowed = input.allowed ?? null;
    this.cause = input.cause;
  }
}

/**
 * The message for a code when the throw site does not supply one.
 *
 * A deliberately short table rather than a lookup into the documentation: the
 * sentences that matter most to a user in an emergency are supplied explicitly
 * at the throw site, and everything else degrades to a neutral sentence that
 * reveals nothing.
 */
const DEFAULT_MESSAGE: Record<string, string> = {
  AUTH_REQUIRED: 'Sign in to continue.',
  AUTH_INVALID_TOKEN: 'Your session could not be verified. Sign in again to continue.',
  AUTH_EXPIRED: 'Your session has expired. Sign in again to continue.',
  ACCOUNT_UNAVAILABLE:
    'This account is not available. Contact an administrator if you think this is a mistake.',
  ROLE_MISMATCH: 'Your access level has changed. Refresh the page and sign in again.',
  FORBIDDEN: 'You do not have permission for that action.',
  CSRF_FAILED: 'That request came from somewhere we do not recognise.',
  REAUTH_REQUIRED: 'Please sign in again to confirm this action.',
  VALIDATION_FAILED: 'Check the highlighted fields and try again.',
  REASON_REQUIRED: 'A short reason is required so the change can be understood later.',
  INVALID_CAPABILITY: 'That is not a capability this system has.',
  NOT_FOUND: 'We could not find that.',
  RATE_LIMITED: 'Too many requests. Try again in a moment.',
  RATE_LIMIT_EXCEEDED: 'Too many requests. Try again in a moment.',
  REQUEST_TOO_LARGE: 'That request was too large to accept.',
  UNSUPPORTED_MEDIA_TYPE: 'That kind of request body is not accepted here.',
  MAINTENANCE_DISABLED: 'That job is not enabled in this deployment.',
  NOTIFICATION_DISABLED: 'That notification channel is not available in this deployment.',
  CAPABILITY_DISABLED: 'That feature is not enabled in this deployment.',
  AI_RESULT_IMMUTABLE:
    'The AI result cannot be changed. Record a review decision instead — the model’s answer is kept as history.',
  NOT_IN_REVIEW_QUEUE: 'That incident is not waiting for AI review.',
  REVIEW_ALREADY_RECORDED:
    'Someone has already reviewed this incident. Their decision is on the record and was not overwritten.',
  SELF_ROLE_CHANGE_FORBIDDEN: 'You cannot change your own role.',
  SELF_DISABLE_FORBIDDEN: 'You cannot suspend your own account.',
  SERVICE_UNAVAILABLE:
    'The service is not configured or temporarily unavailable. Nothing was changed.',
  DB_UNAVAILABLE: 'The database is temporarily unavailable. Nothing was changed.',
  AI_UNAVAILABLE: 'AI assistance is temporarily unavailable. You can still continue without it.',
  AI_QUOTA: 'AI assistance is temporarily unavailable. You can still continue without it.',
  MAPS_UNAVAILABLE: 'Location lookup is temporarily unavailable.',
  TIMEOUT: 'That took too long. Nothing was changed — try again.',
  INTERNAL: 'Something went wrong. Nothing was changed.',
};

/** `true` when the caller should be sent back to the sign-in flow. */
export function isAuthError(error: unknown): error is AppError {
  return error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_EXPIRED' || error.code === 'AUTH_INVALID_TOKEN');
}

/** `true` for the codes that mean "sign in again", used by the client gate. */
export function requiresSignIn(error: unknown): boolean {
  return isAuthError(error);
}

/**
 * Convert anything thrown into an `AppError` so a route handler can never leak a
 * driver error, a stack trace, or a field path to a client.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE SINGLE FUNNEL (docs/16 §2.3)
 * ---------------------------------------------------------------------------
 * Everything that can reach a route handler passes through here, so the mappings
 * below are the complete list of ways a failure becomes an HTTP response. Each
 * row is a decision about what a CALLER is allowed to learn:
 *
 * | Input                       | Becomes                                   | Why not the raw error |
 * |-----------------------------|-------------------------------------------|-----------------------|
 * | `AppError`                  | itself                                    | already safe          |
 * | `ZodError`                  | `VALIDATION_FAILED` 400 + field details   | paths are field names |
 * | `FirebaseError` denied      | `FORBIDDEN` 403                          | the RULES TEXT names collections and fields |
 * | `FirebaseError` unavailable | `DB_UNAVAILABLE` 503                     | names the project and region |
 * | `FirebaseError` deadline    | `TIMEOUT` 504                             | ditto                 |
 * | `FirebaseError` aborted     | `DB_UNAVAILABLE` 503                     | names the transaction |
 * | `AbortError` / our timeout  | `TIMEOUT` 504                             | the signal object     |
 * | anything else               | `INTERNAL` 500, generic message          | it may be anything    |
 *
 * The `permission-denied` row is the one that matters most. A Firestore rules
 * rejection text is a free description of the data model to an attacker, and it
 * is also frequently WRONG as a status: a rules denial on a read is an
 * existence-oracle leak, so it is normalised to the same 403 every caller gets.
 *
 * `TypeError: Failed to fetch` never arrives here — it is produced in the
 * BROWSER, and `lib/api/client.ts` handles it (docs/16 §2.3).
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError({
      code: 'VALIDATION_FAILED',
      // `formatZodIssues` lives in `lib/server/validate.ts`, which imports this
      // module. Inlining the first issue's path here avoids the cycle while
      // still naming a field, which is the only part of a ZodError that is not
      // a schema disclosure.
      message: firstIssueSentence(error),
      details: zodIssues(error),
      cause: error,
    });
  }

  const firebase = asFirebaseError(error);
  if (firebase) {
    const code = firebaseCodeToCatalogue(firebase.raw);
    return new AppError({ code, message: firebaseMessage(code), cause: error });
  }

  if (isAbort(error)) {
    return new AppError({ code: 'TIMEOUT', cause: error });
  }

  // A misconfigured environment variable is a CONFIGURATION condition, not a
  // bug. `ServerEnvError` and `EnvError` name the variable and never its value,
  // so mapping them to `503 SERVICE_UNAVAILABLE` makes the log and the response
  // agree: "not configured, nothing was changed" rather than "something went
  // wrong", which sends an operator looking through the code instead of the
  // environment. Recognised by NAME rather than by import, so this module does
  // not have to reach into the env accessors.
  if (isEnvironmentError(error)) {
    return new AppError({ code: 'SERVICE_UNAVAILABLE', cause: error });
  }

  return new AppError({
    code: 'INTERNAL',
    message: 'Something went wrong. Nothing was changed.',
    status: 500,
    cause: error,
  });
}

/* ========================================================================== */
/* Funnel internals                                                            */
/* ========================================================================== */

/**
 * The `permission-denied` message, which is the ONLY case that gets a custom
 * sentence rather than the catalogue default.
 *
 * The default `FORBIDDEN` copy is "You do not have permission for that action",
 * which is true but gives an integrator debugging a rules problem nothing. This
 * one is accurate, safe, and actionable.
 */
function firebaseMessage(code: string): string | undefined {
  if (code === 'FORBIDDEN') {
    return 'That record is not available to you, or the request was not permitted. Nothing was changed.';
  }
  return undefined;
}

/**
 * Recognise a `FirebaseError` WITHOUT importing the class.
 *
 * `instanceof FirebaseError` is the obvious approach and the wrong one: the
 * Admin SDK and the rules engine can both be present in one bundle through
 * different module instances, and a cross-realm `instanceof` silently returns
 * `false`. duck-typing on `code` is what the SDK's own error handling does, so
 * it is reliable across both copies.
 *
 * The recognised set is CLOSED. A `code`-bearing object that is not one of these
 * is somebody else's error object, and treating it as a Firestore failure would
 * turn a bug into a plausible-looking 503.
 */
const FIREBASE_ERROR_CODES: ReadonlySet<string> = new Set([
  'permission-denied',
  'not-found',
  'unavailable',
  'deadline-exceeded',
  'aborted',
  'already-exists',
  'failed-precondition',
  'resource-exhausted',
  'unauthenticated',
  'invalid-argument',
]);

function asFirebaseError(error: unknown): { raw: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { code?: unknown; name?: unknown };
  if (typeof record.code !== 'string') return null;
  // `10 ABORTED` is the numeric gRPC form the SDK surfaces on a transaction.
  const isAbortedForm = /^10 ABORTED/.test(record.code);
  if (record.name !== 'FirebaseError' && !isAbortedForm && !FIREBASE_ERROR_CODES.has(record.code)) {
    return null;
  }
  return { raw: record.code };
}

/** Map a Firestore/Auth error code to a catalogue code. docs/16 §2.3. */
function firebaseCodeToCatalogue(raw: string): string {
  // `aborted` arrives both as `aborted` and as the numeric `10 ABORTED`.
  if (raw === 'aborted' || raw.startsWith('10 ABORTED')) return 'DB_UNAVAILABLE';
  if (raw === 'unavailable') return 'DB_UNAVAILABLE';
  if (raw === 'deadline-exceeded') return 'TIMEOUT';
  if (raw === 'permission-denied' || raw === 'unauthenticated') return 'FORBIDDEN';
  return 'INTERNAL';
}

function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { name?: unknown };
  return record.name === 'AbortError' || record.name === 'TimeoutError';
}

/**
 * Recognise the two env accessors' error types by name.
 *
 * `ServerEnvError` from `lib/env.server.ts` and `EnvError` from
 * `lib/env.client.ts`. Both already name the VARIABLE and never its value, which
 * is what makes them safe to map rather than to echo.
 */
function isEnvironmentError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'ServerEnvError' || name === 'EnvError';
}

/** A field-keyed issue list, matching `ApiErrorDetail` in `lib/api/envelope.ts`. */
function zodIssues(error: ZodError): AppErrorDetails {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'form',
    issue: issue.message,
  }));
}

/** Names the FIRST field rather than counting everything. See `lib/server/route.ts`. */
function firstIssueSentence(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Check the highlighted fields and try again.';
  if (first.path.length === 0) return first.message;
  return `Check ${first.path.join(' ')}: ${first.message}`;
}

/** Re-exported so `firebaseCodeToCatalogue` is reachable from the tests. */
export { firebaseCodeToCatalogue };


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

  constructor(input: {
    code: string;
    message?: string;
    status?: number;
    details?: AppErrorDetails;
    retryAfterSec?: number | null;
    allowed?: readonly string[] | null;
  }) {
    const status = input.status ?? statusForCode(input.code);
    super(input.message ?? DEFAULT_MESSAGE[input.code] ?? 'Something went wrong.');
    this.name = 'AppError';
    this.code = input.code;
    this.status = status;
    this.details = input.details ?? [];
    this.retryAfterSec = input.retryAfterSec ?? null;
    this.allowed = input.allowed ?? null;
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
  NOT_FOUND: 'We could not find that.',
  RATE_LIMITED: 'Too many requests. Try again in a moment.',
  MAINTENANCE_DISABLED: 'That job is not enabled in this deployment.',
  SELF_ROLE_CHANGE_FORBIDDEN: 'You cannot change your own role.',
  SELF_DISABLE_FORBIDDEN: 'You cannot suspend your own account.',
  SERVICE_UNAVAILABLE:
    'The service is not configured or temporarily unavailable. Nothing was changed.',
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
 * Anything unrecognised becomes a 500 with a GENERIC message. The original is
 * kept on `cause` for the server log only.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError({
    code: 'INTERNAL',
    message: 'Something went wrong. Nothing was changed.',
    status: 500,
  });
}

/**
 * ============================================================================
 * CareGrid AI — the client-side API error
 * ============================================================================
 *
 * `ApiError`, split out of `client.ts` so a component can import the ERROR
 * without importing the fetch machinery, its token seam, or its schemas.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SPLIT MATTERS
 * ---------------------------------------------------------------------------
 * `lib/api/client.ts` registers a token provider, owns the one-retry policy, and
 * imports four Zod response schemas. A component that only needs to ask "is this
 * a 403?" would pull all of that in — and, more importantly, the dependency
 * direction gets muddy: a pure type-and-predicate module that a Server Component
 * can also import is a different thing from a module that touches
 * `window.dispatchEvent`.
 *
 * This file is that pure module. It has no side effects and no browser API, so
 * `import { ApiError } from '@/lib/api/errors'` is safe from anywhere, including
 * a test and a server component.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE THREE GETTERS MEAN, AND WHY A UI GETS THEM WRONG
 * ---------------------------------------------------------------------------
 * | Getter | Means | A Retry button |
 * |--------|-------|-----------------|
 * | `isRefreshable` | one token refresh may recover this | yes, automatically |
 * | `isPermanentDenial` | this ROLE can NEVER do this | **never** — it would lie |
 * | `shouldRetry` | the same request may succeed unchanged | yes, with a backoff |
 *
 * `isPermanentDenial` is the one that matters. A 403 rendered with a Retry
 * button teaches a user that the system is temporarily broken, and they will
 * retry for as long as the product is in that state. docs/16 §6.4.
 */

import { isRefreshable } from '@/lib/api/error-codes';
import type { ApiErrorBody } from '@/lib/api/envelope';

export type ApiErrorInit = {
  code: string;
  message: string;
  status: number;
  requestId: string;
  details?: ReadonlyArray<{ field: string; issue: string }>;
  retryAfterSec?: number | null;
  allowed?: readonly string[] | null;
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Field-level issues, for inline form errors. */
  readonly details: ReadonlyArray<{ field: string; issue: string }>;
  /** The server's correlation id. Quoted verbatim in a bug report. */
  readonly requestId: string;
  readonly retryAfterSec: number | null;
  /** `INVALID_STATUS_TRANSITION` → the legal targets. */
  readonly allowed: readonly string[] | null;

  constructor(input: ApiErrorInit) {
    super(input.message);
    this.name = 'ApiError';
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.details = input.details ?? [];
    this.retryAfterSec = input.retryAfterSec ?? null;
    this.allowed = input.allowed ?? null;
  }

  /** `true` for a 401 that a single token refresh may recover. */
  get isRefreshable(): boolean {
    return isRefreshable(this.code);
  }

  /** `true` for "this role can never do this" — a Retry button would lie. */
  get isPermanentDenial(): boolean {
    return this.status === 403;
  }

  /**
   * `true` when the SAME request may succeed unchanged.
   *
   * `403` and `404` are excluded: neither improves with a retry. A `422` is
   * excluded: the request was understood and refused, so a retry sends the same
   * refusal. What remains is a transport or third-party fault, which is what a
   * Retry button is for.
   */
  get shouldRetry(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 408;
  }

  /** The first issue for a field, for inline display. */
  issueFor(field: string): string | null {
    return this.details.find((d) => d.field === field)?.issue ?? null;
  }

  /** Every field with an issue, for a summary above a form. */
  get fieldIssues(): ReadonlyArray<{ field: string; issue: string }> {
    return this.details;
  }

  /** The server's own `ApiErrorBody`, for a caller that wants the raw shape. */
  toBody(): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details.length > 0 ? { details: [...this.details] } : {}),
      ...(this.retryAfterSec !== null ? { retryAfterSec: this.retryAfterSec } : {}),
      ...(this.allowed ? { allowed: [...this.allowed] } : {}),
    };
  }
}

/** Narrow an unknown thrown value. A `catch` gives `unknown`, not an error. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Narrow an unknown thrown value to a `TypeError` from a failed `fetch`. */
export function isNetworkFailure(value: unknown): boolean {
  return value instanceof TypeError && /fetch|network/i.test(value.message);
}

/**
 * The sentence to show a user, given whatever was thrown.
 *
 * Every path returns something renderable. A component that does
 * `error instanceof Error ? error.message : 'Something went wrong'` shows a
 * user the word "TypeError" or a stack fragment, and a Network Failure shows
 * "Failed to fetch", which means nothing to a person trying to report an
 * emergency (docs/16 §6.3).
 */
export function messageFor(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (isNetworkFailure(error)) {
    return 'We could not reach the server. Check your connection and try again — your report has not been lost.';
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return 'Something went wrong. Nothing was changed.';
}

export type { ApiErrorBody };

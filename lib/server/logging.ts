/**
 * ============================================================================
 * CareGrid AI — the logging entry point
 * ============================================================================
 *
 * A deliberate public API over `lib/server/http.ts`, and nothing more.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * docs/10 §16.3, control 10, names `lib/server/logging.ts` as the module that
 * redacts any key matching `/KEY|SECRET|TOKEN|PASSWORD|PRIVATE/i`, and docs/32
 * MUST NOT 9 says "logging goes through `lib/server/logging.ts`". The
 * implementation lives in `http.ts` because that is where Phase 2 put it
 * alongside the request id and the CSRF check, and splitting a 250-line file in
 * two for a name would be churn.
 *
 * So this file is a three-export barrel that makes the documented name real. A
 * future contributor who reads docs/10 §16.3 and greps for `logging.ts` finds
 * this, and every line of it explains WHY the redaction is an allow-list rather
 * than a deny-list — the single most important property of the logger.
 *
 * ---------------------------------------------------------------------------
 * THE ALLOW-LIST IS THE POINT
 * ---------------------------------------------------------------------------
 * `createLogger` emits a field ONLY if its name is in `ALLOWED_FIELDS`.
 * Anything else is dropped, not masked.
 *
 * A deny-list (`if (key.includes('token')) return '[redacted]'`) is bypassed by
 * adding one field to the object: `authToken`, `apiKey`, `userPassword`, and
 * `private_key` all miss a `token`/`key` substring test. An allow-list cannot be
 * bypassed that way, because the only way to add a field to a log line is to
 * add it to the allow-list — which is a reviewable, greppable, testable change.
 *
 * That is also why the cost is real: a log line is missing a field you wanted.
 * A missing field is a debugging inconvenience; a leaked key is an incident with
 * a 90-day rotation requirement.
 */

import 'server-only';

export {
  createLogger,
  getRequestId,
  rateLimitHeaders,
  requestIdFrom,
  type LogLevel,
  type Logger,
} from '@/lib/server/http';

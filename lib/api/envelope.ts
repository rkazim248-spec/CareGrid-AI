/**
 * ============================================================================
 * CareGrid AI — the response envelope
 * ============================================================================
 *
 * Every API response has the same shape, success or failure. One shape means
 * one parse path, which means a malformed body is impossible to miss.
 *
 * ```json
 * success: { "success": true,  "data": { … }, "meta": { "requestId": "req_…" } }
 * failure: { "success": false, "error": { "code": "…", "message": "…", "details": [] },
 *            "meta": { "requestId": "req_…" } }
 * ```
 *
 * The `requestId` lives in `meta` on BOTH paths, so support can trace a failure
 * even when the code is one the UI has no branch for. That is the single most
 * useful field in the whole contract.
 */

import { z } from 'zod';

import { ERROR_CODES } from '@/lib/api/error-codes';
import { requestIdSchema } from '@/validators/enums';

export const apiMetaSchema = z.object({
  requestId: requestIdSchema,
  /** Populated on a rate-limited response. */
  retryAfterSec: z.number().int().nonnegative().optional(),
});

export const apiErrorDetailSchema = z.object({
  field: z.string(),
  issue: z.string(),
});

/**
 * One field-level issue.
 *
 * Declared ONCE, here, derived from the schema above. It was previously declared
 * a second time in `lib/server/validate.ts` — and a hand-written duplicate of a
 * contract in two places is two definitions of it, and a change to one is a bug
 * in the other. `issue` is a machine token from a closed vocabulary, never a
 * rendered sentence, so the client can localise it without a server change
 * (docs/17 §12).
 */
export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;

export const apiErrorBodySchema = z.object({
  /** A stable catalogue code. Never free text. */
  code: z.string(),
  /**
   * A human-readable English sentence, safe to render.
   *
   * Server-authored, never a stack trace, never an internal identifier, never
   * the Firebase error string. The client is permitted to display it verbatim.
   */
  message: z.string(),
  details: z.array(apiErrorDetailSchema).optional(),
  retryAfterSec: z.number().int().nonnegative().nullable().optional(),
  /** `INVALID_STATUS_TRANSITION` → the legal target statuses. */
  allowed: z.array(z.string()).nullable().optional(),
});

export const successEnvelopeSchema = <T extends z.ZodType>(data: T) =>
  z.object({
    success: z.literal(true),
    data,
    meta: apiMetaSchema,
  });

export const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: apiErrorBodySchema,
  meta: apiMetaSchema,
});

export type ApiMeta = z.infer<typeof apiMetaSchema>;
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export type SuccessEnvelope<T> = {
  success: true;
  data: T;
  meta: ApiMeta;
};

export type ErrorEnvelope = {
  success: false;
  error: ApiErrorBody;
  meta: ApiMeta;
};

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function ok<T>(data: T, requestId: string, retryAfterSec?: number): SuccessEnvelope<T> {
  return {
    success: true,
    data,
    meta: { requestId, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) },
  };
}

export function fail(
  error: ApiErrorBody,
  requestId: string,
  retryAfterSec?: number,
): ErrorEnvelope {
  return {
    success: false,
    error,
    meta: { requestId, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) },
  };
}

/** `true` when `code` is one this client version knows about. */
export function isKnownErrorCode(code: string): boolean {
  return (ERROR_CODES as readonly string[]).includes(code);
}

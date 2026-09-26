/**
 * ============================================================================
 * CareGrid AI — shared API contract types
 * ============================================================================
 *
 * The wire shapes, in one place, imported by BOTH sides.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A RE-EXPORT AND NOT A DEFINITION
 * ---------------------------------------------------------------------------
 * The definitions live in `lib/api/envelope.ts` and `lib/api/error-codes.ts`,
 * because a Zod schema and its inferred type must be declared together or they
 * drift. This file is the **stable import path**: a component imports
 * `@/types/api`, a route imports `@/lib/api/envelope`, and neither has to know
 * where the other one keeps it.
 *
 * That matters for a concrete reason. A hand-written duplicate of
 * `ApiErrorDetail` in `types/` and another in `lib/api/` is two definitions of
 * one contract, and a change to one is a bug in the other. There is exactly one
 * definition, here and there are two names for it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A CLIENT MAY RELY ON, AND WHAT IT MAY NOT
 * ---------------------------------------------------------------------------
 * | Guaranteed | Not guaranteed |
 * |-----------|----------------|
 * | `success`, `data`/`error`, and `meta.requestId` are always present | that a specific `data` key exists for an endpoint that does not exist yet |
 * | `error.code` is a catalogue code | that a given code will ever be returned by a given route |
 * | An unknown RESPONSE key is dropped, so a newer server does not break an older client | that a response's `data` shape is validated — each endpoint's Zod schema does that in `lib/api/client.ts` |
 *
 * The envelope is a transport contract. A payload is an endpoint contract, and
 * the two are deliberately separate: one is stable across the whole API, the
 * other changes whenever an endpoint does.
 */

/**
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DELIBERATELY DOES NOT RE-EXPORT
 * ---------------------------------------------------------------------------
 * `RequestContext` and `RouteHandlerContext` from `lib/server/route.ts`. They are
 * server-only, this file is reachable from a Client Component, and re-exporting
 * them would put a server module in a client import graph for the sake of a type
 * no component ever uses. A route imports them from `@/lib/server/route`
 * directly.
 *
 * `scripts/security-check.cjs` enforces this: a client-reachable file that
 * imports `@/lib/server/**` fails the build. That check found this exact mistake
 * during Phase 3, which is the argument for having it.
 */

export type {
  ApiEnvelope,
  ApiErrorBody,
  ApiErrorDetail,
  ApiMeta,
  ErrorEnvelope,
  SuccessEnvelope,
} from '@/lib/api/envelope';

export type { ErrorCode } from '@/lib/api/error-codes';

/* ========================================================================== */
/* Endpoint payloads                                                          */
/* ========================================================================== */

/**
 * `GET /api/health` and `GET /api/auth/me`'s shared liveness fields.
 *
 * `status` is `degraded` when the PUBLIC configuration did not resolve, which is
 * the state a reviewer first encounters. It says nothing about server
 * configuration: a public endpoint that enumerates which secrets are missing is
 * a reconnaissance endpoint (docs/10 §16.3, control 7).
 */
export type HealthPayload = {
  readonly status: 'ok' | 'degraded';
  readonly service: string;
  readonly version: string;
  /** Milliseconds since this server instance started. docs/06 §1.3. */
  readonly uptimeSec: number;
  readonly timestamp: string;
};

/**
 * The admin-only configuration view.
 *
 * `requiredVars` is a list of variable NAMES. There is no field anywhere in
 * this type that could carry a secret value, which is a property of the TYPE
 * rather than of a convention someone could forget.
 */
export type SystemHealthPayload = {
  readonly status: 'ok' | 'degraded';
  readonly service: string;
  readonly version: string;
  readonly timestamp: string;
  readonly uptimeSec: number;
  readonly providers: ReadonlyArray<{
    readonly provider: 'gemini' | 'google-maps' | 'twilio' | 'firebase-admin';
    readonly configured: boolean;
    readonly requiredVars: readonly string[];
    readonly problem: string | null;
  }>;
  /** Sentences naming a variable and why. Never a value. */
  readonly problems: readonly string[];
  readonly settings: Readonly<Record<string, unknown>>;
};

/**
 * `POST /api/ai/triage`'s response.
 *
 * `source` is ALWAYS present and `needsReview` is ALWAYS `true` for a fallback,
 * because the fallback is a real outcome and a client has to be able to branch
 * on it (FR-024, FR-029). Every assessment field is nullable, and the
 * nullability is the contract: `null` means the model declined and a person
 * decides, not "zero" and not a default.
 */
export type TriageProbePayload = {
  readonly triage: {
    readonly source: 'ai' | 'fallback' | 'manual';
    readonly category: string | null;
    readonly urgency: string | null;
    readonly summary: string | null;
    readonly safetyFlags: readonly string[];
    readonly confidence: number | null;
    readonly rationale: string | null;
    readonly needsReview: boolean;
    readonly providerName: string;
    readonly model: string;
    readonly promptVersion: string;
  };
  /** `true` when the provider is configured and reachable. */
  readonly providerAvailable: boolean;
};

/* ========================================================================== */
/* Pagination                                                                 */
/* ========================================================================== */

/**
 * The page metadata every list route returns.
 *
 * `limit` is the **effective** limit, not the requested one. A `limit=500`
 * clamped to 100 echoes 100 (docs/17 §4.1), because a caller who asked for 500
 * and received 25 rows with no explanation concludes the queue is empty — a
 * worse failure than an error.
 */
export type PageMeta = {
  readonly limit: number;
  readonly hasMore: boolean;
  /** Opaque to the client. base64url of a server-generated fingerprint. */
  readonly nextCursor: string | null;
  /** `true` when the request's `limit` was clamped. */
  readonly limitClamped?: boolean;
};

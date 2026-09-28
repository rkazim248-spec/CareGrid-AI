/**
 * ============================================================================
 * CareGrid AI — third-party integration contracts
 * ============================================================================
 *
 * The three interfaces every external provider must satisfy, and the shared
 * vocabulary they use. PURE: no `fetch`, no SDK, no `process.env`, no React —
 * so this file is importable from a unit test, a Client Component, or a server
 * route without pulling a provider SDK into a bundle (docs/20 §1 P3).
 *
 * ---------------------------------------------------------------------------
 * WHY THE INTERFACE COMES FIRST AND THE ADAPTER SECOND
 * ---------------------------------------------------------------------------
 * Because the alternative is a provider SDK imported where it is used. Gemini
 * would be called from `services/incidents/create-incident.ts`, a Maps key would
 * be read inside a component, and a Twilio call would be inlined in a
 * notification service. Three call sites, three secret reads, three places to
 * forget a timeout, and no way to test any of them without a network.
 *
 * With the interface here, the implementation lives in exactly one file per
 * provider under `services/integrations/<provider>/`, a test implements the same
 * interface, and a route never learns which provider answered.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PROVIDER MUST NOT DO
 * ---------------------------------------------------------------------------
 * | Rule | Why |
 * |------|-----|
 * | Never throw a raw SDK error | it may carry an API key, a request id, and a provider message. Throw `AppError`. |
 * | Never return a fabricated success | docs/32 MUST 6: no fake functionality. A provider that cannot answer throws. |
 * | Never call itself | the call site owns the timeout and the fallback (docs/09 §7). |
 * | Never read `process.env` | secrets come from `lib/env.server.ts`, once. |
 *
 * That last row is why `GEMINI_API_KEY` appears in exactly one file in this
 * repository. `rg GEMINI_API_KEY` is a complete audit of where the key can be
 * read.
 */

import type { IncidentCategory, SafetyFlag, Urgency } from '@/types/enums';

/* ========================================================================== */
/* Shared vocabulary                                                          */
/* ========================================================================== */

/**
 * One evidence image, already validated.
 *
 * The base64 payload rides on the request because docs/09 §4.2 specifies inline
 * data: "No Files API, no GCS URI uploads. Inline base64 keeps the request
 * auditable and avoids a second service."
 *
 * This is a structural copy rather than an import from `services/ai/media.ts`, and
 * that is deliberate. `media.ts` is server-side and imports `node:crypto` for the
 * digest; `contracts.ts` is the ONE file a Client Component and a unit test are
 * both allowed to import (docs/30.4 §6 D-6). Importing the type would be erased
 * at compile time, but re-declaring it here means the contract file's purity is
 * a property of its imports rather than of a compiler flag, and
 * `scripts/security-check.cjs` can assert it.
 */
export type TriageImage = {
  /** From the file SIGNATURE, never from what the client declared. */
  readonly mimeType: string;
  readonly base64: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly fileName: string;
};

/**
 * What a provider needs to be told about the request.
 *
 * A `TriageRequest` is the ONLY thing the AI is ever shown about an incident,
 * and it is built by a service that has already applied the sanitisation
 * boundary in docs/09 §4. No provider receives a raw Firestore document, a
 * user record, or a location the reporter did not supply.
 */
export type TriageRequest = {
  /** The citizen's own words, already length-bounded and stripped of markup. */
  readonly text: string | null;
  /** BCP-47 tag from the request, not from the browser's guess. */
  readonly language: string;
  /** Present only when the reporter supplied it. Never invented. */
  readonly locationHint: string | null;
  /** Accuracy grade of `locationHint`, so the model never over-claims. */
  readonly locationAccuracy: 'high' | 'medium' | 'low' | 'unknown';
  /** Counts only. Bytes never leave the server; no URLs are resolvable. */
  readonly imageCount: number;
  readonly audioCount: number;
  /** `true` when this account is under five minutes old (FR-135 S9). */
  readonly newAccount: boolean;
  /**
   * The image BYTES, when the caller has them.
   *
   * Added in Phase 4 for the multimodal path (brief §12, docs/09 §4.2). Optional
   * and absent by default, so the text-only path — which is what a report with no
   * photo uses, and what every existing caller does — is entirely unchanged.
   *
   * The split between `imageCount` and `images` is the point of having both.
   * `imageCount` was always safe to log, to rate-limit on, and to render: it is a
   * number. `images` is not. It is typed as validated base64 rather than as a URL
   * for two reasons: a URL would make the provider do I/O, which docs/20 §1 P3
   * forbids in a pure contract file, and it would put a resolvable handle for a
   * citizen's photograph into a third party's request.
   */
  readonly images?: readonly TriageImage[];
};

/**
 * Which attempt produced this record, and why it is on the OUTCOME and not here.
 *
 * docs/09 §8: the first call may fail schema validation, and exactly ONE repair
 * call follows. A record produced by the repair is worth distinguishing from a
 * first-attempt record, because a rising repair rate is the earliest visible
 * signal of schema drift — the model has started disagreeing with a contract that
 * has not changed.
 *
 * It lives on `TriageOutcome` rather than on `TriageResult` because it describes
 * the CALL, not the content, and a provider that implements the narrow
 * `TriageResult` shape has nothing meaningful to say about it. `null` means no
 * model call was made at all, which is every fallback and every unconfigured
 * deployment.
 */
export type TriageAttempt = 1 | 2;

/**
 * What a provider must return, and MUST NOT exceed.
 *
 * Every field is nullable, and the nullability is the contract:
 *
 *   - `urgency: null` means the model declined. The deterministic rules R1-R10
 *     and the keyword fallback decide instead, and the incident records
 *     `triageSource: 'fallback'` (docs/09 §7).
 *   - `confidence` is the model's own, and it is BELIEVED only after
 *     normalisation. There is no field for a coordinate, a casualty count, a
 *     resource, or a diagnosis, because docs/09 §1.2 forbids the model from
 *     producing any of them and a schema that accepts one is an invitation.
 */
export type TriageResult = {
  readonly category: IncidentCategory | null;
  readonly urgency: Urgency | null;
  readonly summary: string | null;
  readonly safetyFlags: readonly SafetyFlag[];
  /** 0..1. Below `AI_CONFIDENCE_REVIEW_THRESHOLD` the UI says "needs review". */
  readonly confidence: number | null;
  /** Free-text reasoning for the dispatcher. Never shown to a citizen. */
  readonly rationale: string | null;
  /**
   * Present only when a re-triage needs to be reproducible. It is a HASH of the
   * raw output, never the output itself: the raw text can contain a quoted
   * description of an injured person and this collection has a long retention.
   */
  readonly rawOutputHash: string | null;
};

/** Options every provider call accepts. */
export type ProviderCallOptions = {
  /**
   * The deadline. Providers MUST honour it and MUST translate a breach into
   * `TIMEOUT` (504) rather than letting an `AbortError` escape — an
   * `AbortError` reaching the route becomes a 500 and reads as a bug.
   */
  readonly timeoutMs: number;
  /** `true` to skip the provider entirely. Used by tests and by the fallback. */
  readonly skip?: boolean;
};

/* ========================================================================== */
/* Gemini — docs/09                                                            */
/* ========================================================================== */

/**
 * The AI seam. docs/30 §6.3 names it `TriageProvider`.
 *
 * Named `TriageProvider` rather than `AiProvider` on purpose: it is a TRIAGE
 * provider, not a general model. The interface has three methods, not `generate`
 * plus options, which is what stops "just ask the model to dispatch someone"
 * from being a one-line addition later (docs/09 §1.2, MUST NOT 8).
 */
export type TriageProvider = {
  /** The provider's identity, recorded on every `aiRuns` document. */
  readonly name: string;
  readonly model: string;
  /** Bumped whenever the system prompt changes (docs/32 §7). */
  readonly promptVersion: string;

  /** `false` when the provider cannot be reached. Never a guess. */
  isAvailable(): boolean;

  /**
   * Triage one incident. Throws `AppError` on any failure — the caller decides
   * whether to fall back, and only the caller may, because the fallback also
   * writes `triageSource`, which is the provider's job not to know about.
   */
  triage(request: TriageRequest, options: ProviderCallOptions): Promise<TriageResult>;
};

/* ========================================================================== */
/* Google Maps — docs/12                                                       */
/* ========================================================================== */

/** docs/12 §5. A resolved place, with the components kept separate. */
export type GeocodeResult = {
  readonly formatted: string;
  readonly placeId: string | null;
  readonly locality: string | null;
  readonly country: string | null;
  /**
   * The coordinates Google returned, with an accuracy grade. A geocoded point
   * is `medium` at best and is NEVER presented as a pin the reporter dropped
   * (MUST NOT 7).
   */
  readonly point: { readonly lat: number; readonly lng: number } | null;
  readonly accuracyGrade: 'high' | 'medium' | 'low' | 'unknown';
};

export type GeocodingProvider = {
  readonly name: string;
  isAvailable(): boolean;
  /** Free-text place to a resolved place. Throws `GEOCODE_FAILED` (422). */
  geocode(query: string, options: ProviderCallOptions): Promise<GeocodeResult>;
  /** Coordinates to a human place name. Never the reverse direction's inverse. */
  reverseGeocode(
    point: { readonly lat: number; readonly lng: number },
    options: ProviderCallOptions,
  ): Promise<GeocodeResult>;
};

/* ========================================================================== */
/* Notifications — docs/13                                                     */
/* ========================================================================== */

/**
 * The one interface every notification channel implements. docs/13 §1.
 *
 * Three implementations are planned: `in_app` (Firestore, real), `sms`
 * (Twilio), and `whatsapp` (Twilio). The first is server-owned; the other two
 * are behind a provider that is NOT configured in this phase.
 */
export type NotificationChannel = {
  readonly channel: 'in_app' | 'sms' | 'whatsapp' | 'email' | 'push';
  /** `false` when the channel cannot be delivered. Drives the 422 on the API. */
  isAvailable(): boolean;
  /**
   * Deliver one message. Returns the provider's own id when there is one, which
   * is how a delivery failure is investigated without storing the content.
   */
  send(
    message: {
      readonly to: string;
      readonly body: string;
      readonly idempotencyKey: string;
    },
    options: ProviderCallOptions,
  ): Promise<{ readonly providerMessageId: string | null }>;
};

/* ========================================================================== */
/* Status                                                                      */
/* ========================================================================== */

/**
 * One provider's readiness. Never carries a value, only variable NAMES
 * (docs/10 §16.3, control 7).
 */
export type ProviderStatus = {
  readonly provider: 'gemini' | 'google-maps' | 'twilio' | 'firebase-admin';
  /** `true` when the provider is configured AND its feature flag is on. */
  readonly configured: boolean;
  /** The variable NAMES that decide it. */
  readonly requiredVars: readonly string[];
  /** A renderable sentence, or `null`. */
  readonly problem: string | null;
};

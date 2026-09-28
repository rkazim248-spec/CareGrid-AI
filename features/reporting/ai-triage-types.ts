/**
 * ============================================================================
 * AI triage client types — brief §10, §12
 * ============================================================================
 *
 * The shape `POST /api/ai/triage` answers with, as the CLIENT sees it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `@/validators/ai`
 * ---------------------------------------------------------------------------
 * Because those are request/response SCHEMAS, and the client needs a plain type
 * plus a narrow, hand-checked mapping. The two differ in three ways that matter:
 *
 *  - The server's `safetyFlags` is `string[]`; the client needs `SafetyFlag[]` to
 *    index `SAFETY_FLAG_META` without a cast at every use.
 *  - The server returns `locationHint`, `peopleAffected`, `requiredResources` and
 *    `unknownFields` only on a rich response; the client types them as present but
 *    nullable, and the panel checks them. A field the client must handle-absent
 *    is a field the type should admit.
 *  - The panel's editable state is a DIFFERENT shape from the response. Seeding
 *    one from the other is `toEditable()` in `ai-triage-panel.tsx`, and typing
 *    them separately is what stops an edit writing back into the response.
 *
 * The categories and urgencies are cast from `string` in the route, and the cast
 * is confined to that one place: the SERVER validates them against the taxonomy
 * with `.strict()` before they leave, so the cast is a narrowing of a value that
 * is already known to be valid, not an assertion about an untrusted one.
 */

import type { IncidentCategory, SafetyFlag, Urgency } from '@/types';

/** docs/09 §7.1, as the response carries it. */
export type AiTriageOutcome =
  | 'success'
  | 'fallback'
  | 'timeout'
  | 'error'
  | 'blocked'
  | 'validation_failed';

/** One suggested resource, with its provenance. */
export type AiSuggestedResource = {
  readonly resourceId: string;
  readonly name: string;
  readonly quantity: number;
  readonly confidence: number;
  /**
   * `reporter` when the citizen asked for it, `ai` when the model inferred it.
   * The panel renders this, because a request a person made outranks one a model
   * suggested and the difference should not require a tooltip to see.
   */
  readonly source: 'reporter' | 'ai';
};

export type AiTriageResponse = {
  readonly source: 'ai' | 'fallback' | 'manual';
  readonly outcome: AiTriageOutcome;
  readonly category: IncidentCategory | null;
  readonly urgency: Urgency | null;
  readonly summary: string | null;
  readonly safetyFlags: readonly SafetyFlag[];
  readonly confidence: number | null;
  readonly needsReview: boolean;
  readonly lowConfidence: boolean;
  readonly providerName: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly attempt: 1 | 2 | null;
  /*
   * `rationale` is NOT a field on this type, and that is the point.
   *
   * docs/09 §3 says it is "free-text reasoning for the dispatcher. Never shown to
   * a citizen", and `map-triage-response.ts` drops it rather than carrying it as
   * `null`. A field present-but-null invites a `?.` at a call site and a render a
   * year from now; a field that is not in the type cannot reach a browser at all,
   * which is the stronger guarantee.
   *
   * The server's own response DOES carry it — that schema is the wire contract, and
   * Phase 5's dispatcher panel needs it. The omission is at the CITIENT boundary.
   * The server also records it on `aiRuns`.
   */
  /**
   * Approximate prose only. NEVER coordinates, never an address, and never
   * presented as a location — docs/09 §5.2 says it is not stored on the incident
   * and exists only to help a dispatcher who already has a real location.
   *
   * Always `null` from `mapTriageResponse` today, for the same reason as
   * `peopleAffected` below: there is no citizen-facing surface for an AI's
   * approximation, and a field that is permanently null invites a render. It is
   * typed so Phase 5's dispatcher panel has a name to use.
   */
  readonly locationHint: string | null;
  /**
   * A casualty count, or `null`.
   *
   * Present in the type and effectively always `null` from a model: docs/09 §1.2
   * rule 4 and R4 mean a count is only stored when the REPORTER stated one, and
   * the panel deliberately does not seed its editable field from this. It is
   * typed rather than omitted so that a future manual-entry path has somewhere to
   * put a value the citizen supplied.
   */
  readonly peopleAffected: number | null;
  readonly requiredResources: readonly AiSuggestedResource[];
  readonly unknownFields: readonly string[];
  readonly providerAvailable: boolean;
  /** `true` only when the development mock produced this. brief §26. */
  readonly simulated: boolean;
  readonly mediaCount: number;
  readonly mediaDropped: readonly string[];
  readonly aiRunId: string | null;
};

/**
 * Which loading step is showing. 0 is "nothing started", 4 is "done".
 *
 * An index rather than a boolean so `AnalysisProgress` can mark completed steps
 * without a second source of truth.
 */
export type AiTriageStep = 0 | 1 | 2 | 3 | 4;

/** The request the panel sends. */
export type AiTriageRequest = {
  readonly text: string;
  readonly language: string;
  readonly locationHint?: string;
  readonly images?: readonly {
    readonly mimeType: string;
    readonly fileName: string;
    readonly data: string;
  }[];
};

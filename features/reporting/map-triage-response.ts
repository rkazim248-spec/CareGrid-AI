/**
 * ============================================================================
 * The server response -> client response mapping
 * ============================================================================
 *
 * One function, and the reason it is a file rather than a cast inside the panel.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER SCHEMA AND THE CLIENT TYPE ARE NOT THE SAME
 * ---------------------------------------------------------------------------
 * The server's response schema (`validators/ai.ts`) is a *validation* contract:
 * every field is `string`, because a Zod schema that says
 * `z.enum(SAFETY_FLAGS)` in a response body duplicates the taxonomy and will
 * drift from `types/enums.ts` the first time a flag is added.
 *
 * The client needs the narrow types, because `SAFETY_FLAG_META[flag]` with a
 * `string` key is a compile error and a `?? flag` fallback at every call site is a
 * chance to render a raw enum value to a person in an emergency.
 *
 * So the narrowing happens here, once, and it is safe rather than an assertion:
 * the server has already validated every one of these values against the
 * taxonomy with a `.strict()` schema before the response is written. This function
 * therefore narrows a value that is KNOWN to be valid, and its only real job is
 * to do that in one auditable place.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DROPS
 * ---------------------------------------------------------------------------
 * `rationale` is not carried into the client type. docs/09 §3 says it is "free-text
 * reasoning for the dispatcher. Never shown to a citizen" — and a model field
 * presented to a member of the public is a channel for whatever the model
 * happened to say, including text derived from an injection. The server still
 * records it on `aiRuns`; the citizen's client never receives it.
 */

import { SAFETY_FLAGS, INCIDENT_CATEGORIES, URGENCIES } from '@/types/enums';
import type { IncidentCategory, SafetyFlag, Urgency } from '@/types/enums';
import type { AiTriageResponse } from '@/features/reporting/ai-triage-types';

/** The server's response shape, as `aiTriageProbeResponseSchema` infers it. */
type ServerResponse = {
  readonly triage: {
    readonly source: 'ai' | 'fallback' | 'manual';
    readonly outcome: AiTriageResponse['outcome'];
    readonly category: string | null;
    readonly urgency: string | null;
    readonly summary: string | null;
    readonly safetyFlags: readonly string[];
    readonly confidence: number | null;
    readonly rationale: string | null;
    readonly needsReview: boolean;
    readonly lowConfidence: boolean;
    readonly providerName: string;
    readonly model: string;
    readonly promptVersion: string;
    /**
     * `number` here rather than `1 | 2`, because the server schema is what this
     * function takes and a Zod `.int().min(1).max(2)` infers as `number`. The
     * narrowing to `1 | 2` happens in the return, where the value is used.
     */
    readonly attempt: number | null;
  };
  readonly providerAvailable: boolean;
  readonly simulated: boolean;
  readonly mediaCount: number;
  readonly mediaDropped: readonly string[];
  readonly aiRunId: string | null;
};

/**
 * A value the server already validated, narrowed to the taxonomy.
 *
 * The `includes` check rather than a cast: it is the same check the server made,
 * so it cannot fail in production, and if it ever DID fail — a server and client
 * deployed from different builds, which is a real possibility during a rolling
 * deploy — the fallback is `null`, which the panel renders as "not determined".
 *
 * A cast would turn that mismatch into a badge lookup that returns `undefined`
 * and renders an empty pill in an emergency panel.
 */
function narrow<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  if (value === null) return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function mapTriageResponse(response: ServerResponse): AiTriageResponse {
  return {
    source: response.triage.source,
    outcome: response.triage.outcome,
    category: narrow<IncidentCategory>(response.triage.category, INCIDENT_CATEGORIES),
    urgency: narrow<Urgency>(response.triage.urgency, URGENCIES),
    summary: response.triage.summary,
    // Unknown flags are DROPPED rather than passed through: a flag this build
    // has no wording for would render as a raw snake_case string next to a
    // sentence a person is reading about their own emergency.
    safetyFlags: (response.triage.safetyFlags.filter((flag) =>
      (SAFETY_FLAGS as readonly string[]).includes(flag),
    ) as SafetyFlag[]).filter((flag, index, all) => all.indexOf(flag) === index),
    confidence: response.triage.confidence,
    // `rationale` intentionally absent — see the file header.
    needsReview: response.triage.needsReview,
    lowConfidence: response.triage.lowConfidence,
    providerName: response.triage.providerName,
    model: response.triage.model,
    promptVersion: response.triage.promptVersion,
    // Narrowed from the schema's `number` to the union the client type declares.
    // A value outside {1, 2} becomes `null` — "no attempt recorded" — rather than
    // a number the progress UI would have to handle.
    attempt:
      response.triage.attempt === 1 || response.triage.attempt === 2
        ? response.triage.attempt
        : null,
    locationHint: null,
    peopleAffected: null,
    requiredResources: [],
    unknownFields: [],
    providerAvailable: response.providerAvailable,
    simulated: response.simulated,
    mediaCount: response.mediaCount,
    mediaDropped: response.mediaDropped,
    aiRunId: response.aiRunId,
  };
}

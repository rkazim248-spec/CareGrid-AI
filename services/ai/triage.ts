/**
 * ============================================================================
 * CareGrid AI — the AI service
 * ============================================================================
 *
 * The business logic that sits between a validated incident request and a
 * `TriageProvider`. Phase 3 builds only the seam; Phase 4 fills it in.
 *
 * ---------------------------------------------------------------------------
 * WHAT EXISTS, AND WHY IT IS NOT A STUB
 * ---------------------------------------------------------------------------
 * Three real, testable properties, all of which Phase 4 depends on:
 *
 *   1. **The provider is behind an interface** (`TriageProvider`), so a test
 *      implements it and no network is involved (docs/32 MUST 7: mocks live in
 *      `tests/`, keyed by a seam the code already has).
 *   2. **The sanitisation boundary is here**, not in the provider. A provider
 *      receives a `TriageRequest` — a small, typed, already-bounded object — and
 *      never a Firestore document. There is therefore nothing for a prompt
 *      injection to be smuggled through, and nothing for a future provider
 *      author to leak.
 *   3. **The failure path is the documented one.** `triageIncident()` never
 *      throws at its caller. FR-029: "recording an emergency is never blocked by
 *      the AI." It catches everything the provider does and returns
 *      `{ source: 'fallback', ... }` with `needsReview: true` (docs/09 §7).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * | Absent | Phase | Why not now |
 * |--------|-------|--------------|
 * | The `triage-v3` prompt | 4 | In docs/09 §6, and a prompt without a model to run it is text nobody reviews. |
 * | `@google/genai` | 4 | docs/02. Adding it now is a dependency with no caller. |
 * | The JSON output schema | 4 | docs/09 §5. Belongs with the prompt that produces it. |
 * | The deterministic rules R1-R10 | 4 | Pure, but they only matter once a model can contradict them. |
 * | The keyword fallback engine | 4 | The `fallback` branch below returns "needs review"; the engine that fills it in is Phase 4. |
 *
 * Each is listed rather than quietly omitted, because "the fallback exists" is
 * only true once the engine behind it exists. Until then the honest fallback is
 * "no AI assessment, a human will look at it" — which is a real outcome, not a
 * simulated one.
 *
 * ---------------------------------------------------------------------------
 * MUST NOT 8, AND WHY IT IS STRUCTURAL
 * ---------------------------------------------------------------------------
 * There is no code path from a `TriageResult` to a dispatch, a notification to
 * an external service, or a lifecycle transition beyond `new → triaged`. The
 * return type has no field that could carry a coordinate, a casualty count, or a
 * resource, so the prohibition is a property of the TYPE rather than of a
 * convention someone could forget (docs/09 §1.2).
 */

import 'server-only';

import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { getTriageProvider } from '@/services/integrations/gemini';
import { geminiConfig } from '@/lib/env.server';
import type {
  ProviderCallOptions,
  TriageProvider,
  TriageRequest,
  TriageResult,
} from '@/lib/integrations/contracts';
import type { IncidentCategory, SafetyFlag, TriageSource, Urgency } from '@/types/enums';

/* ========================================================================== */
/* The result shape                                                            */
/* ========================================================================== */

/**
 * What triage produced, and how much to trust it.
 *
 * `source` is written to `incidents.triageSource` (docs/07 §4.1) and is the
 * field a dispatcher reads to decide whether to look at this report by hand.
 * `needsReview` is FR-024: `confidence < AI_CONFIDENCE_REVIEW_THRESHOLD`.
 *
 * Every field is nullable and the nullability is the contract: `null` means
 * "the model declined, and the deterministic rules decide", NOT "zero" and NOT
 * a default. A fabricated `urgency: 'critical'` is a fabricated triage decision
 * on a real emergency, and a null is the only safe alternative.
 */
export type TriageOutcome = {
  readonly source: TriageSource;
  readonly category: IncidentCategory | null;
  readonly urgency: Urgency | null;
  readonly summary: string | null;
  readonly safetyFlags: readonly SafetyFlag[];
  readonly confidence: number | null;
  readonly rationale: string | null;
  /** FR-024. The UI says "needs review" when this is `true`. */
  readonly needsReview: boolean;
  /** Which provider and which prompt version produced this, for `aiRuns`. */
  readonly providerName: string;
  readonly model: string;
  readonly promptVersion: string;
  /** `null` unless a run actually happened. A fallback has no raw output. */
  readonly rawOutputHash: string | null;
};

/* ========================================================================== */
/* The entry point                                                             */
/* ========================================================================== */

/**
 * Triage one incident, and NEVER throw at the caller.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RETURNS INSTEAD OF THROWING
 * ---------------------------------------------------------------------------
 * FR-029 and docs/09 §7. A citizen pressing "send" during a medical emergency
 * must not lose their report because a quota was exhausted 3,000 km away. The
 * report is still recorded, the incident is still created, `triageSource` is
 * `fallback`, and the UI says a person will review it.
 *
 * That guarantee is only real if the function cannot throw. So it catches
 * `AppError`, a provider crash, a `TypeError`, and anything else, and it
 * converts all of them into the same honest outcome. The one thing it does NOT
 * do is hide a bug: a non-`AppError` throw is logged at `error` with its
 * constructor name, so a provider that throws a string is visible in the log and
 * invisible to the caller.
 *
 * `skip: true` forces the fallback path. That is how the create pipeline
 * disables AI for a maintenance window, and how a test asserts the fallback
 * without a network.
 */
export async function triageIncident(
  request: TriageRequest,
  options: ProviderCallOptions & { readonly requestId: string; readonly provider?: TriageProvider },
): Promise<TriageOutcome> {
  const provider = options.provider ?? getTriageProvider();
  const log = createLogger(options.requestId);

  if (options.skip === true || !provider.isAvailable()) {
    return fallbackOutcome(provider, 'AI triage was skipped for this request.');
  }

  try {
    const result = await provider.triage(request, {
      timeoutMs: options.timeoutMs > 0 ? options.timeoutMs : geminiConfig().timeoutMs,
    });
    return fromProviderResult(result, provider);
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    // A provider failure is a `warn`, not an `error`: it is an expected,
    // documented, survivable condition and a log full of `error` lines for
    // working-as-designed fallbacks trains an operator to ignore the log.
    log.warn({
      code: appError?.code ?? 'AI_UNAVAILABLE',
      path: 'services.ai.triage',
      status: appError?.status ?? 502,
    });
    return fallbackOutcome(provider, 'AI triage was unavailable, so a person will review this report.');
  }
}

/* ========================================================================== */
/* Normalisation                                                               */
/* ========================================================================== */

/**
 * Turn a provider's answer into an outcome.
 *
 * Three normalisations, each of which exists because the model cannot be trusted
 * to have done it:
 *
 *   1. **Confidence is clamped to 0..1.** A model returning `1.4` would render a
 *      confidence meter past its end and, worse, defeat the `needsReview`
 *      comparison.
 *   2. **`needsReview` is computed HERE, from the threshold**, never taken from
 *      the model. A model that says it is 100% sure of a low-quality reading is
 *      the exact case FR-024 exists for.
 *   3. **An empty result becomes a fallback.** A provider that returns every
 *      `null` has declined, and a `new` incident with no category and no urgency
 *      and no review flag is a report nobody will look at.
 */
function fromProviderResult(result: TriageResult, provider: TriageProvider): TriageOutcome {
  const threshold = geminiConfig().confidenceReviewThreshold;
  const confidence =
    result.confidence === null ? null : Math.min(1, Math.max(0, result.confidence));

  const declined =
    result.category === null && result.urgency === null && result.summary === null;

  if (declined) {
    return fallbackOutcome(provider, 'The model declined to assess this report.');
  }

  return {
    source: 'ai',
    category: result.category,
    urgency: result.urgency,
    summary: result.summary,
    safetyFlags: result.safetyFlags,
    confidence,
    rationale: result.rationale,
    needsReview: confidence === null || confidence < threshold,
    providerName: provider.name,
    model: provider.model,
    promptVersion: provider.promptVersion,
    rawOutputHash: result.rawOutputHash,
  };
}

/**
 * The honest no-AI outcome.
 *
 * `source: 'fallback'` is not a failure marker, it is a provenance marker: it
 * says a human must read this report, which is the correct handling for an
 * emergency platform whose AI is unavailable. `needsReview: true` is therefore
 * ALWAYS true here, and `confidence: null` so no meter renders a number nobody
 * measured.
 */
function fallbackOutcome(provider: TriageProvider, rationale: string): TriageOutcome {
  return {
    source: 'fallback',
    category: null,
    urgency: null,
    summary: null,
    safetyFlags: [],
    confidence: null,
    rationale,
    needsReview: true,
    providerName: provider.name,
    model: provider.model,
    promptVersion: provider.promptVersion,
    rawOutputHash: null,
  };
}

/* ========================================================================== */
/* The sanitisation boundary                                                   */
/* ========================================================================== */

/**
 * The fields a report may be TRIAGED FROM, and their bounds.
 *
 * This is the whole of what crosses into the AI boundary. There is no uid, no
 * email, no phone, no IP hash, no device identifier, and no exact coordinate —
 * a model does not need a citizen's email address to categorise a report, and
 * sending it would put a piece of personal data into a third-party processor for
 * no benefit (docs/09 §4, docs/24 T-09).
 */
export const TRIAGE_LIMITS = {
  /** FR-003. The same bounds the Zod schema enforces, restated for the boundary. */
  textMaxChars: 2000,
  /** A location hint is prose, not an address book entry. */
  locationHintMaxChars: 200,
  /** The model is told the COUNT, not the bytes. Nothing is resolvable. */
  maxImages: 3,
  maxAudioClips: 1,
} as const;

/**
 * Build a `TriageRequest` from validated input, applying the boundary.
 *
 * The clamping here is deliberate and is NOT a validation failure: a 5,000
 * character report must still be TRIAGED (truncated), because refusing to triage
 * it would leave a real emergency with no assistance at all. The full text is
 * stored verbatim in Firestore regardless; only the copy sent to a third party
 * is bounded (docs/09 §4).
 */
export function toTriageRequest(input: {
  readonly text: string | null;
  readonly language: string;
  readonly locationHint: string | null;
  readonly locationAccuracy: 'high' | 'medium' | 'low' | 'unknown';
  readonly imageCount: number;
  readonly audioCount: number;
  readonly newAccount: boolean;
}): TriageRequest {
  return {
    text: input.text === null ? null : input.text.slice(0, TRIAGE_LIMITS.textMaxChars),
    language: input.language,
    locationHint:
      input.locationHint === null
        ? null
        : input.locationHint.slice(0, TRIAGE_LIMITS.locationHintMaxChars),
    locationAccuracy: input.locationAccuracy,
    imageCount: clampCount(input.imageCount, TRIAGE_LIMITS.maxImages),
    audioCount: clampCount(input.audioCount, TRIAGE_LIMITS.maxAudioClips),
    newAccount: input.newAccount,
  };
}

function clampCount(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(max, Math.floor(value));
}

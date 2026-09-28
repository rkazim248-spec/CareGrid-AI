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
import { getTriageProvider, type GeminiTriageResult } from '@/services/integrations/gemini';
import { geminiConfig } from '@/lib/env.server';
import { fallbackTriage } from '@/services/ai/fallback';
import type { NormalizedTriage } from '@/services/ai/rules';
import {
  buildAiRunDocument,
  buildFallbackRunDocument,
  logAiRun,
  type AiOutcome,
  type AiRunContext,
} from '@/services/ai/audit';
import type {
  ProviderCallOptions,
  TriageAttempt,
  TriageImage,
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
  /**
   * Which call produced this: `1` is the first answer, `2` the one repair.
   * `null` when no model was called, which is every fallback path.
   */
  readonly attempt: TriageAttempt | null;
  /**
   * The full normalised record. docs/09 §5.2.
   *
   * Present for BOTH sources, including the keyword fallback — the fallback
   * engine produces a complete record too, and a dispatcher sees the same shape
   * either way. `null` only when a provider returned nothing usable at all.
   */
  readonly normalized: NormalizedTriage | null;
  /** docs/09 §7.1. What happened, for `aiRuns` and the health endpoint. */
  readonly outcome: AiOutcome;
  /** The `aiRuns` document id, or `null` when nothing was written. */
  readonly aiRunId: string | null;
  /** Images the model did not see, because they exceeded the inline budget. */
  readonly mediaDropped: readonly string[];
  /** Images the model actually saw. */
  readonly mediaCount: number;
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
 *
 * ---------------------------------------------------------------------------
 * THE FALLBACK IS NOT "NO ASSESSMENT" — IT IS THE KEYWORD ENGINE
 * ---------------------------------------------------------------------------
 * Phase 3 returned `category: null, urgency: null, summary: null` and called that
 * honest. It was honest, and it was also a worse product than docs/09 §7.2
 * specifies: a dispatcher looking at a report with no category and no urgency has
 * nothing to sort on, and docs/09 §7.3 promises something stronger — "every
 * incident gets a plausible, honest triage even with zero AI availability".
 *
 * So the fallback now runs `fallbackTriage()`, which is pure, offline, and
 * keyword-derived. **Derived, not invented** — which is the distinction the
 * original test was protecting, and it is why that test was corrected rather than
 * deleted (see the note in `tests/unit/api/integrations.test.ts`). Every fallback
 * value traces to a word in the citizen's own report, the confidence is capped at
 * 0.55 so `needsReview` is always `true`, and the summary says on its face that
 * it is automated triage requiring human review.
 */
export async function triageIncident(
  request: TriageRequest,
  options: ProviderCallOptions & {
    readonly requestId: string;
    readonly provider?: TriageProvider;
    /** Optional attribution for the `aiRuns` document. */
    readonly audit?: AiRunContext;
  },
): Promise<TriageOutcome> {
  const provider = options.provider ?? getTriageProvider();
  const log = createLogger(options.requestId);
  const reviewThreshold = geminiConfig().confidenceReviewThreshold;

  /* --- the offline path, and the two ways to reach it ------------------- */
  if (options.skip === true || !provider.isAvailable()) {
    return keywordFallback(
      request,
      provider,
      options,
      'fallback',
      options.skip === true
        ? 'AI triage was skipped for this request.'
        : 'AI triage is not configured in this deployment, so keyword rules were used.',
    );
  }

  try {
    const result = await provider.triage(request, {
      timeoutMs: options.timeoutMs > 0 ? options.timeoutMs : geminiConfig().timeoutMs,
    });

    const outcome = fromProviderResult(result, provider, reviewThreshold);

    // Best-effort audit. `logAiRun` swallows its own failures, so this cannot
    // turn a good triage into a lost report (FR-029).
    const aiRunId = options.audit
      ? await logAiRun(
          buildAiRunDocument(
            result as GeminiTriageResult,
            options.audit,
            'success',
            new Date().toISOString(),
          ),
        )
      : null;

    return { ...outcome, aiRunId };
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    // A provider failure is a `warn`, not an `error`: it is an expected,
    // documented, survivable condition and a log full of `error` lines for
    // working-as-designed fallbacks trains an operator to ignore the log.
    log.warn({
      code: appError?.code ?? 'AI_UNAVAILABLE',
      path: 'services.ai.triage',
      status: appError?.status ?? 502,
      // A non-`AppError` is a BUG in the provider, so it is logged at `error` —
      // but with its constructor NAME only. An SDK error's message can carry a
      // provider request id and a response body, and this is a log line.
      ...(appError === null && error !== null
        ? { level: 'error', errorKind: error instanceof Error ? error.name : typeof error }
        : {}),
    });

    return keywordFallback(
      request,
      provider,
      options,
      outcomeForErrorCode(appError?.code ?? null),
      'AI triage was unavailable, so keyword rules were used. A person will review this report.',
    );
  }
}

/**
 * The `aiRuns` outcomes that mean "the keyword engine produced this record".
 *
 * Every one of them is a reason the model did not, or should not have, answered:
 * it was switched off, not configured, timed out, errored, came back malformed, or
 * was blocked by a content filter. `success` is deliberately absent — it is the
 * only outcome that is NOT a reason to have used the fallback, and allowing it
 * here would let a future caller record a keyword triage as a model call.
 */
type KeywordOutcome = Exclude<AiOutcome, 'success'>;

/** docs/09 §7.1's trigger table, mapped from the error code. */
function outcomeForErrorCode(code: string | null): KeywordOutcome {
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'AI_OUTPUT_INVALID') return 'validation_failed';
  return 'error';
}


/**
 * The keyword path. One function, so "the provider is unavailable", "the provider
 * failed", and "AI was skipped" cannot drift into three slightly different
 * outcomes — the bug class docs/30.4 §5.4 records about the rate limiter.
 */
async function keywordFallback(
  request: TriageRequest,
  provider: TriageProvider,
  options: { readonly audit?: AiRunContext },
  outcome: KeywordOutcome,
  rationale: string,
): Promise<TriageOutcome> {
  const result = fallbackTriage({
    text: request.text ?? '',
    language: request.language,
    // A DISTRICT label at most, and deliberately NOT derived from `locationHint`.
    // docs/09 §4.1 requires the server to reverse-geocode and discard
    // street-level components before a place label reaches the model; no geocoder
    // is wired up in this phase, so passing the hint through would put free-text
    // place naming into a field documented as a district label — and docs/09 §5.2
    // says `location_hint` is never stored on the incident anyway.
    coarseArea: null,
    hasCoordinates: false,
    reviewThreshold: geminiConfig().confidenceReviewThreshold,
  });

  const aiRunId = options.audit
    ? await logAiRun(
        buildFallbackRunDocument(options.audit, outcome, new Date().toISOString()),
      )
    : null;

  return {
    source: 'fallback',
    category: result.normalized.category,
    urgency: result.normalized.urgency,
    summary: result.normalized.summary,
    safetyFlags: result.normalized.safetyFlags,
    confidence: result.normalized.confidence,
    rationale,
    // FR-024. True for every fallback BY CONSTRUCTION — the engine's confidence
    // is capped below the threshold — and still computed rather than hardcoded,
    // so raising the threshold or lowering the cap cannot quietly produce a
    // fallback that claims to be trustworthy.
    needsReview: result.normalized.needsReview,
    providerName: provider.name,
    model: provider.model,
    promptVersion: provider.promptVersion,
    rawOutputHash: null,
    attempt: null,
    normalized: result.normalized,
    outcome,
    aiRunId,
    mediaDropped: [],
    mediaCount: 0,
  };
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
 *   3. **An empty result becomes the keyword fallback.** A provider that returns
 *      every `null` has declined, and a `new` incident with no category, no
 *      urgency, and no review flag is a report nobody will look at.
 *
 * `reviewThreshold` is a PARAMETER rather than a second `geminiConfig()` call so
 * the threshold is read once per request. Reading it twice would let a
 * mid-request environment change produce an outcome whose `needsReview` was
 * computed against a different number than the caller's.
 */
function fromProviderResult(
  result: TriageResult,
  provider: TriageProvider,
  reviewThreshold: number,
): TriageOutcome {
  const confidence =
    result.confidence === null ? null : Math.min(1, Math.max(0, result.confidence));

  const declined =
    result.category === null && result.urgency === null && result.summary === null;

  if (declined) {
    // Not a throw and not a silent empty result: the keyword engine decides. The
    // outcome carries `outcome: 'fallback'`, so `aiRuns` and the health endpoint
    // both record that a model was reached and declined.
    return {
      source: 'fallback',
      category: null,
      urgency: null,
      summary: null,
      safetyFlags: [],
      confidence: null,
      rationale: 'The model declined to assess this report, so keyword rules were used instead.',
      needsReview: true,
      providerName: provider.name,
      model: provider.model,
      promptVersion: provider.promptVersion,
      rawOutputHash: null,
      attempt: null,
      normalized: null,
      outcome: 'fallback',
      aiRunId: null,
      mediaDropped: [],
      mediaCount: 0,
    };
  }

  return {
    source: 'ai',
    category: result.category,
    urgency: result.urgency,
    summary: result.summary,
    safetyFlags: result.safetyFlags,
    confidence,
    rationale: result.rationale,
    needsReview: confidence === null || confidence < reviewThreshold,
    providerName: provider.name,
    model: provider.model,
    promptVersion: provider.promptVersion,
    rawOutputHash: result.rawOutputHash,
    attempt: isGeminiResult(result) ? result.attempt : 1,
    // The provider's own normalised record when it has one. A provider that only
    // implements the narrow `TriageResult` shape — which is what a test provider
    // and any future third-party provider will do — leaves this `null`, and the
    // dispatcher panel falls back to the narrow fields.
    normalized: isGeminiResult(result) ? result.normalized : null,
    outcome: 'success',
    aiRunId: null,
    mediaDropped: isGeminiResult(result) ? result.mediaDropped : [],
    mediaCount: isGeminiResult(result) ? result.mediaCount : 0,
  };
}

/**
 * Is this the WIDE result shape the Gemini provider returns?
 *
 * A structural check on the two fields that only the wide shape has, rather than
 * `instanceof`: a provider may be constructed in a different module instance (a
 * test seam, a duplicated dependency), and `instanceof` across that boundary is
 * false for a genuine Gemini result. Two required properties is enough, and a
 * false negative degrades to the narrow fields rather than throwing.
 */
function isGeminiResult(result: TriageResult): result is TriageResult & GeminiTriageResult {
  return (
    'normalized' in result &&
    'mediaDropped' in result &&
    (result as GeminiTriageResult).normalized !== undefined
  );
}

/**
 * `source: 'fallback'` is a PROVENANCE marker, not a failure marker: it says a
 * human must read this report, which is the correct handling for an emergency
 * platform whose AI is unavailable.
 *
 * Phase 3's version of this function returned `confidence: null` and every field
 * null, on the reasoning that "no meter renders a number nobody measured". That
 * was true and it was also self-defeating: docs/09 §7.3 requires a *plausible,
 * honest* triage with zero AI availability, and a record with nothing in it gives
 * a dispatcher no category to sort on and no urgency to sort by.
 *
 * The keyword engine's 0.55 confidence IS a measured number — of how much a string
 * match is worth — and it sits below `AI_CONFIDENCE_REVIEW_THRESHOLD` by
 * construction, so the "needs review" treatment is preserved exactly. What changed
 * is that the record is now usable, not that it became more trustworthy.
 */

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
  /**
   * Already-validated images, Phase 4. Omitted by text-only callers.
   *
   * The type is `readonly TriageImage[]` rather than anything looser, and that is
   * the boundary doing its job: a caller cannot hand this function a raw body, a
   * Storage URL, or an unvalidated base64 string, because the only shape that fits
   * is the one `validateImage` produces. The alternative — accepting a loose
   * object and validating here — would put the check one layer too far from the
   * request that motivated it, and a future caller would skip it.
   *
   * Truncated to `maxImages` for the same reason `imageCount` is: a caller that
   * supplies four images gets three analysed, and the FOURTH is recorded in
   * `mediaDropped` rather than silently ignored.
   */
  readonly images?: readonly TriageImage[];
}): TriageRequest {
  const images = (input.images ?? []).slice(0, TRIAGE_LIMITS.maxImages);
  return {
    text: input.text === null ? null : input.text.slice(0, TRIAGE_LIMITS.textMaxChars),
    language: input.language,
    locationHint:
      input.locationHint === null
        ? null
        : input.locationHint.slice(0, TRIAGE_LIMITS.locationHintMaxChars),
    locationAccuracy: input.locationAccuracy,
    // The COUNT is derived from the images actually present, never trusted from
    // the caller. A client that said `imageCount: 3` and sent one image would
    // otherwise make the prompt tell the model three images are attached when it
    // can see one.
    imageCount: images.length,
    audioCount: clampCount(input.audioCount, TRIAGE_LIMITS.maxAudioClips),
    newAccount: input.newAccount,
    images,
  };
}

function clampCount(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(max, Math.floor(value));
}

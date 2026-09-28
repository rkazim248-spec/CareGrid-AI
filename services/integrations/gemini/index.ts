/**
 * ============================================================================
 * CareGrid AI — the Gemini integration
 * ============================================================================
 *
 * The provider. `services/integrations/gemini/client.ts` is the transport; this
 * file is the policy: what to send, how to read the answer, and what to do when
 * the answer is unusable.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PROVIDERS HERE, AND WHY ALL THREE ARE REAL OBJECTS
 * ---------------------------------------------------------------------------
 *
 * | Provider | `isAvailable()` | When it is chosen |
 * | --- | --- | --- |
 * | `GeminiTriageProvider` | `true` | a key is configured |
 * | `MockTriageProvider` | `true` | `AI_MOCK_MODE` is on (refused in production, see `isAiMockMode()`) |
 * | `UnconfiguredGeminiProvider` | `false` | no key — the real state of an unconfigured deployment |
 *
 * All three satisfy the same `TriageProvider` interface, and the reason they are
 * classes rather than `null`s is the one docs/30.4 §3.2 recorded: a route must
 * not be writable against "the provider might be missing", because that shape
 * turns into `if (!provider) return {}` and a silent empty triage.
 *
 * The unconfigured provider still **throws** `AI_UNAVAILABLE` from `triage()`
 * rather than returning an empty result. An honest failure beats a fabricated
 * success on a real emergency report, and `triageIncident()` catches it.
 *
 * ---------------------------------------------------------------------------
 * MUST NOT 8, AND WHY IT IS STRUCTURAL
 * ---------------------------------------------------------------------------
 * There is no code path from a `TriageResult` to a dispatch, an outbound call, a
 * notification to an authority, or a lifecycle transition beyond `new → triaged`.
 * `TriageResult` has no field that could carry a coordinate, a casualty count, or
 * a resource, so the prohibition is a property of the TYPE rather than a
 * convention someone could forget (docs/09 §1.2).
 *
 * ---------------------------------------------------------------------------
 * WHERE THE REPAIR CALL LIVES, AND WHY IT IS NOT IN `services/ai/triage.ts`
 * ---------------------------------------------------------------------------
 * docs/09 §3 assigns repair to the service layer. It is here instead, and the
 * reason is the interface: the repair is a SECOND Gemini call with a
 * Gemini-shaped prompt, and `TriageProvider` is deliberately a three-method
 * interface rather than "generate plus options" (docs/34 §1.3). Widening it to
 * expose a second call would make the seam something a provider author can use to
 * run arbitrary generations — which is precisely the property that keeps "just ask
 * the model to dispatch someone" from being a one-line addition later.
 *
 * So the repair is an implementation detail of the provider that can make calls,
 * and `aiRuns.attempt` records which attempt produced the stored result.
 */

import 'server-only';

import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { geminiConfig, geminiStatus, isAiMockMode, type IntegrationStatus } from '@/lib/env.server';
import {
  aiTriageOutputSchema,
  type AiTriageOutput,
} from '@/services/ai/schema';
import {
  EXAMPLES,
  PROMPT_VERSION,
  SYSTEM_INSTRUCTION,
  buildRepairPrompt,
  buildUserContent,
  multimodalInstruction,
  type PromptContext,
} from '@/services/ai/prompts';
import { sanitiseLabel, sanitiseForModel } from '@/services/ai/sanitize';
import { normalizeTriageOutput, type NormalizedTriage } from '@/services/ai/rules';
import { fitImagesToBudget } from '@/services/ai/media';
import { RESOURCE_IDS } from '@/config/resources';
import { SLA_MINUTES } from '@/config/urgencies';
import type {
  ProviderCallOptions,
  ProviderStatus,
  TriageProvider,
  TriageRequest,
  TriageResult,
} from '@/lib/integrations/contracts';
import {
  callGemini,
  hashRawOutput,
  type GeminiCall,
  type GeminiTransport,
} from './client';

/**
 * Bumped whenever the system prompt changes (docs/09 §6, docs/32 §7).
 *
 * Re-exported from `prompts.ts`, which owns the text, so the version and the
 * prompt cannot drift apart. A CONSTANT rather than an environment variable
 * because it is a property of the code that produced a result, not of the
 * deployment: two deployments on the same build must record the same
 * `aiRuns.promptVersion` or the field stops meaning anything.
 */
export { PROMPT_VERSION } from '@/services/ai/prompts';

/** The model actually in use, read from `GEMINI_MODEL` (docs/21 §2). */
export function geminiModel(): string {
  return geminiConfig().model;
}

/* ========================================================================== */
/* The result the provider builds                                               */
/* ========================================================================== */

/**
 * What a provider hands back. Wider than `TriageResult` on purpose.
 *
 * `TriageResult` is the narrow, deliberately-unable-to-do-harm type that crosses
 * into `services/ai/triage.ts`. This one adds what the pipeline needs for
 * `aiRuns` and the dispatcher panel: the normalised record, the sanitiser's
 * findings, and the outcome of the call. None of it can dispatch anything.
 */
export type GeminiTriageResult = TriageResult & {
  /**
   * Which model and prompt version produced this.
   *
   * On the RESULT, not only on the provider, because `aiRuns` records them per
   * attempt and a provider instance is memoised for the life of the process. If
   * `GEMINI_MODEL` were read from the provider at write time, every `aiRuns`
   * document would carry the CURRENT model rather than the one that actually
   * answered — which silently rewrites the meaning of historical data the first
   * time anyone edits `.env`.
   */
  readonly model: string;
  readonly promptVersion: string;
  readonly normalized: NormalizedTriage;
  readonly suspicionScore: number;
  readonly suspicionHits: readonly string[];
  readonly floodGuardApplied: boolean;
  readonly piiRedacted: boolean;
  readonly hallucinationFiltered: boolean;
  /** 1 = first answer, 2 = the repair. docs/09 §8. */
  readonly attempt: 1 | 2;
  /** Names of images that exceeded the inline budget and were not sent. */
  readonly mediaDropped: readonly string[];
  /**
   * How many images the model was actually given.
   *
   * Separate from `mediaDropped` because the dispatcher needs the COUNT the model
   * saw, not only the names of what it missed: "3 photos, the model saw 2" and
   * "1 photo, the model saw 0" are different situations and the second is the one
   * that means the report was triaged as text only.
   */
  readonly mediaCount: number;
  /** `true` when a safety filter stopped generation. docs/09 §6.2. */
  readonly blocked: boolean;
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
  /** The model-reported language, before R10 folds it. */
  readonly detectedLanguage: string;
};

/* ========================================================================== */
/* Building the call                                                            */
/* ========================================================================== */

/**
 * Build the system turn: the constant instruction plus the few-shot examples.
 *
 * The examples go in the SYSTEM turn deliberately, and not in the user turn with
 * the report. They are trusted, they are authored here, and putting them in the
 * user turn would place them inside the same delimited block as untrusted text —
 * which would teach the model that `<citizen_report>` is not a boundary.
 */
function systemInstruction(): string {
  const examples = EXAMPLES.map(
    (example, index) =>
      `## EXAMPLE ${index + 1} — ${example.case}\nInput: ${example.input}\nCorrect output: ${example.output}`,
  ).join('\n\n');

  return `${SYSTEM_INSTRUCTION}\n\n${examples}`;
}

/** The prompt context, assembled from things that are not the citizen's words. */
function promptContextFor(
  request: TriageRequest,
  sanitised: { readonly suspicionScore: number },
  hasCoordinates: boolean,
  coarseArea: string | null,
): PromptContext {
  return {
    hasLocation: hasCoordinates || request.locationHint !== null,
    // A DISTRICT label at most. `sanitiseLabel` applies the same marker
    // neutralisation as the report, because a maps response is user-controlled
    // and "Ignore Previous Instructions Market" is a place name that would
    // otherwise sit in the trusted part of the turn (docs/09 §4.1).
    coarseArea: coarseArea === null ? null : sanitiseLabel(coarseArea, 80),
    imageCount: request.imageCount,
    hasAudio: request.audioCount > 0,
    languageHint: request.language === '' ? null : request.language,
    reportedAtIso: new Date().toISOString(),
    resourceIds: [...RESOURCE_IDS],
    slaMinutes: { ...SLA_MINUTES },
    suspicionScore: sanitised.suspicionScore,
  };
}

/* ========================================================================== */
/* The provider                                                                 */
/* ========================================================================== */

/**
 * The real provider. One call, then at most one repair, then a typed failure.
 *
 * It never returns a partial or invented result. If the answer cannot be parsed
 * and validated it throws `AI_OUTPUT_INVALID`, and `triageIncident()` runs the
 * keyword fallback. A degraded but honest triage is the documented outcome; a
 * plausible-looking invented one is not.
 */
class GeminiTriageProvider implements TriageProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly promptVersion = PROMPT_VERSION;

  /** Injected by tests so the whole provider is exercisable with no key. */
  private readonly transport: GeminiTransport | undefined;
  private readonly hasCoordinates: boolean;
  private readonly coarseArea: string | null;

  constructor(model: string, options: {
    readonly transport?: GeminiTransport;
    readonly hasCoordinates?: boolean;
    readonly coarseArea?: string | null;
  } = {}) {
    this.model = model;
    this.transport = options.transport;
    this.hasCoordinates = options.hasCoordinates ?? false;
    this.coarseArea = options.coarseArea ?? null;
  }

  isAvailable(): boolean {
    return geminiStatus().configured;
  }

  /**
   * Triage one report.
   *
   * Throws `AppError` on any failure — the caller decides whether to fall back,
   * and only the caller may, because the fallback also writes `triageSource`,
   * which the provider has no business knowing about.
   */
  async triage(request: TriageRequest, options: ProviderCallOptions): Promise<GeminiTriageResult> {
    const log = createLogger('');

    /* --- 1. the sanitisation boundary, applied before anything else ----- */
    const sanitised = sanitiseForModel(request.text ?? '');

    /* --- 2. media: budgeted, and the drops recorded --------------------- */
    const { kept, droppedFileNames } = this.media(request);

    /* --- 3. the two prompt turns ---------------------------------------- */
    const context = promptContextFor(request, sanitised, this.hasCoordinates, this.coarseArea);
    const transcript =
      request.audioCount > 0 ? null : null; // audio arrives as a part, never as text
    const userText = [
      buildUserContent(sanitised.text, context, transcript),
      kept.length > 0 ? multimodalInstruction(kept.length) : '',
    ]
      .filter((part) => part.length > 0)
      .join('\n');

    const call: GeminiCall = {
      systemInstruction: systemInstruction(),
      userText,
      images: kept.map((image) => ({ mimeType: image.mimeType, base64: image.base64 })),
    };

    /* --- 4. attempt 1 ---------------------------------------------------- */
    const first = await callGemini(call, { timeoutMs: options.timeoutMs, transport: this.transport });

    const blocked = first.blocked;
    if (blocked) {
      // docs/09 §6.2: a blocked report is not a parse failure. The citizen
      // described something frightening enough to trip a filter and gets a human
      // at `high` urgency plus the keyword fallback for the rest — which is what
      // `triageIncident()` does with the throw below. No repair attempt: the
      // model is not going to answer differently, and retrying a safety block is
      // the fastest way to get a project-level throttle.
      log.warn({ code: 'AI_OUTPUT_INVALID', path: 'integrations.gemini', status: 422 });
      throw new AppError({
        code: 'AI_OUTPUT_INVALID',
        message: 'AI analysis was blocked by a content filter. The report is still recorded and a person will review it.',
      });
    }

    const firstParse = parseAndValidate(first.text);
    if (firstParse.ok) {
      return this.finish(firstParse.output, 1, {
        request,
        sanitised,
        droppedFileNames,
        blocked: false,
        first,
      });
    }

    /* --- 5. attempt 2: the one repair call. docs/09 §8 ------------------- */
    const repairAttempts = geminiConfig().repairAttempts;
    if (repairAttempts < 1) throw invalidOutput(firstParse.issues);

    log.warn({
      code: 'AI_OUTPUT_INVALID',
      path: 'integrations.gemini.repair',
      status: 422,
    });

    const repair = await callGemini(
      {
        // The repair replaces the USER turn, not the system turn. The system
        // instruction is unchanged, because the problem was the ANSWER's shape,
        // not the instructions.
        systemInstruction: call.systemInstruction,
        userText: `${buildRepairPrompt(firstParse.issues)}\n\n${userText}`,
        images: call.images,
        repairIssuePaths: firstParse.issues,
      },
      { timeoutMs: options.timeoutMs, transport: this.transport },
    );

    const repairParse = parseAndValidate(repair.text);
    if (!repairParse.ok) throw invalidOutput(repairParse.issues);

    return this.finish(repairParse.output, 2, {
      request,
      sanitised,
      droppedFileNames,
      blocked: repair.blocked,
      first: repair,
    });
  }

  /** Run the deterministic rules and assemble the result. */
  private finish(
    output: AiTriageOutput,
    attempt: 1 | 2,
    context: {
      readonly request: TriageRequest;
      readonly sanitised: ReturnType<typeof sanitiseForModel>;
      readonly droppedFileNames: readonly string[];
      readonly blocked: boolean;
      readonly first: { readonly text: string; readonly promptTokens: number | null; readonly outputTokens: number | null };
    },
  ): GeminiTriageResult {
    const normalized = normalizeTriageOutput(output, {
      hasCoordinates: this.hasCoordinates,
      suspicionScore: context.sanitised.suspicionScore,
      // The REPORTER'S words, not the sanitised copy: R8 asks "did they say this?"
      // and a diagnosis term removed by the neutraliser would otherwise look
      // invented. docs/09 §5.3 R8.
      originalText: context.request.text ?? '',
      reviewThreshold: geminiConfig().confidenceReviewThreshold,
    });

    return {
      category: normalized.category,
      urgency: normalized.urgency,
      summary: normalized.summary,
      safetyFlags: normalized.safetyFlags,
      confidence: normalized.confidence,
      rationale: null,
      // The HASH, never the output. docs/09 §9.
      rawOutputHash: hashRawOutput(context.first.text),
      model: this.model,
      promptVersion: this.promptVersion,
      normalized,
      suspicionScore: context.sanitised.suspicionScore,
      suspicionHits: context.sanitised.suspicionHits,
      floodGuardApplied: context.sanitised.floodGuardApplied,
      piiRedacted: context.sanitised.piiRedacted,
      hallucinationFiltered: normalized.hallucinationFiltered,
      attempt,
      mediaDropped: context.droppedFileNames,
      mediaCount: Math.max(
        0,
        (context.request.images?.length ?? 0) - context.droppedFileNames.length,
      ),
      blocked: context.blocked,
      promptTokens: context.first.promptTokens,
      outputTokens: context.first.outputTokens,
      detectedLanguage: output.language,
    };
  }

  /**
   * Attach the request's images, budgeted.
   *
   * The bytes ride on the `TriageRequest` extension rather than being fetched
   * here, so this module never learns about Firestore Storage. The upload and
   * verification path is `services/uploads/**` (docs/15), which does not exist
   * yet; until it does, a caller supplies already-validated `ValidatedImage`
   * objects and this function only applies the budget and the drop record.
   */
  private media(request: TriageRequest): {
    readonly kept: readonly { readonly mimeType: string; readonly base64: string; readonly fileName: string }[];
    readonly droppedFileNames: readonly string[];
  } {
    const images = request.images ?? [];
    if (images.length === 0) return { kept: [], droppedFileNames: [] };
    return fitImagesToBudget(images);
  }
}

/* ========================================================================== */
/* Parsing                                                                      */
/* ========================================================================== */

/** The result of parsing model output: a validated record, or the Zod issues. */
type ParseResult =
  | { readonly ok: true; readonly output: AiTriageOutput }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Parse and validate one response.
 *
 * **The model output is untrusted input** (docs/24 T-09). It is JSON from a
 * third party that may have been persuaded to emit anything, so it goes through
 * exactly the same `.strict()` Zod validation as an HTTP request body.
 *
 * A JSON parse failure and a schema failure are reported the same way — as issue
 * paths — because the repair call only needs to know WHICH fields were wrong, not
 * what the model said. docs/09 §8 is explicit that the prior response is not
 * included: it may itself contain injected content, and echoing it back gives the
 * injection a second attempt with the schema's vocabulary to hide behind.
 */
export function parseAndValidate(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, issues: ['(the whole object: not valid JSON)'] };
  }

  const result = aiTriageOutputSchema.safeParse(parsed);
  if (result.success) return { ok: true, output: result.data };

  return {
    ok: false,
    // Bounded and path-only. An unbounded list from a model that returned 4000
    // keys would be sent back in the repair prompt.
    issues: result.error.issues.slice(0, 8).map((issue) => issue.path.join('.') || '(root)'),
  };
}

function invalidOutput(issues: readonly string[]): AppError {
  return new AppError({
    code: 'AI_OUTPUT_INVALID',
    message:
      'AI analysis returned a record that did not match the required format. ' +
      'The report is still recorded and a person will review it.',
    // `AppErrorDetails` is `{ field, issue }[]` — the shape a client already
    // renders for a 400, so the AI's schema failures arrive in the same envelope
    // a request-validation failure does and need no new client branch.
    //
    // The field is a PATH, never the value. A Zod issue message can quote the
    // offending input ("expected 'critical', received 'urgent'"), and that input
    // is model output derived from a citizen's report — so it would put report
    // content into an error surface. The path alone is enough to debug it.
    details: issues.map((path) => ({ field: path, issue: 'did not match the AI output schema' })),
  });
}

/* ========================================================================== */
/* The unconfigured provider                                                    */
/* ========================================================================== */

/**
 * No key. `isAvailable()` is `false` and `triage()` throws.
 *
 * The honest state of an unconfigured deployment, and the shape
 * `tests/unit/api/integrations.test.ts` pins. It returns no invented data: a
 * fabricated `urgency: 'critical'` on a real emergency report is a fabricated
 * triage decision, and FR-029's whole point is that the report survives the AI
 * not existing.
 */
class UnconfiguredGeminiProvider implements TriageProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly promptVersion = PROMPT_VERSION;

  constructor(model: string) {
    this.model = model;
  }

  isAvailable(): boolean {
    return false;
  }

  async triage(_request: TriageRequest, _options: ProviderCallOptions): Promise<GeminiTriageResult> {
    throw new AppError({
      code: 'AI_UNAVAILABLE',
      message:
        'AI triage is not available in this deployment, so no AI assessment was made. ' +
        'The report is still recorded and will be reviewed by a person.',
    });
  }
}

/* ========================================================================== */
/* The development mock                                                         */
/* ========================================================================== */

/**
 * A canned Gemini-shaped response, for exercising the pipeline without a key.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A "FAKE SUCCESS"
 * ---------------------------------------------------------------------------
 * A mock that returns a fabricated `urgency` for a real report is the exact thing
 * docs/32 MUST 7 forbids and the exact thing that would be invisible in a demo
 * and catastrophic in production. Four properties make this one different:
 *
 *  1. **It is a fixture, not an answer.** The response is a fixed, valid JSON
 *     object with an obviously conservative triage. It does not pretend to read
 *     the report; it exercises the parse → Zod → rules path so that path can be
 *     demonstrated and tested without a network.
 *  2. **It goes through the SAME validation.** `parseAndValidate` and
 *     `normalizeTriageOutput` run on it exactly as on a real response, so a
 *     schema change that breaks the pipeline breaks the mock too.
 *  3. **It is refused in production and ignored when a key exists.** See
 *     `isAiMockMode()` — three conditions, all required.
 *  4. **It is LOUD.** `name` is `gemini-mock`, `providerStatus().problem` says so,
 *     `serverEnvProblems()` reports it as a fault, and the API response carries
 *     `simulated: true`. A demo built with the mock on says so on screen; a build
 *     with a real key cannot be shadowed by it.
 *
 * The 50 adversarial fixtures in `tests/fixtures/ai/` are the honest version of
 * this idea, and they run in CI with no flag at all. The mock exists for a human
 * looking at the UI, not for a test.
 */
class MockTriageProvider implements TriageProvider {
  readonly name = 'gemini-mock';
  readonly model: string;
  readonly promptVersion = PROMPT_VERSION;

  constructor(model: string) {
    this.model = model;
  }

  isAvailable(): boolean {
    return true;
  }

  async triage(request: TriageRequest, _options: ProviderCallOptions): Promise<GeminiTriageResult> {
    const canned = MOCK_RESPONSE;
    const parsed = parseAndValidate(canned);
    // Cannot happen — the constant is validated by a test — and if it ever does,
    // throwing is the right answer. A mock that could not produce a valid record
    // would be a mock that had stopped testing anything.
    if (!parsed.ok) throw invalidOutput(parsed.issues);

    const normalized = normalizeTriageOutput(parsed.output, {
      // The mock does not know where the incident is, so it behaves like a report
      // with no coordinates: `unclear_location` is added and the confidence is
      // left low. A mock that claimed high confidence and a known location would
      // be the fabrication this whole class exists to avoid.
      hasCoordinates: false,
      suspicionScore: sanitiseForModel(request.text ?? '').suspicionScore,
      originalText: request.text ?? '',
      reviewThreshold: geminiConfig().confidenceReviewThreshold,
    });

    return {
      category: normalized.category,
      urgency: normalized.urgency,
      summary: normalized.summary,
      safetyFlags: normalized.safetyFlags,
      confidence: normalized.confidence,
      rationale: 'Development mock. No model was called.',
      rawOutputHash: hashRawOutput(canned),
      model: this.model,
      promptVersion: this.promptVersion,
      normalized,
      suspicionScore: 0,
      suspicionHits: [],
      floodGuardApplied: false,
      piiRedacted: false,
      hallucinationFiltered: false,
      attempt: 1,
      mediaDropped: [],
      mediaCount: request.images?.length ?? 0,
      blocked: false,
      promptTokens: 0,
      outputTokens: 0,
      detectedLanguage: parsed.output.language,
    };
  }
}

/**
 * The canned response.
 *
 * Every field satisfies the schema, and the values are deliberately unexciting:
 * `other`, `low`, confidence 0.3, `low_confidence` set. A mock that returned
 * `critical` would be the most dangerous line in this file, because it is the one
 * a screenshot would show.
 */
const MOCK_RESPONSE = JSON.stringify({
  category: 'other',
  category_confidence: 0.2,
  urgency: 'low',
  urgency_confidence: 0.2,
  summary: 'Development mock response. No AI analysis was performed on this report.',
  language: 'en',
  location_hint: null,
  landmarks: [],
  people_affected: null,
  people_affected_stated: false,
  required_resources: [],
  hazards: [],
  safety_flags: ['low_confidence', 'unclear_location'],
  audio_transcript: null,
  audio_transcript_uncertain: false,
  confidence: 0.3,
  unknown_fields: ['location', 'people_affected'],
});

/* ========================================================================== */
/* Selection                                                                    */
/* ========================================================================== */

/**
 * The singleton.
 *
 * Memoised on `globalThis` for the same reason the Admin app and the SDK client
 * are (docs/06 §1.2): a Vercel instance is reused across requests and a module
 * variable is re-initialised by a dev-server reload. Constructed on FIRST USE,
 * never at import time, so importing this module costs nothing and cannot throw.
 *
 * **No environment is read here.** `isAiMockMode()` is evaluated by
 * `lib/env.server.ts`, which is the only place allowed to read `process.env`, and
 * `scripts/security-check.cjs` asserts this file contains no environment read at
 * all. That is what keeps the "no dev-only branch in an integration" check
 * meaningful — the flag cannot be consulted here even by accident.
 */
const CACHE_KEY = '__caregrid_gemini_provider_v1__';

type GlobalWithProvider = typeof globalThis & { [CACHE_KEY]?: TriageProvider };

export function getTriageProvider(): TriageProvider {
  const cache = globalThis as GlobalWithProvider;
  const existing = cache[CACHE_KEY];
  if (existing) return existing;

  const config = geminiConfig();
  const status = geminiStatus();

  let provider: TriageProvider;
  if (status.configured) {
    provider = new GeminiTriageProvider(config.model);
  } else if (isAiMockMode()) {
    provider = new MockTriageProvider(config.model);
  } else {
    // The operator's signal that the integration is dark, ONCE per instance
    // rather than per request.
    createLogger('').warn({ code: 'AI_UNAVAILABLE', path: 'integrations.gemini', status: 502 });
    provider = new UnconfiguredGeminiProvider(config.model);
  }

  cache[CACHE_KEY] = provider;
  return provider;
}

/** Test seam. Production code must never call this (docs/05 §8.1). */
export function resetGeminiProviderForTests(): void {
  delete (globalThis as GlobalWithProvider)[CACHE_KEY];
}

/** The real provider class, exported for tests that inject a transport. */
export function createGeminiProviderForTests(
  options: { readonly transport?: GeminiTransport; readonly hasCoordinates?: boolean; readonly coarseArea?: string | null } = {},
): TriageProvider {
  return new GeminiTriageProvider(geminiConfig().model, options);
}

/* ========================================================================== */
/* Status                                                                       */
/* ========================================================================== */

export function providerStatus(): ProviderStatus {
  const status: IntegrationStatus = geminiStatus();
  const mock = isAiMockMode();
  return {
    provider: 'gemini',
    // `configured` stays FALSE in mock mode. A mock is not a configured
    // provider, and an operator reading `/api/admin/system/health` must not be
    // told the integration is live when it is not.
    configured: status.configured,
    requiredVars: status.required,
    problem: mock
      ? 'AI_MOCK_MODE is on: AI triage returns a canned response and no Gemini request is made.'
      : status.problem,
  };
}

/** The tunables, for the admin health endpoint. Values are never secrets. */
export function geminiSettings() {
  const config = geminiConfig();
  return {
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    rpmLimit: config.rpmLimit,
    rpdLimit: config.rpdLimit,
    audioEnabled: config.audioEnabled,
    confidenceReviewThreshold: config.confidenceReviewThreshold,
    repairAttempts: config.repairAttempts,
    localQuotaGuard: config.localQuotaGuard,
    promptVersion: PROMPT_VERSION,
    /** Surfaced so the UI can say "not configured" instead of "failed". */
    mockMode: isAiMockMode(),
  };
}

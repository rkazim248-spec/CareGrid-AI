/**
 * ============================================================================
 * CareGrid AI — the Gemini integration
 * ============================================================================
 *
 * The ONE file in this repository that reads `GEMINI_API_KEY`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS IN PHASE 3
 * ---------------------------------------------------------------------------
 * A complete, honest, NON-FUNCTIONAL adapter. It is not a stub that returns
 * fake data and it is not a mock pretending to be production:
 *
 *   - It resolves its configuration exactly as Phase 4 will.
 *   - It reports `isAvailable() === false` when the key is absent, which is the
 *     real state of this deployment.
 *   - `triage()` throws `AppError('AI_UNAVAILABLE')` — 502, "AI assistance is
 *     temporarily unavailable. You can still continue without it." — which is
 *     the documented degraded path (docs/09 §7) and NOT a crash.
 *
 * The alternative would have been to fabricate a plausible category and
 * urgency. docs/32 MUST 6 forbids it, and for this product specifically it
 * would be dangerous: a fabricated `urgency: 'critical'` on a real emergency
 * report is a fabricated triage decision. The honest failure is the whole point
 * of FR-029.
 *
 * ---------------------------------------------------------------------------
 * WHAT PHASE 4 ADDS, AND ONLY HERE
 * ---------------------------------------------------------------------------
 * 1. `npm i @google/genai` (docs/02 — it is the approved SDK; the deprecated
 *    `@google/generative-ai` is not used).
 * 2. A lazily-constructed, memoised `GoogleGenAI` in `client()`.
 * 3. The `triage-v3` system prompt from docs/09 §6, with `PROMPT_VERSION`
 *    bumped, and the golden files in `tests/fixtures/ai/golden/` updated.
 * 4. The retry policy: `maxRetries` for 429 and 503 ONLY, never for 400.
 * 5. `AI_OUTPUT_INVALID` (422) when the JSON does not satisfy
 *    `validators/ai.ts` — the model output is untrusted input (docs/24 T-09).
 * 6. Quota accounting from `GEMINI_RPM_LIMIT` / `GEMINI_RPD_LIMIT`.
 *
 * Nothing outside this directory changes. That is the test of whether the
 * abstraction is real: Phase 4 edits these files and adds a dependency, and
 * touches no route, no service, and no component.
 *
 * ---------------------------------------------------------------------------
 * WHY `apiKey` IS NEVER LOGGED
 * ---------------------------------------------------------------------------
 * `createLogger`'s allow-list drops any key not named in it, so even an
 * accidental `log.info({ apiKey })` would emit nothing. That is defence in the
 * second layer; the first is that this file has no reason to log it. Both
 * layers exist because a secret in a log has a half-life measured in months
 * (docs/10 §16.2).
 */

import 'server-only';

import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import {
  geminiConfig,
  geminiStatus,
  type IntegrationStatus,
} from '@/lib/env.server';
import type {
  ProviderCallOptions,
  ProviderStatus,
  TriageProvider,
  TriageRequest,
  TriageResult,
} from '@/lib/integrations/contracts';

/**
 * Bumped whenever the system prompt changes (docs/32 §7, "If you need to change
 * the AI prompt").
 *
 * The value is a CONSTANT in this file rather than an environment variable,
 * because it is a property of the CODE that produced a result, not of the
 * deployment. Two deployments running the same build must produce the same
 * version, or `aiRuns.promptVersion` stops meaning anything.
 */
export const PROMPT_VERSION = 'triage-v3';

/** The model actually in use, read from `GEMINI_MODEL` (docs/21 §2). */
export function geminiModel(): string {
  return geminiConfig().model;
}

/* ========================================================================== */
/* The provider                                                                */
/* ========================================================================== */

/**
 * The Phase 3 provider: correct in every respect except that it has no client.
 *
 * It is a real object with the real `TriageProvider` shape rather than a
 * `null` that every call site has to null-check. A route therefore cannot be
 * written against "the provider might be missing", which is the shape that
 * turns into `if (!provider) return {}` and a silent empty triage.
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

  /**
   * Always throws. Phase 3 never calls a model, and the throw is the honest
   * answer: `502 AI_UNAVAILABLE` with copy that tells the caller the report is
   * still fine without it.
   */
   
  async triage(_request: TriageRequest, _options: ProviderCallOptions): Promise<TriageResult> {
    throw new AppError({
      code: 'AI_UNAVAILABLE',
      message:
        'AI triage is not available in this deployment, so no AI assessment was made. ' +
        'The report is still recorded and will be reviewed by a person.',
    });
  }
}

/**
 * The singleton.
 *
 * Memoised on `globalThis` for the same reason the Admin app is (docs/06 §1.2):
 * a Vercel instance is reused across requests and a module variable is
 * re-initialised by a dev-server reload. Constructed on FIRST USE, never at
 * import time, so importing this module costs nothing and cannot throw.
 */
const CACHE_KEY = '__caregrid_gemini_provider_v1__';

type GlobalWithProvider = typeof globalThis & { [CACHE_KEY]?: TriageProvider };

/**
 * The provider every caller uses.
 *
 * Phase 4 replaces the body of `UnconfiguredGeminiProvider.triage` and the
 * construction here. Nothing else in the repository changes.
 */
export function getTriageProvider(): TriageProvider {
  const cache = globalThis as GlobalWithProvider;
  const existing = cache[CACHE_KEY];
  if (existing) return existing;

  const config = geminiConfig();
  const status = geminiStatus();

  // The log line is the operator's signal that the integration is dark, and it
  // fires ONCE per instance rather than per request.
  if (!status.configured) {
    createLogger('').warn({ code: 'AI_UNAVAILABLE', path: 'integrations.gemini', status: 502 });
  }

  const provider: TriageProvider = new UnconfiguredGeminiProvider(config.model);
  cache[CACHE_KEY] = provider;
  return provider;
}

/** Test seam. Production code must never call this (docs/05 §8.1). */
export function resetGeminiProviderForTests(): void {
  delete (globalThis as GlobalWithProvider)[CACHE_KEY];
}

/* ========================================================================== */
/* Status                                                                      */
/* ========================================================================== */

export function providerStatus(): ProviderStatus {
  const status: IntegrationStatus = geminiStatus();
  return {
    provider: 'gemini',
    configured: status.configured,
    requiredVars: status.required,
    problem: status.problem,
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
    promptVersion: PROMPT_VERSION,
  };
}

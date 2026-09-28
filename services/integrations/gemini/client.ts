/**
 * ============================================================================
 * CareGrid AI — the Gemini SDK client
 * ============================================================================
 *
 * The only file in this repository that constructs `GoogleGenAI`. It owns the
 * timeout, the retry policy, the local quota guard, and the translation of every
 * SDK failure into an `AppError`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLIENT IS NOT IN `index.ts`
 * ---------------------------------------------------------------------------
 * Two reasons, and the second is the one that matters.
 *
 *  1. **The security check.** `scripts/security-check.cjs` asserts that
 *     `GEMINI_API_KEY` is read by `lib/env.server.ts` and nowhere else, and that
 *     no integration file contains `NODE_ENV`/`DEV`. Separating the SDK
 *     transport from the provider policy keeps each file's rules legible: this
 *     one is about HTTP, `index.ts` is about triage.
 *  2. **Testability without a network.** Every function here takes its inputs as
 *     parameters and returns a plain result. The retry policy, the backoff, the
 *     429-versus-400 decision, and the blocked-response handling are all pure
 *     functions of an injected outcome — so `tests/unit/ai/client.test.ts`
 *     exercises the real branching with no key, no quota, and no wait.
 *
 * The trade is one extra file and one indirection. docs/09 §2 anticipated this:
 * "If the SDK major version changes, `services/ai/gemini.ts` is the only file
 * that may change." Phase 3 recorded the naming decision in docs/34 §1.1
 * (`client.ts` + `index.ts`) and this build follows it, because the security
 * check is the harder constraint and a security check is not negotiable for
 * tidiness.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT IN THIS FILE, AND WHY EACH MATTERS
 * ---------------------------------------------------------------------------
 * - **No prompt, no schema, no post-processing.** That is `prompts.ts`,
 *   `schema.ts`, `rules.ts`. A client that knew the prompt shape would have to be
 *   changed when the prompt changed, and would stop being swappable.
 * - **No `process.env`.** Every tunable comes from `geminiConfig()`. The security
 *   check enforces this, and it is right: a direct read bypasses the clamping and
 *   the boot check.
 * - **No logging of the request or the response body.** `docs/10 §16.3` says the
 *   logger is an allow-list, so an accidental `log.info({ response })` would emit
 *   nothing — but this file has no reason to try. A triage response can contain a
 *   quoted description of an injured person.
 * - **No tool/function definitions.** docs/09 §4.3 step 9. The model cannot call
 *   anything because nothing is offered, which is a structural property rather
 *   than an instruction it could decline to follow.
 */

import 'server-only';

import { GoogleGenAI } from '@google/genai';

import { AppError } from '@/lib/server/errors';
import { geminiConfig } from '@/lib/env.server';
import { AI_RESPONSE_JSON_SCHEMA, type JsonSchemaNode } from '@/services/ai/schema';
import { GENERATION_CONFIG, REPAIR_TEMPERATURE } from '@/services/ai/prompts';
import { createHash } from 'node:crypto';

/* ========================================================================== */
/* The request                                                                  */
/* ========================================================================== */

/** One image as the model receives it. Base64, never a URL. */
export type GeminiImagePart = {
  readonly mimeType: string;
  readonly base64: string;
};

export type GeminiCall = {
  readonly systemInstruction: string;
  readonly userText: string;
  readonly images: readonly GeminiImagePart[];
  /** The repair call sends a different system turn. Omitted means the normal one. */
  readonly repairIssuePaths?: readonly string[];
};

/** What one call produced. Never a raw SDK object. */
export type GeminiCallResult = {
  /** The raw JSON text. NOT parsed here — parsing is `index.ts`'s job. */
  readonly text: string;
  readonly finishReason: string | null;
  /**
   * `true` when a safety filter stopped generation.
   *
   * Distinguished from "empty text" because the handling is different and
   * documented separately (docs/09 §6.2): a blocked report is not a parse
   * failure, it is a citizen describing something frightening enough to trip a
   * filter, who gets `urgency: 'high'` and a human rather than a silent retry.
   */
  readonly blocked: boolean;
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
};

/* ========================================================================== */
/* Injected collaborators — the reason the retry policy is testable            */
/* ========================================================================== */

/**
 * The one seam a test replaces.
 *
 * Not a mocking framework and not a `vi.mock` (docs/32 MUST 7: mocks live in
 * `tests/`, keyed by a seam the code already has). The seam is this function
 * type, and a test supplies a closure that returns a scripted outcome — so the
 * retry loop, the backoff schedule, and the 429-versus-400 decision are the REAL
 * code under test rather than a re-implementation of it.
 */
export type GeminiTransport = (attempt: {
  readonly attemptNumber: number;
  readonly model: string;
  readonly systemInstruction: string;
  readonly userText: string;
  readonly images: readonly GeminiImagePart[];
  readonly responseSchema: JsonSchemaNode;
  readonly temperature: number;
  readonly timeoutMs: number;
}) => Promise<GeminiCallResult>;

/* ========================================================================== */
/* The client                                                                   */
/* ========================================================================== */

const CACHE_KEY = '__caregrid_gemini_client_v1__';

type GlobalWithClient = typeof globalThis & { [CACHE_KEY]?: GoogleGenAI };

/**
 * The SDK client, constructed on FIRST USE and memoised on `globalThis`.
 *
 * Three reasons for the `globalThis` cache rather than a module variable, the
 * same three as the Admin SDK in `lib/firebase/admin.ts` (docs/06 §1.2): a Vercel
 * instance is reused across requests so a module variable would be re-initialised
 * on every dev-server reload, and a client built at import time would make
 * importing this module throw when no key is configured — which would take down
 * `/api/health`, the one endpoint that must work in an unconfigured deployment.
 */
function client(): GoogleGenAI {
  const cache = globalThis as GlobalWithClient;
  const existing = cache[CACHE_KEY];
  if (existing) return existing;

  const { apiKey } = geminiConfig();
  if (apiKey === null || apiKey.length === 0) {
    // Cannot happen through `getTriageProvider()`, which checks
    // `isAvailable()` first. It exists so a future direct caller gets a typed
    // error instead of an SDK constructor failure with a message that might
    // contain the (absent) key.
    throw new AppError({ code: 'AI_UNAVAILABLE', message: 'AI triage is not configured.' });
  }

  // `apiKey` is passed positionally into the SDK and never stored, logged, or
  // attached to an error. `createLogger`'s allow-list is the second layer; the
  // first is that this line is the only place the value is ever read.
  const created = new GoogleGenAI({ apiKey });
  cache[CACHE_KEY] = created;
  return created;
}

/** Drop the memoised client. Test seam, and the only way to pick up a new key. */
export function resetGeminiClientForTests(): void {
  delete (globalThis as GlobalWithClient)[CACHE_KEY];
}

/* ========================================================================== */
/* The real transport                                                           */
/* ========================================================================== */

/**
 * The default transport: one `models.generateContent` call, no retry logic.
 *
 * Everything that can be retried lives in `callGemini` above this, so a test that
 * supplies its own transport exercises the retry policy and this function is the
 * only part that needs a key.
 */
const realTransport: GeminiTransport = async (attempt) => {
  const ai = client();

  const contents = [
    {
      role: 'user' as const,
      parts: [
        { text: attempt.userText },
        // One `Part` per image, inline. doc 09 §4.2: "No Files API, no GCS URI
        // uploads. Inline base64 keeps the request auditable and avoids a second
        // service."
        ...attempt.images.map((image) => ({
          inlineData: { mimeType: image.mimeType, data: image.base64 },
        })),
      ],
    },
  ];

  const response = await ai.models.generateContent({
    model: attempt.model,
    contents,
    config: {
      systemInstruction: attempt.systemInstruction,
      temperature: attempt.temperature,
      topP: GENERATION_CONFIG.topP,
      topK: GENERATION_CONFIG.topK,
      maxOutputTokens: GENERATION_CONFIG.maxOutputTokens,
      responseMimeType: GENERATION_CONFIG.responseMimeType,
      // The SAME schema object the Zod validator was derived alongside, so the
      // shape the model is told and the shape it is checked against cannot drift.
      responseSchema: attempt.responseSchema as never,
      safetySettings: GENERATION_CONFIG.safetySettings as never,
      // The deadline, enforced by the platform rather than by a Promise.race in
      // our code. A race would leave the request running and the socket open
      // after the route has already answered.
      abortSignal: AbortSignal.timeout(attempt.timeoutMs),
    },
  });

  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason ?? null;

  return {
    text: response.text ?? '',
    finishReason,
    // Three independent signals, because none is sufficient alone. A blocked
    // response may have partial text, no candidates, or a `SAFETY` finish
    // reason, and treating any of those as "blocked" is how a filter stop turns
    // into a retry storm.
    blocked:
      finishReason === 'SAFETY' ||
      finishReason === 'PROHIBITED_CONTENT' ||
      finishReason === 'BLOCKLIST' ||
      finishReason === 'SPII' ||
      (candidate?.safetyRatings ?? []).some((rating) => rating.blocked === true),
    promptTokens: response.usageMetadata?.promptTokenCount ?? null,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
  };
};

/* ========================================================================== */
/* Error classification                                                         */
/* ========================================================================== */

/**
 * The HTTP status an SDK error carries, or `null`.
 *
 * The SDK's error types are not a stable public contract across majors, so this
 * reads the status from three plausible places rather than `instanceof`-ing a
 * class that might not exist. Getting `null` here is safe: it means "do not
 * retry", and every non-retryable path ends in the same honest fallback.
 */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const candidate of [record.status, record.code, record.response?.status]) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate < 600) return candidate;
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return null;
}

/**
 * Is this worth retrying? docs/09 §2.1: retries for `429` and `503` ONLY.
 *
 * The asymmetry is the point. A `429` or `503` is transient and the same request
 * will likely succeed shortly. A `400` means the request itself is wrong, so
 * retrying it three times with backoff just delays the same failure by 7 seconds
 * and spends quota — and a `400` during a live demo is the difference between
 * "AI unavailable, report filed" and "the demo hangs".
 *
 * `AI_QUOTA` is deliberately NOT retried: it is a project-level daily allowance
 * (docs/09 §12), and no amount of waiting inside a 20-second request budget will
 * change that.
 */
export function isRetryableStatus(status: number | null): boolean {
  return status === 429 || status === 503;
}

/** Backoff schedule, docs/09 §2.1: 1s, 2s, 4s. */
export const RETRY_BACKOFF_MS = [1000, 2000, 4000] as const;

/* ========================================================================== */
/* The local quota guard                                                        */
/* ========================================================================== */

/**
 * An in-process RPM/RPD counter.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * This is the "local guard so we never exhaust the project quota" from docs/09
 * §2.1 and `AI_ENABLE_LOCAL_QUOTA_GUARD` in §12. It exists so a demo does not
 * exhaust the free tier in the first minute, and so a bug that loops cannot spend
 * the day's allowance.
 *
 * **It is NOT the abuse control.** Per-user rate limiting is `lib/server/rate-limit.ts`,
 * backed by Firestore, keyed on the authenticated subject, and it is the control
 * that actually stops someone using this endpoint as a free AI proxy (brief §20).
 * This counter is per-instance, resets on deploy, and is bypassed by hitting two
 * instances — which is precisely why `scripts/security-check.cjs` fails the build
 * if the *rate limiter* is ever pinned to memory, and why this one is allowed to
 * be.
 *
 * Conflating the two is the failure this comment exists to prevent: an engineer
 * sees "in-memory rate limiting" and either deletes the Firestore bucket or
 * believes this is protecting the quota. It is not.
 */
const quota = { minute: { count: 0, at: 0 }, day: { count: 0, at: 0 } };

/** `true` when a call may proceed. Consumes one unit of each allowance. */
export function consumeLocalQuota(nowMs: number, rpmLimit: number, rpdLimit: number): { allowed: boolean; reason: 'rpm' | 'rpd' | null } {
  // A zero limit means "unlimited", which is how an operator disables the guard
  // without a separate boolean. `tunableNumber` already clamps it to >= 0.
  if (rpmLimit === 0 && rpdLimit === 0) return { allowed: true, reason: null };

  if (quota.minute.at + 60_000 <= nowMs) quota.minute = { count: 0, at: nowMs };
  if (quota.day.at + 86_400_000 <= nowMs) quota.day = { count: 0, at: nowMs };

  if (rpmLimit > 0 && quota.minute.count >= rpmLimit) return { allowed: false, reason: 'rpm' };
  if (rpdLimit > 0 && quota.day.count >= rpdLimit) return { allowed: false, reason: 'rpd' };

  quota.minute.count += 1;
  quota.day.count += 1;
  return { allowed: true, reason: null };
}

/** Test seam. Also what a manual quota reset uses. */
export function resetLocalQuotaForTests(): void {
  quota.minute = { count: 0, at: 0 };
  quota.day = { count: 0, at: 0 };
}

/* ========================================================================== */
/* The public call                                                              */
/* ========================================================================== */

/** Injected so tests never actually wait 7 seconds to observe a backoff. */
export type CallOptions = {
  readonly timeoutMs: number;
  readonly transport?: GeminiTransport;
  /** Called instead of a real sleep between retries. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Injected so the quota guard is testable without a clock. */
  readonly nowMs?: number;
};

const realWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Make one triage call, with the documented retry policy, and translate every
 * failure into an `AppError`.
 *
 * Throws only `AppError` — never a raw SDK error. docs/09 §3 and docs/34 §1.3:
 * a raw SDK error may carry the API key, a provider request id, and an internal
 * message, and it reaches the response envelope if nothing translates it.
 *
 * The caller (`getTriageProvider`'s `triage()`) catches it, and
 * `triageIncident()` catches that, so this function is allowed to be strict
 * about failure and the guarantee that a report is never lost lives one layer up
 * where it belongs.
 */
export async function callGemini(call: GeminiCall, options: CallOptions): Promise<GeminiCallResult> {
  const config = geminiConfig();
  const transport = options.transport ?? realTransport;
  const wait = options.wait ?? realWait;
  const now = options.nowMs ?? Date.now();

  /* --- the local quota guard, before any network call ------------------- */
  const allowance = consumeLocalQuota(now, config.rpmLimit, config.rpdLimit);
  if (!allowance.allowed) {
    // No API call is made at all, so this costs nothing and cannot fail. The
    // route's own per-user rate limit is the control a citizen experiences; this
    // is the one that protects the project quota during a demo.
    throw new AppError({
      code: 'AI_QUOTA',
      message:
        allowance.reason === 'rpm'
          ? 'AI triage is temporarily paused for this deployment. Your report is still recorded and a person will review it.'
          : 'AI triage has reached its daily limit for this deployment. Your report is still recorded and a person will review it.',
    });
  }

  const isRepair = call.repairIssuePaths !== undefined;
  const systemInstruction = call.systemInstruction;

  let lastError: unknown = null;
  const attempts = config.maxRetries + 1;

  for (let attemptNumber = 0; attemptNumber < attempts; attemptNumber += 1) {
    try {
      return await transport({
        attemptNumber,
        model: config.model,
        systemInstruction,
        userText: call.userText,
        images: call.images,
        responseSchema: AI_RESPONSE_JSON_SCHEMA,
        // The repair call runs at 0 so the retry is a constrained re-sample
        // rather than a fresh roll of the dice (docs/09 §8).
        temperature: isRepair ? REPAIR_TEMPERATURE : GENERATION_CONFIG.temperature,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      lastError = error;

      // An abort is the deadline, not a provider fault. Retrying after our own
      // timeout would exceed the route's budget and produce a 504 anyway, so it
      // is translated and rethrown immediately.
      if (isAbortError(error)) {
        throw new AppError({
          code: 'TIMEOUT',
          message: 'AI triage did not respond in time. The report is still recorded.',
          cause: error,
        });
      }

      const status = statusOf(error);
      const isLast = attemptNumber === attempts - 1;
      if (!isRetryableStatus(status) || isLast) break;

      const backoff = RETRY_BACKOFF_MS[Math.min(attemptNumber, RETRY_BACKOFF_MS.length - 1)] as number;
      await wait(backoff);
    }
  }

  /* --- translate the final failure ------------------------------------- */
  const status = statusOf(lastError);
  if (status === 429) {
    throw new AppError({
      code: 'AI_QUOTA',
      message: 'AI triage is rate limited upstream. The report is still recorded and a person will review it.',
      cause: lastError,
    });
  }
  throw new AppError({
    code: 'AI_UNAVAILABLE',
    message: 'AI triage is temporarily unavailable. The report is still recorded and a person will review it.',
    cause: lastError,
  });
}

/** `true` for both the DOM and the Node `AbortError` shapes. */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { name?: unknown; code?: unknown };
  return record.name === 'AbortError' || record.code === 'ABORT_ERR' || record.code === 23;
}

/**
 * A SHA-256 of the raw model output, for `aiRuns`.
 *
 * The HASH and never the output itself. docs/09 §9: "No raw model output in the
 * log — only `rawOutputHash` (SHA-256). The validated, normalised fields already
 * live on the incident." A triage response can quote a description of an injured
 * person, and `aiRuns` is a long-retention collection.
 */
export function hashRawOutput(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

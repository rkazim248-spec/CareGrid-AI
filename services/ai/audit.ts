/**
 * ============================================================================
 * CareGrid AI — the `aiRuns` audit writer
 * ============================================================================
 *
 * docs/07 §11.4, docs/09 §9. One document per model attempt, success or failure.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT WRITTEN, AND WHY EACH ONE MATTERS
 * ---------------------------------------------------------------------------
 * docs/09 §9 is a table of guarantees and three of them are about ABSENCE. This
 * file is where they are implemented, so the reasons belong here rather than only
 * in the document:
 *
 * | Not written | Because |
 * | --- | --- |
 * | the raw model output | A triage response can quote a description of an injured person, in the reporter's words. `aiRuns` is long-retention. Only `rawOutputHash` is kept — a SHA-256, which lets an operator confirm two runs matched without storing either. |
 * | the prompt text | The prompt is a version string (`triage-v3`) and the template is in the repository. Storing it would duplicate it into a collection with a different access policy. |
 * | the sanitised report text | It is already on `incidents/{id}/reports`. Storing a second, PII-redacted copy would be a second copy to redact correctly and a second one to leak. |
 * | the image bytes and any URL | Only `mediaCount`, byte lengths, and SHA-256s. A Storage path in this collection is a resolvable handle to a citizen's photograph. |
 * | the API key | It is never in this process's scope. `createLogger`'s allow-list is the second layer; the first is that `geminiConfig()` is the only reader and this file stores only what it returns, which is `model` and the tunables. |
 *
 * ---------------------------------------------------------------------------
 * THIS WRITE CANNOT FAIL THE REPORT
 * ---------------------------------------------------------------------------
 * `triageIncident()` must not throw (FR-029), and that includes this call. An
 * audit write that failed loudly would take down a report that had already been
 * triaged successfully. So every failure here is swallowed after being logged —
 * and the swallow is bounded and visible rather than a bare `catch {}`: a write
 * that is failing every time is an operational problem an operator must be able
 * to see, so it is a `warn` with a code, not a `debug`.
 */

import 'server-only';

import { adminConfigurationReason, getAdminDb } from '@/lib/server/firebase-admin';
import { COLLECTIONS } from '@/config/collections';
import { createLogger } from '@/lib/server/http';
import type { GeminiTriageResult } from '@/services/integrations/gemini';

/**
 * What a run is attributed to.
 *
 * `uid` is written so an operator can answer "who triggered this", and it is
 * written because `aiRuns` is a `dispatcher`/`admin`-read collection
 * (docs/09 §9) — not so the report can be linked to a person, which the incident
 * already does.
 */
export type AiRunContext = {
  readonly incidentId: string | null;
  readonly uid: string | null;
  readonly requestId: string;
  /** The reporter's language, for the language mix metric. */
  readonly language: string;
  /** A DISTRICT label at most, and only when the device had coordinates. */
  readonly coarseArea: string | null;
  readonly hasCoordinates: boolean;
};

/** The outcome vocabulary. docs/09 §7.1. */
export const AI_OUTCOMES = [
  'success',
  'fallback',
  'timeout',
  'error',
  'blocked',
  'validation_failed',
] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

/** The document shape. `outcome` is the field the health endpoint aggregates. */
export type AiRunDocument = {
  readonly incidentId: string | null;
  readonly uid: string | null;
  readonly requestId: string;
  readonly outcome: AiOutcome;
  /** 1 = first answer, 2 = the repair. docs/09 §8. */
  readonly attempt: 1 | 2;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  /** SHA-256 of the raw output. NEVER the output. */
  readonly rawOutputHash: string | null;
  readonly confidence: number | null;
  readonly category: string | null;
  readonly urgency: string | null;
  readonly suspicionScore: number;
  readonly suspicionHits: readonly string[];
  readonly floodGuardApplied: boolean;
  readonly piiRedacted: boolean;
  readonly hallucinationFiltered: boolean;
  /** Names of images that exceeded the inline budget and were not sent. */
  readonly mediaDropped: readonly string[];
  readonly mediaCount: number;
  readonly language: string;
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
  readonly blocked: boolean;
  readonly createdAtIso: string;
};

/**
 * Assemble the document WITHOUT writing it.
 *
 * Split from the write so the shape is unit-testable with no Firestore, and so
 * the field list is reviewable in one place rather than spread through a `set()`
 * call. The security check asserts that no `aiRuns` field name in this list can
 * hold a report's text.
 */
export function buildAiRunDocument(
  result: GeminiTriageResult,
  context: AiRunContext,
  outcome: AiOutcome,
  createdAtIso: string,
): AiRunDocument {
  return {
    incidentId: context.incidentId,
    uid: context.uid,
    requestId: context.requestId,
    outcome,
    attempt: result.attempt,
    provider: 'gemini',
    model: result.model,
    promptVersion: result.promptVersion,
    rawOutputHash: result.rawOutputHash,
    confidence: result.confidence,
    category: result.category,
    urgency: result.urgency,
    suspicionScore: result.suspicionScore,
    suspicionHits: [...result.suspicionHits],
    floodGuardApplied: result.floodGuardApplied,
    piiRedacted: result.piiRedacted,
    hallucinationFiltered: result.hallucinationFiltered,
    mediaDropped: [...result.mediaDropped],
    mediaCount: result.mediaCount ?? 0,
    language: context.language,
    promptTokens: result.promptTokens,
    outputTokens: result.outputTokens,
    blocked: result.blocked,
    createdAtIso,
  };
}

/**
 * The document for a run where no model was reached at all.
 *
 * `outcome` is a PARAMETER, not a message. An earlier draft took a free-text
 * `reason`, which was wrong twice over: it needed somewhere to put a provider
 * message or a stack trace (docs/09 §9 forbids model output in this collection,
 * and a stack trace is worse), and it made every call site invent prose for a
 * field nothing reads.
 *
 * The distinction an operator actually needs is between "AI was switched off"
 * (`fallback`) and "Gemini did not answer" (`error`/`timeout`), and that is
 * exactly what the `outcome` vocabulary expresses. The prose lives in the
 * application log at the point it is known, where the allow-list redacts it.
 */
export function buildFallbackRunDocument(
  context: AiRunContext,
  /**
   * Every outcome EXCEPT `success` — which is the only one that is not a reason
   * the keyword engine had to produce the record. Excluding it here means a
   * keyword triage can never be logged as a model call, which is the specific
   * misreport that would make the health endpoint's success rate a lie.
   */
  outcome: Exclude<AiOutcome, 'success'>,
  createdAtIso: string,
): AiRunDocument {
  return {
    incidentId: context.incidentId,
    uid: context.uid,
    requestId: context.requestId,
    outcome,
    attempt: 1,
    provider: 'none',
    model: 'none',
    promptVersion: 'none',
    rawOutputHash: null,
    confidence: null,
    category: null,
    urgency: null,
    suspicionScore: 0,
    suspicionHits: [],
    floodGuardApplied: false,
    piiRedacted: false,
    hallucinationFiltered: false,
    mediaDropped: [],
    mediaCount: 0,
    language: context.language,
    promptTokens: null,
    outputTokens: null,
    blocked: false,
    createdAtIso,
  };
}

/**
 * Write one `aiRuns` document. Never throws.
 *
 * Returns the run id on success, or `null` when nothing was written — which is
 * the normal case in an unconfigured deployment, and is not an error. The caller
 * records `null` on `incidents.aiRunId` and the incident is unaffected.
 *
 * `merge: false` and no `update`: `aiRuns` is an append-only log of what the model
 * did. An update would let a later write rewrite the record of an earlier
 * decision, which is the one thing an audit trail must not permit (docs/07 §11.5).
 */
export async function logAiRun(document: AiRunDocument): Promise<string | null> {
  // `adminConfigurationReason()` rather than a boolean helper: it is the same
  // function the Admin SDK bootstrap uses to decide whether to throw, so "the
  // audit is skipped" and "the Admin SDK is unusable" cannot disagree.
  if (adminConfigurationReason() !== null) return null;

  try {
    const db = getAdminDb();
    // A server-generated id: the client never chooses one, and a client-chosen id
    // is how a caller overwrites another run's audit entry.
    const reference = db.collection(COLLECTIONS.aiRuns).doc();
    await reference.set({ ...document }, { merge: false });
    return reference.id;
  } catch (error) {
    // A `warn`, not a `debug`: a write failing on every request is an operational
    // problem, and the whole point of not throwing here is that the report is
    // already safe. Swallowing it silently would make it invisible.
    createLogger(document.requestId).warn({
      code: 'AI_UNAVAILABLE',
      path: 'services.ai.audit',
      status: 502,
      // The constructor name only. A Firestore error message can contain the
      // document path and, in some configurations, the collection name — not the
      // report, but there is no reason to put it in a log line.
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

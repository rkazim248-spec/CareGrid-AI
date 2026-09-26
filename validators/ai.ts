/**
 * ============================================================================
 * CareGrid AI — AI request and response schemas
 * ============================================================================
 *
 * The Phase 3 boundary for `POST /api/ai/triage`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCHEMA IS FOR
 * ---------------------------------------------------------------------------
 * It is NOT the Phase 4 incident-triage schema. The create pipeline's triage
 * input is a `CreateIncidentBody` validated by `validators/incident.ts`, and
 * Phase 4 adds that file. What is here is the ARCHITECTURE PROBE: a small,
 * strictly-validated body that exercises the whole pipeline — authentication,
 * the capability gate, rate limiting, validation, the service, the provider
 * boundary, and a graceful failure — without implementing a model call.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROBE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Because "the AI integration fails gracefully" is a claim, and an untested
 * claim is a hope. This route makes the claim executable: a caller with a valid
 * body reaches `services/ai/triage.ts`, which reaches a `TriageProvider` that
 * has no key, and the answer is `502 AI_UNAVAILABLE` with copy that says the
 * report is still fine. That is the FR-029 guarantee, demonstrated on a route
 * that does not need a report.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE BODY MAY NOT CONTAIN, AND WHY EACH IS A RULE
 * ---------------------------------------------------------------------------
 * | Field | Rule |
 * |-------|------|
 * | `text` | 20-2000 chars. FR-003's own bounds, so a probe cannot smuggle a 10 MB string past a smaller limit. |
 * | `language` | BCP-47 shaped, max 35. The REQUEST's language, never the browser's guess. |
 * | `locationHint` | Prose, max 200. NEVER coordinates. The model has no coordinate output field at all (docs/09 §1.2). |
 * | `imageCount`/`audioCount` | COUNTS, 0-3 and 0-1. Bytes never leave the server and no URL is resolvable. |
 * | `newAccount` | Advisory only, and it comes from the SERVER's account age, never from the body. |
 *
 * `role`, `uid`, `email`, and any `provider`/`model` override are absent, and
 * `.strict()` rejects them. A client cannot ask for a different model, a
 * different prompt version, or a different urgency.
 */

import { z } from 'zod';

import { strictObject, trimmedString } from '@/validators/common';

/**
 * The probe body.
 *
 * `.strict()` for the same reason every request schema is: an unknown key is
 * rejected, so `role: 'admin'` or `promptVersion: 'triage-v1'` is a 400 rather
 * than a field a future refactor might start reading (docs/17 §1.2).
 */
export const aiTriageProbeBodySchema = strictObject({
  /**
   * The citizen's own words. 20 characters is FR-003's floor: below that it is
   * not a report, and the same bound on this route means a probe and a real
   * create are rejected by the same rule.
   */
  text: trimmedString(20, 2000),

  /**
   * BCP-47, e.g. `en`, `hi`, `en-IN`. Bounded, not enumerated: a 400 on an
   * unlisted language would be worse than passing it to the model, which is
   * documented to handle a language it does not know.
   */
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language tag such as en or hi.')
    .max(35)
    .default('en'),

  /**
   * A place the reporter DESCRIBED, in their words.
   *
   * There is deliberately no `lat`/`lng` field. docs/09 §1.2 forbids the model
   * from producing a coordinate, and MUST NOT 7 forbids presenting any location
   * without an accuracy grade. A schema that accepted a raw coordinate here
   * would be an invitation to send precise location to a third party for no
   * benefit — the dispatcher resolves the text to a point later, server-side.
   */
  locationHint: z
    .string()
    .trim()
    .max(200, 'Keep the location description under 200 characters.')
    .optional(),

  /** How many images are ATTACHED. Never a URL, never a byte count. */
  imageCount: z.coerce.number().int().min(0).max(3).default(0),

  /** How many audio clips are ATTACHED. FR-006 caps this at one. */
  audioCount: z.coerce.number().int().min(0).max(1).default(0),
});

export type AiTriageProbeBody = z.infer<typeof aiTriageProbeBodySchema>;

/**
 * The response.
 *
 * `triage` is ALWAYS present and `source` is ALWAYS one of the three documented
 * values, because the fallback is a real outcome and a client must be able to
 * branch on it. `needsReview` is what the UI renders, and it is `true` for every
 * fallback (FR-024).
 */
export const aiTriageProbeResponseSchema = z.object({
  triage: z.object({
    source: z.enum(['ai', 'fallback', 'manual']),
    category: z.string().nullable(),
    urgency: z.string().nullable(),
    summary: z.string().nullable(),
    safetyFlags: z.array(z.string()),
    confidence: z.number().nullable(),
    rationale: z.string().nullable(),
    needsReview: z.boolean(),
    providerName: z.string(),
    model: z.string(),
    promptVersion: z.string(),
  }),
  /**
   * `true` when the AI provider is configured and reachable. Exposed so a
   * client can render "AI assistance is not configured in this deployment"
   * rather than a generic failure, and so a developer can confirm the wiring
   * without reading a server log.
   */
  providerAvailable: z.boolean(),
});

export type AiTriageProbeResponse = z.infer<typeof aiTriageProbeResponseSchema>;

/**
 * The sanitisation boundary's own bounds, restated as a schema.
 *
 * `TRIAGE_LIMITS` in `services/ai/triage.ts` is the authority at runtime; this
 * is the same numbers as a testable object so a change to one is a change to
 * both. docs/09 §4 requires the boundary to be explicit, and an explicit
 * boundary that exists only as a constant is one refactor away from being
 * removed.
 */
export const aiSanitisationBounds = {
  textMaxChars: 2000,
  locationHintMaxChars: 200,
  maxImages: 3,
  maxAudioClips: 1,
} as const;

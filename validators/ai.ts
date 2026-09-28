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

  /**
   * One image, inline, as base64.
   *
   * ---------------------------------------------------------------------------
   * PHASE 4 ADDED THIS, AND IT IS THE ONE FIELD THAT CARRIES BYTES
   * ---------------------------------------------------------------------------
   * The `imageCount` above is a number: safe to log, safe to rate-limit on, safe
   * to render. This field is not any of those things, which is why it is bounded
   * three ways and why the bounds live in a schema rather than in prose.
   *
   * | Bound | Value | Why |
   * | --- | --- | --- |
   * | `max` on the array | 3 | FR-005, and `AI_MAX_IMAGES`. |
   * | each string | 7 MB | Base64 of a 5 MB file, the per-image ceiling in `media.ts`. 7 MB covers 5 MB × 1.37 plus slack, so a legal file is never rejected for its encoding. |
   * | whole request | `ABSOLUTE_MAX_BODY_BYTES` | `lib/server/validate.ts` rejects the request before this runs. |
   *
   * The **content** is not validated here. A schema cannot check a byte signature
   * without base64-decoding the string, and doing that inside a request validator
   * would make the common path pay for the uncommon one. `validateImage` does it,
   * immediately after this, and the route cannot proceed without it — so the
   * ordering in the handler is the control, and this schema's job is only to stop
   * an oversized or over-numerous payload reaching the provider.
   *
   * The `mimeType` and `fileName` here are **claims**, checked against the file's
   * own signature in `media.ts` and never trusted. They are accepted so the error
   * message can say what the client THOUGHT it was sending, which is the single
   * most useful thing in a "your file is not a JPEG" error.
   */
  images: z
    .array(
      z
        .object({
          /** A CLAIM. Verified against the bytes. */
          mimeType: z.string().trim().max(120).optional(),
          /** The client's filename. A CLAIM, and stripped of any path. */
          fileName: z.string().trim().max(200).optional(),
          /**
           * A bare base64 string OR a `data:` URL, because a browser `FileReader`
           * produces the latter and requiring a client to strip the prefix before
           * sending is a step someone will forget.
           *
           * The character class excludes whitespace deliberately: a pasted base64
           * blob with newlines is not the same input as one without, and silently
           * accepting it would make the decoded length differ from the length this
           * schema approved.
           */
          data: z
            .string()
            .min(1)
            .max(7 * 1024 * 1024)
            .regex(/^(data:image\/[a-z0-9.+-]+;base64,)?[A-Za-z0-9+/]+={0,2}$/i, 'Send raw base64 or a data URL.'),
        })
        // `.strict()` so a client cannot smuggle a `storagePath` or a `url` field
        // in alongside the bytes. Anything a server adds later is added to the
        // schema, not accepted by accident.
        .strict(),
    )
    .max(3)
    .optional()
    .default([]),
});

/**
 * A single validated image, from `services/ai/media.ts`.
 *
 * Exported as a type so the route and the service agree on the shape without the
 * validator importing the media module — `validators/**` is shared with the client
 * and `media.ts` imports `node:crypto`.
 */
export type TriagedImage = {
  readonly mimeType: string;
  readonly base64: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly fileName: string;
};

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
    /**
     * docs/09 §7.1. What actually happened, which is NOT the same as `source`:
     * a `fallback` source can be an unconfigured deployment, a timeout, a quota
     * stop, a schema failure, or a safety block, and those have different
     * implications for a user and for an operator.
     *
     * Exposed because a client that renders "AI is unavailable" for all five is
     * telling a user something that is not true in four of them.
     */
    outcome: z.enum([
      'success',
      'fallback',
      'timeout',
      'error',
      'blocked',
      'validation_failed',
    ]),
    /**
     * How the model arrived at this record.
     *
     * `promptVersion` and `model` were already here; `attempt` is new and is the
     * difference between "the model answered" and "the model answered wrong once
     * and was asked again" (docs/09 §8). A record produced by the repair call is
     * worth knowing about, because repair rate is the leading indicator of
     * schema drift.
     */
    attempt: z.number().int().min(1).max(2).nullable(),
    /**
     * `true` when the AI's own confidence is below the review threshold.
     *
     * Redundant with `needsReview` today, and kept for one reason: a client
     * rendering a confidence meter needs to distinguish "needs review because the
     * model was unsure" from "needs review because the AI was unavailable", and
     * `confidence: null` is the only way to tell them apart.
     */
    lowConfidence: z.boolean(),
  }),
  /**
   * `true` when the AI provider is configured and reachable. Exposed so a
   * client can render "AI assistance is not configured in this deployment"
   * rather than a generic failure, and so a developer can confirm the wiring
   * without reading a server log.
   */
  providerAvailable: z.boolean(),
  /**
   * `true` when the answer came from the development mock rather than Gemini.
   *
   * Phase 4, brief §26. This is the field that makes a mock HONEST rather than
   * merely isolated: a demo built with `AI_MOCK_MODE` on says so on screen, so a
   * canned response can never be mistaken for an assessment. It is `true` ONLY
   * when the mock actually produced the result, and it is not the same as
   * `providerAvailable` — a deployment with a real key can never report it.
   */
  simulated: z.boolean(),
  /**
   * Images the model did NOT see, and how many it did.
   *
   * docs/09 §4.2: "Dropping is logged, never silent." A caller that attached three
   * photos and is told the model saw one can decide whether to resubmit; a caller
   * that is told nothing believes the model saw three.
   */
  mediaCount: z.number().int().min(0),
  mediaDropped: z.array(z.string()),
  /**
   * The `aiRuns` document id, or `null`.
   *
   * Present so a dispatcher can trace a record to its audit entry. `null` in an
   * unconfigured deployment, which is not an error.
   */
  aiRunId: z.string().nullable(),
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

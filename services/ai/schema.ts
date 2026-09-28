/**
 * ============================================================================
 * CareGrid AI — the AI output contract
 * ============================================================================
 *
 * docs/09 §5.1. The declaration of what Gemini is allowed to return.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS PURE AND HAS NO `server-only` GUARD
 * ---------------------------------------------------------------------------
 * Imported by three kinds of caller: the server adapter, the unit tests, and
 * `validators/ai.ts` (which doc 09 §3 requires to re-export it so the client and
 * the server share ONE definition). A `server-only` guard would break the tests
 * and the shared validator.
 *
 * Its protection is therefore **pureness** — no `process.env`, no SDK, no
 * `fetch`, no secret, so there is nothing to leak. `scripts/security-check.cjs`
 * asserts all three conditions mechanically, the way it does for
 * `lib/integrations/contracts.ts` (docs/30.4 §6 D-6): adding the guard breaks the
 * tests, and adding an import breaks the check.
 *
 * ---------------------------------------------------------------------------
 * THE TWO SCHEMAS, AND AN HONEST ACCOUNT OF WHY THEY ARE NOT DERIVED
 * ---------------------------------------------------------------------------
 * Gemini is given a `responseSchema` so it cannot invent a shape, and the answer
 * is then validated with Zod. docs/09 §6.2 says the JSON Schema is "exported from
 * schema.ts, NOT hand-written twice" — a real instruction, because two
 * independent copies drift, and the drift is silent and total:
 *
 *     JSON Schema says `summary` is optional, Zod requires it.
 *     The model obeys the JSON Schema. Every response omits `summary`.
 *     Every response fails validation → repair fails identically → 100% fallback.
 *
 * That failure looks exactly like a provider outage, which is why it is worth
 * designing against rather than documenting against.
 *
 * **The derivation was attempted and rejected.** Zod 4 exposes constraints as
 * opaque class instances (`z.string().max(5).def.checks` serialises to `{}`), so a
 * Zod→JSON-Schema converter has to read `_zod.def` internals that carry no
 * compatibility promise between 4.x minors. A converter that silently reads
 * nothing returns an unconstrained schema — which is the *same* silent failure as
 * drift, reached by a more respectable route. Depending on an internal to
 * satisfy a "do not duplicate" instruction trades a loud duplication for a quiet
 * one.
 *
 * So the duplication is real, and it is contained by construction:
 *
 *  - Every CLOSED VOCABULARY is one imported constant (`INCIDENT_CATEGORIES`,
 *    `URGENCIES`, `SAFETY_FLAGS`, `AI_HAZARDS`, `AI_UNKNOWN_FIELDS`,
 *    `RESOURCE_IDS`). Both schemas reference it; neither repeats it.
 *  - Every FIELD NAME list is `AI_TRIAGE_FIELD_NAMES`. Both schemas derive
 *    `required` from it, so a field cannot be required in one and optional in the
 *    other — the highest-consequence half of the drift.
 *  - Every BOUND is written twice, and
 *    `tests/unit/ai/schema.test.ts` asserts the two agree field by field:
 *    same keys, same enum members, same min/max/length, same required list.
 *
 * So the duplication that remains is checked rather than impossible, and the test
 * names the file to fix when it fails.
 *
 * ---------------------------------------------------------------------------
 * WHY `.strict()` IS THE PRIMARY DEFENCE, NOT A STYLISTIC CHOICE
 * ---------------------------------------------------------------------------
 * docs/09 §5.1: "any extra key is a validation failure — this is the primary
 * defence against a manipulated model returning a `dispatch: true` field."
 *
 * Worth restating because it is the single most important line in the AI layer.
 * A model persuaded by an injected instruction to emit
 * `{"urgency":"critical","dispatch":true}` is not stopped by the prompt (the
 * prompt is a request) and not by the caller (the caller reads named fields). It
 * is stopped HERE, because `dispatch` is not a field, so the parsed object has an
 * unexpected key and validation fails. The key cannot reach a `TriageResult`,
 * because a `TriageResult` is built by `normalizeTriageOutput`, which reads named
 * fields and copies nothing.
 */

import { z } from 'zod';

import { RESOURCE_IDS } from '@/config/resources';
import { INCIDENT_CATEGORIES, SAFETY_FLAGS, URGENCIES } from '@/types/enums';

/* ========================================================================== */
/* The closed vocabularies                                                       */
/* ========================================================================== */

/**
 * Hazards the reporter can SEE. docs/09 §5.1. 11 values.
 *
 * Deliberately NOT in `types/enums.ts`. Every union there is a Firestore document
 * field (docs/07 §2); `hazards` is a model-only input that is mapped into
 * `safetyFlags` and then discarded. Putting an AI-only vocabulary in the domain
 * enum file would make it look like a persisted field, and the next reader would
 * add it to a document.
 */
export const AI_HAZARDS = [
  'fire',
  'smoke',
  'gas_leak',
  'live_wire',
  'flood_water',
  'structural_risk',
  'weapon',
  'crowd',
  'child_present',
  'elderly_present',
  'pregnant_person',
] as const;
export type AiHazard = (typeof AI_HAZARDS)[number];

/**
 * What the model deliberately left null. docs/09 §5.1. 6 values.
 *
 * This is what makes "I don't know" a first-class answer rather than a silent
 * omission. R5 turns `confidence < threshold` into a `low_confidence` flag, and
 * `unknown_fields` is what the dispatcher panel renders as "the model did not
 * determine this" — a more useful statement than a number simply being absent,
 * because it distinguishes "not applicable" from "not determined".
 */
export const AI_UNKNOWN_FIELDS = [
  'location',
  'people_affected',
  'specific_injury',
  'exact_address',
  'resources',
  'time_of_incident',
] as const;
export type AiUnknownField = (typeof AI_UNKNOWN_FIELDS)[number];

/* ========================================================================== */
/* The field list — the one thing both schemas derive from                      */
/* ========================================================================== */

/**
 * The 17 field names, in docs/09 §5.1's order.
 *
 * `AI_TRIAGE_FIELD_NAMES` is the ONLY place a field is added. Both schemas build
 * their `required` list from it, and `tests/unit/ai/schema.test.ts` asserts the
 * two schemas' `properties` keys equal it. So the failure mode the header
 * describes — required in one, optional in the other — is not reachable by
 * forgetting a field; it is only reachable by typing one in two places, and the
 * test names both.
 *
 * The order is the document's, and `AI_RESPONSE_JSON_SCHEMA` passes it as
 * `propertyOrdering` so a malformed response can be read against docs/09 §5.1
 * instead of an alphabetical shuffle.
 */
export const AI_TRIAGE_FIELD_NAMES = [
  'category',
  'category_confidence',
  'urgency',
  'urgency_confidence',
  'summary',
  'language',
  'location_hint',
  'landmarks',
  'people_affected',
  'people_affected_stated',
  'required_resources',
  'hazards',
  'safety_flags',
  'audio_transcript',
  'audio_transcript_uncertain',
  'confidence',
  'unknown_fields',
] as const;

export type AiTriageFieldName = (typeof AI_TRIAGE_FIELD_NAMES)[number];

/* ========================================================================== */
/* The bounds — docs/09 §5.1, each with its reason                              */
/* ========================================================================== */

/**
 * Every numeric and length bound, named once, so the two schemas and the tests
 * all read the same number.
 *
 * | Bound | Value | Why that value |
 * | --- | --- | --- |
 * | `summaryMax` | 240 | FR. Shown in a queue row; a paragraph does not fit the product. |
 * | `locationHintMax` | 120 | MUST NOT 7. An approximation, not an address. |
 * | `landmarkMax` | 60, ×5 | Verbatim from input, so a long one is a quote, not a place. |
 * | `peopleAffectedMax` | 100000 | A count a person could plausibly state. |
 * | `resourcesMax` | 6 | The catalogue has 12; 6 is "the ones that matter". |
 * | `flagsMax` | 6 | Past 6 the list is noise, not triage. |
 * | `transcriptMax` | 2000 | Same bound as the report text (FR-003). |
 * | `reasonMax` | 100 | Must CITE the report. Not a paragraph. |
 * | `quantityMax` | 999 | More than this is not a field response. |
 */
export const AI_BOUNDS = {
  summaryMin: 1,
  summaryMax: 240,
  locationHintMax: 120,
  landmarkMax: 60,
  landmarksMax: 5,
  peopleAffectedMax: 100000,
  resourcesMax: 6,
  resourceQuantityMax: 999,
  resourceReasonMax: 100,
  hazardsMax: 6,
  safetyFlagsMax: 6,
  unknownFieldsMax: 6,
  transcriptMax: 2000,
} as const;

/* ========================================================================== */
/* Schema 1 of 2 — Zod, the validation authority                                */
/* ========================================================================== */

/**
 * One recommended resource. docs/09 §5.1.
 *
 * `confidence` is capped again in `rules.ts`, because whether a request was
 * stated or inferred depends on the reporter's text, which this schema cannot see.
 */
const resourceSuggestionSchema = z
  .object({
    resourceId: z.enum(RESOURCE_IDS),
    quantity: z.number().int().min(0).max(AI_BOUNDS.resourceQuantityMax),
    confidence: z.number().min(0).max(1),
    /** Must cite the words in the report that justify it. docs/09 §6. */
    reason: z.string().max(AI_BOUNDS.resourceReasonMax),
  })
  // `.strict()` on the nested object too. A `resourceId` the catalogue does not
  // hold would render as a raw id in the dispatcher panel, because
  // `resourceName()` falls back to the id rather than hiding the row.
  .strict();

/**
 * The validated model output. docs/09 §5.1.
 *
 * **`.strict()` is load-bearing** — see the header. Removing it is not a
 * loosening; it removes the only structural barrier between a manipulated model
 * and a `dispatch: true` field.
 *
 * `urgency` is `z.enum(URGENENCIES)` and has NO `unknown` member. A model that
 * returns `"urgent"`, `"high-ish"`, or `"unknown"` fails validation and is
 * repaired, rather than being mapped to something plausible. "Close enough" is how
 * a triage system starts treating two different urgencies as one; a rejected value
 * is visible, a silently mapped one is not.
 */
export const aiTriageOutputSchema = z
  .object({
    category: z.enum(INCIDENT_CATEGORIES),
    category_confidence: z.number().min(0).max(1),
    urgency: z.enum(URGENCIES),
    urgency_confidence: z.number().min(0).max(1),
    summary: z.string().min(AI_BOUNDS.summaryMin).max(AI_BOUNDS.summaryMax),
    /** ISO-639-1 with an optional region. R10 folds an unsupported tag to `en`. */
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
    /** MUST NOT 7 / docs/09 §1.2. Approximate prose ONLY. Never a coordinate. */
    location_hint: z.string().max(AI_BOUNDS.locationHintMax).nullable(),
    landmarks: z.array(z.string().max(AI_BOUNDS.landmarkMax)).max(AI_BOUNDS.landmarksMax),
    /**
     * The pair is the whole answer to "may the AI invent a casualty count"
     * (docs/09 §1.2, rule 4). The count is trusted only when
     * `people_affected_stated` is `true`, so a model cannot raise a number from a
     * photograph of "some people" and have it recorded as a fact.
     */
    people_affected: z.number().int().min(0).max(AI_BOUNDS.peopleAffectedMax).nullable(),
    people_affected_stated: z.boolean(),
    required_resources: z.array(resourceSuggestionSchema).max(AI_BOUNDS.resourcesMax),
    hazards: z.array(z.enum(AI_HAZARDS)).max(AI_BOUNDS.hazardsMax),
    safety_flags: z.array(z.enum(SAFETY_FLAGS)).max(AI_BOUNDS.safetyFlagsMax),
    audio_transcript: z.string().max(AI_BOUNDS.transcriptMax).nullable(),
    audio_transcript_uncertain: z.boolean(),
    confidence: z.number().min(0).max(1),
    unknown_fields: z.array(z.enum(AI_UNKNOWN_FIELDS)).max(AI_BOUNDS.unknownFieldsMax),
  })
  .strict();

export type AiTriageOutput = z.infer<typeof aiTriageOutputSchema>;

/* ========================================================================== */
/* Schema 2 of 2 — the JSON Schema sent to Gemini                                */
/* ========================================================================== */

/** The OpenAPI-subset shape `@google/genai` accepts for `responseSchema`. */
export type JsonSchemaNode = Readonly<Record<string, unknown>>;

/**
 * The `responseSchema` handed to Gemini. docs/09 §6.2.
 *
 * Three details that are not obvious and are each a real failure mode:
 *
 *  - **`required` lists all 17 fields.** Gemini's structured output fills every
 *    required key, and a field it considers optional is one it may omit. The
 *    list is derived from `AI_TRIAGE_FIELD_NAMES`, not typed again.
 *  - **Nullability is `nullable: true`, not `type: ['string','null']`.** Gemini's
 *    schema dialect uses the OpenAPI form. With the JSON-Schema union form the
 *    model emits the literal STRING `"null"` for a nullable field, which then
 *    fails Zod — a documented structured-output behaviour and the single most
 *    common reason a `responseSchema` integration "works but never validates".
 *  - **The nested resource object requires all four keys.** A partially-filled
 *    resource renders in the dispatcher panel as a request with no justification,
 *    which is worse than no request. If the model cannot produce a `reason`, it
 *    should return an empty `required_resources` array.
 */
export const AI_RESPONSE_JSON_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...INCIDENT_CATEGORIES] },
    category_confidence: { type: 'number', minimum: 0, maximum: 1 },
    urgency: { type: 'string', enum: [...URGENCIES] },
    urgency_confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: {
      type: 'string',
      minLength: AI_BOUNDS.summaryMin,
      maxLength: AI_BOUNDS.summaryMax,
    },
    language: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$' },
    location_hint: { type: 'string', maxLength: AI_BOUNDS.locationHintMax, nullable: true },
    landmarks: {
      type: 'array',
      items: { type: 'string', maxLength: AI_BOUNDS.landmarkMax },
      maxItems: AI_BOUNDS.landmarksMax,
    },
    people_affected: {
      type: 'integer',
      minimum: 0,
      maximum: AI_BOUNDS.peopleAffectedMax,
      nullable: true,
    },
    people_affected_stated: { type: 'boolean' },
    required_resources: {
      type: 'array',
      maxItems: AI_BOUNDS.resourcesMax,
      items: {
        type: 'object',
        properties: {
          resourceId: { type: 'string', enum: [...RESOURCE_IDS] },
          quantity: { type: 'integer', minimum: 0, maximum: AI_BOUNDS.resourceQuantityMax },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string', maxLength: AI_BOUNDS.resourceReasonMax },
        },
        required: ['resourceId', 'quantity', 'confidence', 'reason'],
      },
    },
    hazards: { type: 'array', items: { type: 'string', enum: [...AI_HAZARDS] }, maxItems: AI_BOUNDS.hazardsMax },
    safety_flags: {
      type: 'array',
      items: { type: 'string', enum: [...SAFETY_FLAGS] },
      maxItems: AI_BOUNDS.safetyFlagsMax,
    },
    audio_transcript: { type: 'string', maxLength: AI_BOUNDS.transcriptMax, nullable: true },
    audio_transcript_uncertain: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    unknown_fields: {
      type: 'array',
      items: { type: 'string', enum: [...AI_UNKNOWN_FIELDS] },
      maxItems: AI_BOUNDS.unknownFieldsMax,
    },
  },
  required: [...AI_TRIAGE_FIELD_NAMES],
  propertyOrdering: [...AI_TRIAGE_FIELD_NAMES],
};

/* ========================================================================== */
/* Classification helpers — one place, so rules.ts and the UI cannot disagree     */
/* ========================================================================== */

/**
 * Map an unrecognised category to `other`, keeping the raw value.
 *
 * docs/07 §4.2: a value outside the 11 maps to `other`. The raw value is returned
 * so it can be recorded as `categoryRaw` and read later — a taxonomy that
 * silently swallows a new category never learns it exists, and that learning is
 * how the list gets fixed.
 */
export function classifyCategory(value: unknown): {
  readonly category: (typeof INCIDENT_CATEGORIES)[number];
  readonly categoryRaw: string | null;
} {
  if (typeof value === 'string' && (INCIDENT_CATEGORIES as readonly string[]).includes(value)) {
    return { category: value as (typeof INCIDENT_CATEGORIES)[number], categoryRaw: null };
  }
  return { category: 'other', categoryRaw: typeof value === 'string' ? value.slice(0, 60) : null };
}

/** Is this in the taxonomy? Used by the fallback engine and the tests. */
export function isKnownCategory(value: string): boolean {
  return (INCIDENT_CATEGORIES as readonly string[]).includes(value);
}

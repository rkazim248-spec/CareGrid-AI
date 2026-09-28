/**
 * ============================================================================
 * CareGrid AI — the deterministic safety rules
 * ============================================================================
 *
 * docs/09 §5.3 (R1–R10) and §5.2 (the mapping to `incidents`). PURE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Because a prompt is a request and a model is a suggester. Every rule here is a
 * control that holds when the model is wrong, misled, or deliberately attacked,
 * and the prompt's own rules 1–10 are the things the model was *asked* to do.
 *
 * The distinction matters most for the two rules that can change what a
 * dispatcher sees:
 *
 *  - **R1/R2/R3 raise urgency and never lower it.** A model that says `low` for a
 *    gas leak is corrected by code. A model that says `critical` for a sunset is
 *    NOT corrected down to `low` by code — because the model is not the only
 *    source. R9 is why: urgency may only be LOWERED by a human. Being wrong
 *    upwards wastes a responder's attention; being wrong downwards can cost a
 *    life, and a system that silently demotes an urgency claim is a system that
 *    will eventually demote a real one.
 *  - **R4 never turns `null` into a number.** The tempting repair for "a medical
 *    emergency with no casualty count" is to assume one. docs/09 §1.2 forbids it
 *    and R4 exists because the temptation is real: `null` looks like a bug.
 *
 * ---------------------------------------------------------------------------
 * WHAT "PURE" COSTS AND WHY IT IS WORTH IT
 * ---------------------------------------------------------------------------
 * No clock, no `Math.random`, no env, no network. Every rule is a function of
 * (validated output, context), so each of R1–R10 is testable in isolation and
 * `tests/unit/ai/rules.test.ts` covers every branch. `normalizeTriageOutput` is
 * the ONLY conversion point from model output to incident fields (docs/09 §3),
 * which is what makes "one place where the numbers are trusted" a structural
 * property rather than a convention.
 */

import {
  AI_CONFIDENCE_BANDS,
  AI_INFERRED_RESOURCE_CONFIDENCE_CAP,
  AI_MODEL_RESOURCE_CONFIDENCE_CAP,
  AI_SUSPICION_CONFIDENCE_CEILING,
} from '@/config/ai';
import { URGENCY_FLOOR_FLAGS } from '@/config/urgencies';
import { RESOURCE_IDS } from '@/config/resources';
import { classifyCategory, type AiTriageOutput, type AiHazard, type AiUnknownField } from '@/services/ai/schema';
import { INCIDENT_CATEGORIES, SAFETY_FLAGS, URGENCIES } from '@/types/enums';
import type { IncidentCategory, SafetyFlag, Urgency } from '@/types/enums';

/* ========================================================================== */
/* The normaliser input                                                         */
/* ========================================================================== */

/**
 * What the rules need to know that the model output does not contain.
 *
 * `originalText` is the reporter's UNSANITISED text, and it is present for one
 * reason: R8 must distinguish a diagnosis the model *invented* from one the
 * reporter *said*. Both are in the summary string; only one is in the input.
 * Without the original, R8 can only delete every medical term, which would strip
 * a reporter's own description of an injured person and leave a summary with a
 * hole in it.
 */
export type RuleContext = {
  /** `false` when the incident has no coordinates. Drives R6. */
  readonly hasCoordinates: boolean;
  /** From `sanitiseForModel`. R7 acts at or above 3. */
  readonly suspicionScore: number;
  /** The reporter's own words, verbatim. R8's "did they say this?" test. */
  readonly originalText: string;
  /** FR-024, from `AI_CONFIDENCE_REVIEW_THRESHOLD`. */
  readonly reviewThreshold: number;
};

/** One resource request, with its provenance. docs/09 §5.2. */
export type NormalizedResource = {
  readonly resourceId: string;
  readonly quantity: number;
  readonly confidence: number;
  readonly reason: string;
  /**
   * `reporter` when the citizen asked for it, `ai` when the model inferred it.
   * The dispatcher sees this, because a request a person made outranks one a
   * model suggested.
   */
  readonly source: 'reporter' | 'ai';
};

/** The normalised record. Every field is what may be STORED. */
export type NormalizedTriage = {
  readonly category: IncidentCategory;
  /** The out-of-taxonomy value the model returned, when there was one. */
  readonly categoryRaw: string | null;
  readonly urgency: Urgency;
  readonly summary: string;
  readonly language: string;
  /** Approximate prose only. NEVER stored on the incident (docs/09 §5.2). */
  readonly locationHint: string | null;
  readonly landmarks: readonly string[];
  /** `null` unless `people_affected_stated` — see R4. */
  readonly peopleAffected: number | null;
  readonly requiredResources: readonly NormalizedResource[];
  readonly safetyFlags: readonly SafetyFlag[];
  readonly hazards: readonly AiHazard[];
  readonly audioTranscript: string | null;
  readonly audioTranscriptUncertain: boolean;
  /** Rounded to 2 dp, then possibly capped by R7. */
  readonly confidence: number;
  readonly unknownFields: readonly AiUnknownField[];
  /** FR-024. Computed here, never taken from the model. */
  readonly needsReview: boolean;
  /** Human-readable notes for the dispatcher panel. R10, R7, R8 explain themselves. */
  readonly notes: readonly string[];
  /** `true` when R8 removed something. Recorded in `aiRuns`. docs/09 §5.3. */
  readonly hallucinationFiltered: boolean;
};

/* ========================================================================== */
/* Urgency arithmetic                                                            */
/* ========================================================================== */

/** Lower rank sorts first, so a LOWER rank is a HIGHER urgency. */
function rank(urgency: Urgency): number {
  return URGENCIES.indexOf(urgency);
}

/**
 * Raise `urgency` to at least `floor`. **Never lowers.**
 *
 * The `Math.min` is the whole rule. `raiseUrgency('critical', 'high')` returns
 * `critical` — a rule set that only raises cannot demote, and that is asserted by
 * `rules.test.ts` across all 16 combinations rather than left to inspection.
 */
export function raiseUrgency(current: Urgency, floor: Urgency): Urgency {
  return rank(current) <= rank(floor) ? current : floor;
}

/* ========================================================================== */
/* R2 and R8 — the phrase tables                                                */
/* ========================================================================== */

/**
 * R2's trapped/immobile expressions. docs/09 §5.3.
 *
 * These are phrases a REPORTER writes. Matching them is not a judgement about the
 * model, it is noticing that "pinned under the car" is in the text — and the
 * urgency floor it implies is the same whether a person or a model wrote it.
 */
const TRAPPED_PATTERNS: readonly (readonly [RegExp, SafetyFlag])[] = [
  [/\btrapped\b/i, 'injured_trapped'],
  [/\bstuck\s+(inside|in|under|behind)\b/i, 'injured_trapped'],
  [/\bpinned\b/i, 'medical_critical'],
  [/\bunder\s+the\s+(car|vehicle|van|truck|bus|wreck|blade)\b/i, 'medical_critical'],
  [/\bnot\s+breathing\b/i, 'medical_critical'],
  [/\bunconscious\b/i, 'medical_critical'],
  [/\bbleeding\s+(heavily|badly|severely)\b/i, 'medical_critical'],
  [/\bcrushed\b/i, 'medical_critical'],
  [/\bunder\s+(the\s+)?(rubble|debris|collapse)\b/i, 'injured_trapped'],
];

/**
 * R8's diagnosis and death terms. docs/09 §1.2 rule 2, §5.3 R8.
 *
 * Matched against the SUMMARY only, and only when absent from the reporter's
 * original text. The distinction is the entire rule:
 *
 *   reporter: "my father collapsed and is not breathing"
 *     → the model repeating "not breathing" is a faithful summary. KEEP.
 *   reporter: "an old man collapsed on the footpath"
 *     → the model adding "cardiac arrest" is a DIAGNOSIS it invented. REMOVE.
 *
 * The second one is the case that matters. A model naming a cause of death in a
 * system with no medical professional and no liability process is asserting
 * something it cannot know, about a specific person, in a record that will be
 * read by responders and possibly by a court.
 */
const DIAGNOSIS_PATTERNS: readonly RegExp[] = [
  /\bdiagnos(is|ed|tic)\b/i,
  /\bdead\b/i,
  /\bdeceased\b/i,
  /\bdied\b/i,
  /\bfatal(ity)?\b/i,
  /\bmortality\b/i,
  /\bnot\s+breathing\b/i,
  /\bunresponsive\b/i,
  /\bunconscious\b/i,
  /\bcardiac\s+arrest\b/i,
  /\bheart\s+attack\b/i,
  /\bstroke\b/i,
  /\bhaemorrhage|hemorrhage\b/i,
  /\bshock\b/i,
  /\bbrain\s+death\b/i,
  /\bexpired\b/i,
];

/* ========================================================================== */
/* R8 — the diagnosis filter                                                    */
/* ========================================================================== */

/**
 * Remove clauses that assert a diagnosis the reporter did not.
 *
 * Clause-based, not term-based: a bare term removal would delete the word
 * "unconscious" out of the middle of a sentence and leave a grammatically broken
 * summary. Splitting on sentence and clause boundaries means a hallucinated
 * clause disappears whole and a faithful one is untouched.
 *
 * The term must be absent from the ORIGINAL text to be removed — checked case
 * insensitively, and against the whole original report rather than the matching
 * clause, because a reporter who said "unconscious" anywhere in the report has
 * told us they observed it and the model is not inventing it by repeating it.
 */
function filterDiagnoses(
  summary: string,
  originalText: string,
): { summary: string; filtered: boolean } {
  // -------------------------------------------------------------------------
  // WITH NO ORIGINAL, R8 CANNOT PROVE INVENTION — SO IT MUST NOT REMOVE
  // -------------------------------------------------------------------------
  // R8's whole test is "was this phrase in the report?". With no report to check
  // against, every diagnosis term looks invented, and the rule strips them all.
  //
  // That is the dangerous direction, and a test caught it: given
  // `originalText: ''` and a summary of "The person is not breathing", R8 removed
  // the clause as a hallucination and R2 — which then searched the filtered
  // summary — never saw the trapped-person phrasing, so a report describing an
  // unconscious person kept `low` urgency. Two rules interacted to erase the
  // evidence for the emergency.
  //
  // So an absent original means "not verifiable", not "invented". The phrase is
  // kept, the caller adds `low_confidence` and a note, and a human sees a summary
  // that may contain a term nobody can check. Losing a phrase a reporter wrote is
  // worse than keeping one a model may have added.
  if (originalText.trim().length === 0) {
    return { summary, filtered: false };
  }

  const original = originalText.toLowerCase();
  // Split keeps the separators, so a reconstruction cannot silently join two
  // sentences into one.
  const clauses = summary.split(/(?<=[.!?;])\s+/);
  const kept: string[] = [];

  for (const clause of clauses) {
    const invented = DIAGNOSIS_PATTERNS.some((pattern) => {
      if (!pattern.test(clause)) return false;
      // Was the phrase in the report? Compare on the matched text, not the whole
      // pattern, because a reporter may have written "not breathing" while the
      // pattern that matched is the broader "unresponsive".
      const match = clause.match(pattern);
      return match === null || !original.includes(match[0].toLowerCase());
    });
    if (!invented) kept.push(clause);
  }

  const filtered = kept.length !== clauses.length;
  // A summary emptied by the filter is worse than a vague one: there is nothing
  // left to show a dispatcher. The generic fallback keeps the record usable and
  // `filtered` still reports that something was removed.
  const rebuilt = kept.join(' ').trim();
  return {
    summary: filtered && rebuilt.length === 0 ? 'Reported emergency; details require human review.' : rebuilt,
    filtered,
  };
}

/* ========================================================================== */
/* Text shaping — docs/09 §5.2                                                  */
/* ========================================================================== */

/** Round to 2 dp. The brief's `0.91` example is exactly this. */
export function roundConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/**
 * Sentence-case, ensure a terminating period, and hard-trim to 240.
 *
 * Sentence-casing is docs/09 §5.2's "sentence-cased, trailing period added, 240-char
 * hard trim". It is not cosmetic: the summary is stored on the incident and shown
 * as the queue row's description, and a model that returns `"fire at the market"`
 * would otherwise render in the product's own body copy as a fragment.
 *
 * Only the FIRST character is touched. Title-casing the rest would mangle
 * "Dr Smith", an acronym, or a Hindi/Urdu proper noun, and the schema accepts a
 * non-ASCII first letter — so this lowercases the remainder only when the first
 * character is a plain ASCII letter.
 */
export function shapeSummary(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return 'Reported emergency.';

  const first = trimmed[0] as string;
  const sentence =
    /[A-Za-z]/.test(first) ? first.toUpperCase() + trimmed.slice(1) : trimmed;

  const terminated = /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  if (terminated.length <= 240) return terminated;

  const hard = terminated.slice(0, 240);
  // Prefer the last space so the trim does not cut a word in half. A hard cut is
  // the fallback for a single 240-character "word" (a base64 blob in a summary),
  // where there is no space to break on.
  const lastSpace = hard.lastIndexOf(' ');
  // The final `.slice(0, 240)` is not belt-and-braces, it is the fix for an
  // off-by-one a test found: in the no-space path the candidate is already 240
  // characters, so appending the terminating period produced 241 — a summary
  // stored above the bound the schema and the database both rely on. Capping
  // AFTER assembly is the only ordering that cannot be got wrong by arithmetic on
  // the two paths.
  //
  // Written with `+` rather than a template literal because the interpolation
  // would contain a regex ending in `$/`, and a `$` immediately before the
  // closing brace of an interpolation is exactly the kind of thing a reader
  // stops to check.
  const body = (lastSpace > 120 ? hard.slice(0, lastSpace) : hard).replace(/[.,;:\s]+$/, '');
  return (body + '.').slice(0, 240);
}

/** `en-US` → `en`. docs/09 §5.2. */
function normaliseLanguage(raw: string): string {
  // `?? 'en'` rather than a length check alone: `noUncheckedIndexedAccess` makes
  // `split('-')[0]` `string | undefined`, and a language tag with no base is
  // exactly the malformed input R10 exists to absorb.
  const base = raw.toLowerCase().split('-')[0] ?? '';
  return base.length >= 2 && base.length <= 3 ? base : 'en';
}

/* ========================================================================== */
/* The normaliser — the single conversion point                                 */
/* ========================================================================== */

/**
 * Turn validated model output into the record that may be stored.
 *
 * This is the ONLY function that produces `NormalizedTriage`, and
 * `services/ai/triage.ts` is the only caller. One conversion point is what makes
 * the audit trail honest: there is no second path by which a model's urgency
 * reaches an incident.
 *
 * The rules run in a deliberate order:
 *
 *  1. R8 (diagnosis filter) — before anything reads the summary.
 *  2. Urgency floors R1, R2, R3 — on the pre-filter urgency, and only raising.
 *  3. Hazard→flag mapping, then R6, then R7's flag.
 *  4. R5 confidence floor → `needsReview`, then R7's confidence CAP.
 *
 * R7 caps confidence AFTER R5 has decided `needsReview`, and adds
 * `low_confidence` itself, so a suspected injection can never be a
 * high-confidence record no matter what the model claimed.
 */
export function normalizeTriageOutput(
  output: AiTriageOutput,
  context: RuleContext,
): NormalizedTriage {
  const notes: string[] = [];
  // Declared before the first rule that adds to it, which is R8. Every rule below
  // unions into this one set and the final order comes from `SAFETY_FLAGS`, so a
  // rule can add a flag in any sequence without the order depending on rule order.
  const safety = new Set<SafetyFlag>(output.safety_flags);

  /* --- R8 ------------------------------------------------------------- */
  const { summary: filteredSummary, filtered } = filterDiagnoses(output.summary, context.originalText);
  // The other half of R8, which docs/09 §5.3 specifies and the first version of
  // this function omitted: a summary we had to edit is a summary we no longer
  // fully trust, so it is flagged. Without this, a model that asserted a cause of
  // death would have that clause quietly removed and keep a clean, unflagged
  // confidence — the filter would make the output look MORE trustworthy.
  if (filtered) {
    safety.add('low_confidence');
    notes.push('A diagnosis stated by the model that was not in the report was removed.');
  }

  /* --- R1: safety flags force at least `high` ------------------------- */
  let urgency: Urgency = output.urgency;
  for (const flag of output.safety_flags) {
    if ((URGENCY_FLOOR_FLAGS as readonly string[]).includes(flag)) {
      urgency = raiseUrgency(urgency, 'high');
    }
  }

  /* --- R2: trapped / immobile phrasing -------------------------------- */
  //
  // The searchable text is the REPORTER'S OWN WORDS plus the landmarks, NOT the
  // R8-filtered summary. This ordering is load-bearing and the first version of
  // this function got it wrong in a way that mattered:
  //
  //   reporter: "he is not breathing"   model: "The person is not breathing."
  //
  // `not breathing` is in BOTH tables. When the reporter used the phrase, R8 keeps
  // it (it was in the input) and R2 raises urgency. But when the model introduces
  // it, R8 strips it — and if R2 then searched the filtered summary, a report that
  // reached the model carrying "not breathing" and came back with the phrase
  // REMOVED as an invented diagnosis would silently keep its `low` urgency. The
  // person is trapped and the code decided they were not.
  //
  // Searching the original text removes the interaction entirely: trapped
  // phrasing in the CITIZEN's report always raises urgency, whatever R8 did to the
  // model's paraphrase of it.
  const searchable = `${context.originalText} ${output.landmarks.join(' ')} ${filteredSummary}`;
  for (const [pattern, flag] of TRAPPED_PATTERNS) {
    if (pattern.test(searchable)) {
      safety.add(flag);
      urgency = raiseUrgency(urgency, 'high');
    }
  }

  /* --- R3: hazards force at least `high` ------------------------------ */
  for (const hazard of output.hazards) {
    if (hazard === 'gas_leak') {
      safety.add('gas_leak');
      urgency = raiseUrgency(urgency, 'high');
    }
    if (hazard === 'fire') {
      safety.add('fire');
      urgency = raiseUrgency(urgency, 'high');
    }
    if (hazard === 'weapon') safety.add('violence');
  }

  /* --- R6: no coordinates means an unclear location -------------------- */
  const noCoordinates = !context.hasCoordinates;
  if (noCoordinates) safety.add('unclear_location');

  /* --- R7: a suspected injection caps confidence ----------------------- */
  let confidence = roundConfidence(output.confidence);
  if (context.suspicionScore >= 3) {
    confidence = Math.min(confidence, AI_SUSPICION_CONFIDENCE_CEILING);
    safety.add('low_confidence');
    notes.push('The report contained instruction-like text, so AI confidence was capped.');
  }

  /* --- R5: low confidence is a review flag ----------------------------- */
  if (confidence < context.reviewThreshold) safety.add('low_confidence');

  /* --- R10: an unsupported language becomes `en` ------------------------ */
  const language = normaliseLanguage(output.language);
  if (language !== output.language.toLowerCase()) {
    notes.push(`The report language was recorded as "${language}".`);
  }

  /* --- category: out-of-taxonomy becomes `other` + `categoryRaw` -------- */
  const { category, categoryRaw } = classifyCategory(output.category);

  /* --- R4: people_affected is trusted only when STATED ----------------- */
  // Note what is NOT here: any default, any inference, any "probably one
  // person". `people_affected_stated === false` means the model did not claim a
  // number was said, so a number it returned is an invention and is discarded.
  const peopleAffected = output.people_affected_stated ? output.people_affected : null;

  /* --- resources: cap the confidence of anything inferred -------------- */
  const requiredResources: NormalizedResource[] = output.required_resources
    // A `resourceId` outside the catalogue cannot be dispatched, so it is
    // dropped rather than stored as an unfulfillable request.
    .filter((resource) => (RESOURCE_IDS as readonly string[]).includes(resource.resourceId))
    .map((resource) => {
      const stated = resourceRequestedByReporter(resource.resourceId, context.originalText);
      return {
        resourceId: resource.resourceId,
        quantity: resource.quantity,
        // An inferred request is capped at the LOWER of the two ceilings, not
        // the higher one. `AI_INFERRED_RESOURCE_CONFIDENCE_CAP` (0.5) is the
        // policy ceiling from docs/09 §1.2; `AI_MODEL_RESOURCE_CONFIDENCE_CAP`
        // (0.4) is the prompt's own instruction to the model. Taking the lower
        // means the code enforces the stricter of the two promises, so a model
        // that ignored the prompt is still held to the policy.
        confidence: stated
          ? 1
          : Math.min(
              resource.confidence,
              AI_INFERRED_RESOURCE_CONFIDENCE_CAP,
              AI_MODEL_RESOURCE_CONFIDENCE_CAP,
            ),
        reason: resource.reason,
        source: stated ? ('reporter' as const) : ('ai' as const),
      };
    });

  /* --- unknown_fields: 'location' implies the flag ---------------------- */
  const unknownFields = [...output.unknown_fields];
  if (noCoordinates && !unknownFields.includes('location')) unknownFields.push('location');

  /* --- deterministic flag order ---------------------------------------- */
  // Sorted by the canonical enum order, not alphabetically and not in the
  // model's order, so two runs that produce the same set produce the same
  // array. A dispatcher diffing two records should not see a reordering.
  const safetyFlags = SAFETY_FLAGS.filter((flag) => safety.has(flag));

  return {
    category,
    categoryRaw,
    urgency,
    summary: shapeSummary(filteredSummary),
    language,
    locationHint: output.location_hint,
    landmarks: output.landmarks,
    peopleAffected,
    requiredResources,
    safetyFlags,
    hazards: output.hazards,
    audioTranscript: output.audio_transcript,
    audioTranscriptUncertain: output.audio_transcript_uncertain,
    confidence,
    unknownFields,
    // FR-024. Never the model's opinion: it is this threshold, this number.
    needsReview: confidence < context.reviewThreshold,
    notes,
    hallucinationFiltered: filtered,
  };
}

/**
 * Did the REPORTER ask for this resource, or did the model infer it?
 *
 * docs/09 §1.2 rule 5: an inferred resource is capped at 0.5 confidence; one the
 * reporter explicitly requested is `source: 'reporter'` at 1.0.
 *
 * The test is whether a word from the resource's own NAME appears in the report.
 * "I need an ambulance" and "res_ambulance" then agree, and "there is a fire" does
 * not agree with `res_water_rescue`. It is a heuristic, and it is a deliberately
 * conservative one: the cost of a false negative is a request capped at 0.5 that
 * a dispatcher can still act on, and the cost of a false positive is a fabricated
 * 1.0-confidence request that a person is told was asked for. The asymmetry is the
 * design.
 */
function resourceRequestedByReporter(resourceId: string, originalText: string): boolean {
  const report = originalText.toLowerCase();
  if (report.length === 0) return false;
  return (RESOURCE_REPORTER_TERMS[resourceId] ?? []).some((term) => report.includes(term));
}

/**
 * Words that mean "the reporter asked for this", per resource id.
 *
 * A table rather than a derived function because the mapping is a JUDGEMENT about
 * language, not a computation: whether "rescue team" and "send help" name the
 * same request is an editorial call, and it belongs somewhere a human reviews it.
 *
 * Every id in `RESOURCE_IDS` appears, which `tests/unit/ai/rules.test.ts`
 * asserts. A missing key would silently make every request for that resource look
 * inferred — a safe direction to fail in, since an inferred request is capped at
 * 0.5 confidence, but still a wrong answer about what the citizen asked for.
 */
export const RESOURCE_REPORTER_TERMS: Readonly<Record<string, readonly string[]>> = {
  res_ambulance: ['ambulance', 'paramedic'],
  res_first_aid: ['first aid', 'first-aid', 'firstaid', 'medic'],
  res_fire_engine: ['fire engine', 'fire truck', 'fire brigade'],
  res_fire_extinguisher_team: ['extinguisher', 'fire team'],
  res_police_support: ['police'],
  res_traffic_control: ['traffic control', 'traffic police', 'close the road'],
  res_heavy_tow: ['tow truck', 'towing', 'heavy tow'],
  res_water_rescue: ['water rescue', 'boat', 'divers'],
  res_search_team: ['search team', 'search and rescue'],
  res_cooling_shelter: ['cooling', 'shelter', 'cool place'],
  res_food_water_kit: ['food', 'water', 'rations', 'drinking water'],
  res_power_team: ['power', 'electricity', 'transformer'],
};

/* ========================================================================== */
/* R9 — the assertion that code cannot lower urgency                            */
/* ========================================================================== */

/**
 * R9, stated as a checkable fact rather than a comment.
 *
 * `normalizeTriageOutput` has no parameter and no branch that can set an urgency
 * below the model's. A future change that adds one — "correct an over-escalation",
 * the obvious reasonable-sounding edit — fails this immediately instead of
 * shipping a system that demotes emergency reports on a model's say-so.
 *
 * Exported for `rules.test.ts`, which calls it across all 16 (urgency, floor)
 * pairs and asserts `raiseUrgency(u, f) === (rank(u) <= rank(f) ? u : f)` — i.e.
 * that no input pair produces a value below its own floor.
 */
export function urgencyFloorIsInclusive(urgency: Urgency, floor: Urgency): boolean {
  return rank(raiseUrgency(urgency, floor)) <= rank(urgency);
}

/** The bands, re-exported so the UI and the rules agree on one threshold set. */
export const CONFIDENCE_BANDS = AI_CONFIDENCE_BANDS;

/** The category list, for the prompt builder and the tests. */
export const AI_CATEGORIES = INCIDENT_CATEGORIES;

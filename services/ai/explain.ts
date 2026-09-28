/**
 * ============================================================================
 * CareGrid AI — the dispatcher-facing explanation
 * ============================================================================
 *
 * docs/09 §3, `services/ai/explain.ts`. Builds the human-readable `explanation`
 * the dispatcher panel shows beside an AI assessment. PURE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE AND NOT A TEMPLATE IN THE PANEL
 * ---------------------------------------------------------------------------
 * Because the same explanation is needed in three places that will otherwise
 * drift: the dispatcher panel, the citizen's confirmation screen, and the
 * incident timeline entry. Three `switch` statements in three components produce
 * three slightly different sentences for the same triage, and the one that drifts
 * is the one a judge notices.
 *
 * It is also the only place that knows the *shape* of a triage result, so it is
 * the only place that has to change when the schema does.
 *
 * ---------------------------------------------------------------------------
 * THE TONE RULE
 * ---------------------------------------------------------------------------
 * Every sentence here is written to be read by a person deciding whether to send
 * a responder, in a hurry, about a real emergency. That produces three rules the
 * copy follows without exception:
 *
 *  1. **Never state a fact the system does not have.** "AI could not determine
 *     how many people are affected" is a true and useful sentence. "0 people" is
 *     false and dangerous. See R4.
 *  2. **Never let an AI word look like a system word.** The subject of a triage
 *     sentence is "The AI assessment", not "This incident". The moment it reads
 *     "This incident has two people affected", a reader has stopped thinking about
 *     provenance.
 *  3. **Say what is unknown as loudly as what is known.** The `unknown_fields`
 *     list is the most decision-relevant part of the record for a human, and it
 *     is the part a summary silently drops.
 */

import { categoryLabel } from '@/config/categories';
import { URGENCY_META } from '@/config/urgencies';
import { resourceName } from '@/config/resources';
import { SAFETY_FLAG_META } from '@/config/safety-flags';
import { AI_CONFIDENCE_BANDS } from '@/config/ai';
import type { SafetyFlag } from '@/types/enums';
import type { NormalizedTriage } from '@/services/ai/rules';

/**
 * A safety flag's human sentence.
 *
 * Read from `SAFETY_FLAG_META` rather than written here, for the reason the header
 * gives: the config table already owns the wording ("Critical injury reported"),
 * and a second copy of eleven strings is a second thing to keep in sync. The
 * `?? flag` fallback means a flag with no metadata entry renders its own id rather
 * than `undefined` — visible and debuggable, which is better in an emergency
 * panel than a blank.
 */
function safetyFlagLabel(flag: SafetyFlag): string {
  return SAFETY_FLAG_META[flag]?.label ?? flag;
}

/**
 * A confidence band, and the wording that goes with it.
 *
 * The bands are docs/09 §5.4's and they are shared with `rules.ts` rather than
 * restated, so the panel cannot call 0.72 "high" while the rules engine treats it
 * as needing review.
 */
export type ConfidenceBand = 'high' | 'medium' | 'low';

export function bandFor(confidence: number): ConfidenceBand {
  if (confidence >= AI_CONFIDENCE_BANDS.high) return 'high';
  if (confidence >= AI_CONFIDENCE_BANDS.medium) return 'medium';
  return 'low';
}

/**
 * How a confidence number is SPOKEN. docs/09 §5.4 and brief §14.
 *
 * The rule the brief states — "make clear that confidence is AI confidence, NOT
 * certainty" — is implemented by never rendering a bare percentage. Every string
 * here carries the word "assessment", and the low band says "needs review" rather
 * than presenting a number at all, because a percentage on its own reads as a
 * measurement and a percentage labelled "AI assessment" reads as what it is.
 */
export function confidenceLabel(confidence: number): string {
  const percent = Math.round(confidence * 100);
  switch (bandFor(confidence)) {
    case 'high':
      return `AI assessment confidence ${percent}% — treat as a starting point, not a measurement.`;
    case 'medium':
      return `AI assessment confidence ${percent}% — a rough estimate. Check it against the report.`;
    case 'low':
      return 'AI assessment confidence is low. A person should read the full report before acting.';
  }
}

/**
 * The one-line triage sentence.
 *
 * Names the category and the urgency, in that order, because category is what
 * tells a dispatcher which team and urgency is what tells them how fast. Both are
 * labelled as the AI's assessment rather than as the incident's state.
 */
export function headline(triage: NormalizedTriage): string {
  const category = categoryLabel(triage.category);
  const urgency = URGENCY_META[triage.urgency].label.toLowerCase();
  return `AI assessment: ${category}, ${urgency} urgency. A person decides what happens next.`;
}

/**
 * The full explanation, as an ordered list.
 *
 * Order is the reading order of a decision: what it is, how sure the AI is, what
 * it could not determine, what it suggests, and what is wrong with the assessment.
 * The problems come before the suggestions on purpose — a dispatcher who reads
 * "gas leak, urgency raised" and then "this was a keyword fallback" has been
 * misled for a sentence, and the sentence matters.
 */
export function explain(triage: NormalizedTriage, options: { readonly source: 'ai' | 'fallback' | 'manual' }): readonly string[] {
  const lines: string[] = [
    headline(triage),
    confidenceLabel(triage.confidence),
  ];

  if (options.source === 'fallback') {
    lines.push(
      'This assessment was produced by keyword rules because AI analysis was unavailable. ' +
        'It is a keyword match, not a reading of the report.',
    );
  }

  /* --- what the AI could not determine ---------------------------------- */
  if (triage.unknownFields.length > 0) {
    const listed = triage.unknownFields.map(unknownFieldLabel).join(', ');
    lines.push(`The AI could not determine: ${listed}.`);
  }

  /* --- resources, with their provenance --------------------------------- */
  if (triage.requiredResources.length > 0) {
    const listed = triage.requiredResources
      .map((resource) => {
        const name = resourceName(resource.resourceId);
        // The provenance is part of the sentence, not a tooltip. A request the
        // citizen made and one the AI inferred deserve different weight, and a
        // dispatcher should not have to hover to learn which they are reading.
        const origin = resource.source === 'reporter' ? 'asked for by the reporter' : 'suggested by the AI';
        return `${name} (${origin})`;
      })
      .join(', ');
    lines.push(`Resources: ${listed}. Nothing has been requested or dispatched.`);
  }

  /* --- safety flags, in the flag table's own order ---------------------- */
  if (triage.safetyFlags.length > 0) {
    const listed = triage.safetyFlags.map((flag) => safetyFlagLabel(flag)).join(', ');
    lines.push(`Safety flags: ${listed}.`);
  }

  /* --- the location, always hedged -------------------------------------- */
  // MUST NOT 7 and docs/09 §5.2: `location_hint` is an approximation and is never
  // stored on the incident. It is shown here, prefixed "approximate", and only as
  // a hint for a dispatcher who already has a real location from the reporter.
  if (triage.locationHint !== null) {
    lines.push(`Approximate location hint from the AI: "${triage.locationHint}". This is not a verified location.`);
  }

  /* --- people affected: never a bare number ---------------------------- */
  // The one place `people_affected` is rendered, and it renders the REPORTER'S
  // figure with a qualifier. docs/09 §10 requires exactly this: "the client UI
  // must render a 'reported figure' qualifier, never '47 victims confirmed'".
  lines.push(peopleAffectedSentence(triage));

  /* --- what is wrong with this assessment ------------------------------- */
  for (const note of triage.notes) lines.push(note);
  if (triage.hallucinationFiltered) {
    lines.push('A diagnosis asserted by the AI that was not in the report was removed from the summary.');
  }

  return lines;
}

/**
 * The `people_affected` sentence, in every one of its three states.
 *
 * | State | Sentence | Why not the alternative |
 * | --- | --- | --- |
 * | a number was stated | "The reporter stated N people affected." | "N people are affected" asserts it. |
 * | `null` | "The number of people affected is not known." | "0" is a claim. |
 * | `null`, medical flag | "…; nobody has confirmed how many are hurt." | R4: never substitute a number. |
 *
 * The third row is the one that matters most, and it is why this is a function
 * with three branches rather than a template with a nullable interpolation: the
 * medical case is exactly where the temptation to write "1" lives.
 */
function peopleAffectedSentence(triage: NormalizedTriage): string {
  const medical = triage.safetyFlags.includes('medical_critical');
  if (triage.peopleAffected === null) {
    return medical
      ? 'Nobody has confirmed how many people are affected. Do not assume a number.'
      : 'The number of people affected is not known.';
  }
  return `The reporter stated ${triage.peopleAffected} ${triage.peopleAffected === 1 ? 'person' : 'people'} affected. This is the reporter's figure and has not been verified.`;
}

/** One `unknown_fields` member, in a sentence a person can act on. */
function unknownFieldLabel(field: NormalizedTriage['unknownFields'][number]): string {
  switch (field) {
    case 'location':
      return 'the location';
    case 'people_affected':
      return 'how many people are affected';
    case 'specific_injury':
      return 'the nature of any injury';
    case 'exact_address':
      return 'an exact address';
    case 'resources':
      return 'which resources are needed';
    case 'time_of_incident':
      return 'when it happened';
  }
}

/**
 * The citizen-facing sentence. DIFFERENT from the dispatcher's, on purpose.
 *
 * A citizen should not be shown "The AI could not determine the nature of any
 * injury" — that is internal vocabulary and it reads as a criticism of their
 * report. They are told what will happen next, which is the thing they can act on.
 */
export function citizenSummary(triage: NormalizedTriage, options: { readonly source: 'ai' | 'fallback' | 'manual' }): string {
  if (options.source === 'fallback') {
    return 'Your report was sent. AI analysis was unavailable, so a responder will review it directly — that is normal and your report is not delayed by it.';
  }
  return `Your report was categorised as ${categoryLabel(triage.category)} with ${URGENCY_META[triage.urgency].label.toLowerCase()} urgency by AI analysis. A person reviews every report before anyone is sent.`;
}

/** Re-exported so a component can render a flag's own metadata without a second import path. */
export { SAFETY_FLAG_META, URGENCY_META, categoryLabel, resourceName };

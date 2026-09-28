/**
 * ============================================================================
 * AI triage copy — brief §14, §16, §17, §18, §19
 * ============================================================================
 *
 * Every sentence the AI triage surfaces, in one file.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE AND NOT INLINE JSX
 * ---------------------------------------------------------------------------
 * `docs/04 §14.1` puts all user-facing microcopy in one dictionary, and the
 * reasons it gives are the reasons this file exists:
 *
 *  1. **The tone rules are checkable.** docs/04 §15 forbids exclamation marks and
 *     the word "successfully", and says the AI is never the actor. Those are
 *     assertions over a string table, which `tests/unit/ai/ai-triage-copy.test.ts`
 *     does; they are not checkable over JSX.
 *  2. **The same sentence is needed in two places.** The citizen's confirmation
 *     screen and the dispatcher panel both explain what the AI did, and three
 *     drifted variants of the same sentence is how a product starts contradicting
 *     itself about the most safety-relevant thing it says.
 *  3. **It is the record of a decision.** A judge asking "what did the product
 *     claim to the user about the AI?" gets one file.
 *
 * ---------------------------------------------------------------------------
 * THE TONE, IN ONE PARAGRAPH
 * ---------------------------------------------------------------------------
 * A person is reading this while frightened, on a phone, possibly one-handed, and
 * they are being asked to trust a language model's opinion about an emergency.
 * So: no exclamation marks, no "smart" or "intelligent", no claim that the AI
 * "knows", and never a sentence that could be read as the AI having decided
 * something. The AI assesses. A person acts.
 */

import { SAFETY_FLAG_META } from '@/config/safety-flags';
import type { SafetyFlag } from '@/types';

export const AI_TRIAGE_COPY = {
  /* --- the panel ------------------------------------------------------- */
  title: 'AI assessment',
  /** brief §14. The one sentence that has to be on this panel. */
  disclaimer:
    'This is an AI assessment of your report, not a decision. A person reviews every report before anyone is sent.',

  categoryLabel: 'Suggested category — you can change this',
  categoryHelp:
    'AI chose this from your description. If it is wrong, change it — the person handling your report will see what you pick.',

  urgencyLabel: 'Suggested urgency — you can change this',
  /**
   * The SLA in the citizen's language rather than the dispatcher's. "Response
   * target 15 minutes" is a promise the system cannot keep in a city with traffic
   * and it is not this screen's promise to make.
   */
  slaHint: (minutes: number) =>
    minutes <= 5
      ? 'Treated as an immediate priority.'
      : `Treated as a ${minutes <= 15 ? 'priority' : 'routine priority'} emergency.`,

  summaryLabel: 'Summary — you can change this',
  summaryFallback: 'A person will read your full report.',
  summaryHelp: 'This appears at the top of the queue for the person handling your report.',

  /**
   * brief §7 and docs/09 §1.2 rule 4. The copy is the enforcement.
   *
   * "We could not count people" would suggest the system tried. The honest
   * statement is that the number comes from the person reporting and from nobody
   * else, which is both true and the reason the field is empty.
   */
  peopleLabel: 'How many people are affected',
  peopleHelp:
    'Only you can supply this. Leave it blank if you do not know — a blank is honest, a guess is not.',

  resourcesLabel: 'Suggested resources',
  resourcesHelp:
    'These are suggestions for the person handling your report. Nothing has been requested or sent.',
  resourceFromAi: 'suggested by the AI',
  resourceFromReporter: 'asked for by you',

  flagsLabel: 'Points to be aware of',

  unknownFields: (fields: string) =>
    `The AI could not determine ${fields}. Your full report is still read by a person.`,

  /**
   * docs/09 §4.2. A model that saw one of three photos must not appear to have
   * seen three, and the citizen is the one who can decide whether to send another.
   */
  mediaDropped: (count: number) =>
    `${count} photo${count === 1 ? '' : 's'} could not be sent to the AI because of size. The AI assessed the rest.`,

  confirm: 'Use these details',
  reanalyse: 'Analyse again',
  dismiss: 'Ignore this and continue',

  /* --- the "needs review" band, FR-024 --------------------------------- */
  needsReviewBadge: 'Needs review',
  /**
   * brief §14. "AI confidence: 91%" and nothing else is what we are avoiding —
   * a bare number reads as a measurement.
   */
  confidenceLabel: (percent: number) => `AI assessment confidence: ${percent}%. This is an estimate, not a certainty.`,
  confidenceUnavailable:
    'The AI did not give a confidence score. A person will read this report in full.',

  /* --- loading, brief §17 ---------------------------------------------- */
  analysing: 'Analysing your report',
  /**
   * Real steps, in the order the request actually takes. brief §17 forbids a fake
   * percentage, and the honest way to avoid inventing motion is to name the
   * phases rather than animate a bar.
   */
  steps: [
    'Reading your report',
    'Reviewing your photos',
    'Classifying the emergency',
    'Estimating urgency',
    'Identifying resources',
  ] as const,
  stepDone: 'done',

  /* --- failure, brief §18 and §19 -------------------------------------- */
  /**
   * brief §19 requires the manual path to be stated as available, not implied.
   * "You can still continue" is a promise; this sentence is the promise.
   */
  unavailableTitle: 'AI analysis is temporarily unavailable',
  unavailableBody:
    'Your emergency report can still be submitted without it. Fill in what you know, or submit as it is — a person will review it either way.',

  notConfiguredTitle: 'AI analysis is not available in this deployment',
  notConfiguredBody:
    'Your report is still recorded and reviewed by a person. Nothing about submitting changes.',

  /**
   * brief §26. A demo built with the mock on must SAY so, so a canned response can
   * never be mistaken for an assessment.
   */
  simulatedBadge: 'Sample data — no AI was called',

  /**
   * docs/09 §7.2 and §5.4. The fallback is a keyword match, and a citizen reading
   * "AI assessment" on a record produced by string matching has been told
   * something false.
   */
  fallbackBadge: 'Keyword match — a person will review this',

  retry: 'Try AI analysis again',
  continueManually: 'Continue without AI',

  /* --- the flag labels ------------------------------------------------- */
  /**
   * Read from `SAFETY_FLAG_META` rather than restated, for the reason
   * `services/ai/explain.ts` does: one owner for eleven strings. A second copy is
   * a second thing to keep in sync, and a desynchronised safety flag is worse than
   * a missing one — it would read as a different hazard.
   */
  flagLabels: Object.fromEntries(
    (Object.keys(SAFETY_FLAG_META) as SafetyFlag[]).map((flag) => [flag, SAFETY_FLAG_META[flag].label]),
  ) as Record<SafetyFlag, string>,
} as const;

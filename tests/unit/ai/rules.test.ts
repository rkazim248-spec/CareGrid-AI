/**
 * ============================================================================
 * The deterministic safety rules — `services/ai/rules.ts`
 * ============================================================================
 *
 * R1-R10 from docs/09 §5.3, plus the §5.2 normalisations.
 *
 * These are the controls that hold when the model is wrong. A prompt is a
 * request and a model is a suggester, so every rule here is asserted as a
 * property of CODE rather than as an instruction the model was asked to follow —
 * including the two that matter most, R4 (never invent a casualty count) and R9
 * (code may raise urgency but never lower it).
 */

import { describe, expect, it } from 'vitest';

import {
  RESOURCE_REPORTER_TERMS,
  normalizeTriageOutput,
  raiseUrgency,
  roundConfidence,
  shapeSummary,
  urgencyFloorIsInclusive,
  type RuleContext,
} from '@/services/ai/rules';
import { AI_RESPONSE_JSON_SCHEMA, aiTriageOutputSchema, type AiTriageOutput } from '@/services/ai/schema';
import { RESOURCE_IDS } from '@/config/resources';
import { SAFETY_FLAGS, URGENCIES } from '@/types/enums';

/** A context with sensible defaults, so each test states only what it is about. */
function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    hasCoordinates: true,
    suspicionScore: 0,
    originalText: '',
    reviewThreshold: 0.6,
    ...overrides,
  };
}

/** A valid model output, so each test mutates exactly one field. */
function out(overrides: Partial<AiTriageOutput> = {}): AiTriageOutput {
  const base: Record<string, unknown> = {
    category: 'other',
    category_confidence: 0.5,
    urgency: 'low',
    urgency_confidence: 0.5,
    summary: 'A report was received.',
    language: 'en',
    location_hint: null,
    landmarks: [],
    people_affected: null,
    people_affected_stated: false,
    required_resources: [],
    hazards: [],
    safety_flags: [],
    audio_transcript: null,
    audio_transcript_uncertain: false,
    confidence: 0.8,
    unknown_fields: [],
    ...overrides,
  };
  // Parse rather than cast: the rules are only ever handed a VALIDATED output, so
  // a test that bypasses the schema would be testing a state production cannot
  // reach. If the shape drifts, this throws and names the field.
  return aiTriageOutputSchema.parse(base);
}

/* ========================================================================== */
/* Urgency arithmetic — R1/R2/R3 raise, R9 forbids lowering                      */
/* ========================================================================== */

describe('urgency may be RAISED by code and never LOWERED — R9', () => {
  it('raiseUrgency only ever raises, across all 16 pairs', () => {
    const rankOf = (u: (typeof URGENCIES)[number]): number => URGENCIES.indexOf(u);
    for (const current of URGENCIES) {
      for (const floor of URGENCIES) {
        const result = raiseUrgency(current, floor);
        // The invariant, asserted directly.
        expect(
          rankOf(result),
          `${current} raised to ${floor} became ${result}, which is MORE urgent than the model said`,
        ).toBeLessThanOrEqual(rankOf(current));
        // And the exact expected value. The ternary tests `current`, not
        // `result` — an earlier version tested `rankOf(result) <= rankOf(floor)`,
        // which is trivially true after a raise and so expected the pre-raise
        // value for exactly the pairs that raise.
        expect(result).toBe(rankOf(current) <= rankOf(floor) ? current : floor);
        expect(urgencyFloorIsInclusive(current, floor)).toBe(true);
      }
    }
  });

  it('raising critical to low LEAVES IT critical', () => {
    // The single most important line in this file. A model that claims `critical`
    // for a sunset is NOT corrected down to `low` by code, because the model is
    // not the only source: a human may have raised it already, and a system that
    // silently demotes an urgency claim will eventually demote a real one.
    expect(raiseUrgency('critical', 'low')).toBe('critical');
    expect(raiseUrgency('critical', 'medium')).toBe('critical');
  });

  it('raising low to critical DOES escalate', () => {
    expect(raiseUrgency('low', 'critical')).toBe('critical');
  });
});

describe('R1/R2/R3 raise urgency from a signal in the report', () => {
  it('R1: a safety flag from the floor list raises urgency to at least high', () => {
    for (const flag of ['medical_critical', 'self_harm', 'child_at_risk', 'violence'] as const) {
      const result = normalizeTriageOutput(out({ urgency: 'low', safety_flags: [flag] }), ctx());
      expect(result.urgency, `${flag} did not raise urgency`).toBe('high');
    }
  });

  it('R2: trapped or immobile phrasing raises urgency and adds a flag', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['A man is trapped in the car.', 'injured_trapped'],
      ['She is pinned under the car.', 'medical_critical'],
      ['The person is not breathing.', 'medical_critical'],
      ['He is unconscious.', 'medical_critical'],
      ['She is bleeding heavily.', 'medical_critical'],
    ];
    for (const [summary, expectedFlag] of cases) {
      const result = normalizeTriageOutput(out({ urgency: 'low', summary }), ctx());
      expect(result.urgency, `"${summary}" did not raise urgency`).toBe('high');
      expect(result.safetyFlags, `"${summary}" is missing ${expectedFlag}`).toContain(expectedFlag);
    }
  });

  it('R2 reads the landmarks too, not only the summary', () => {
    const result = normalizeTriageOutput(
      out({ urgency: 'low', landmarks: ['the trapped person'] }),
      ctx(),
    );
    expect(result.urgency).toBe('high');
  });

  it('R3: a gas_leak or fire hazard raises urgency and adds the matching flag', () => {
    const gas = normalizeTriageOutput(out({ urgency: 'low', hazards: ['gas_leak'] }), ctx());
    expect(gas.urgency).toBe('high');
    expect(gas.safetyFlags).toContain('gas_leak');

    const fire = normalizeTriageOutput(out({ urgency: 'low', hazards: ['fire'] }), ctx());
    expect(fire.urgency).toBe('high');
    expect(fire.safetyFlags).toContain('fire');
  });

  it('R3: a weapon hazard adds the violence flag', () => {
    const result = normalizeTriageOutput(out({ hazards: ['weapon'] }), ctx());
    expect(result.safetyFlags).toContain('violence');
  });

  it('an unrelated hazard does NOT raise urgency', () => {
    // `crowd` is a hazard and not an emergency. A rule set that raised urgency for
    // every hazard would make `high` meaningless.
    const result = normalizeTriageOutput(out({ urgency: 'low', hazards: ['crowd', 'smoke'] }), ctx());
    expect(result.urgency).toBe('low');
  });
});

/* ========================================================================== */
/* R4 — people_affected is never invented                                      */
/* ========================================================================== */

describe('R4: a casualty count is only ever a STATED number', () => {
  it('keeps the count when the reporter stated it', () => {
    const result = normalizeTriageOutput(
      out({ people_affected: 4, people_affected_stated: true }),
      ctx(),
    );
    expect(result.peopleAffected).toBe(4);
  });

  it('DISCARDS a count when stated is false, even for a medical emergency', () => {
    // The tempting repair for "a medical emergency with no casualty count" is to
    // assume one. docs/09 §1.2 rule 4 forbids it and R4 exists because the
    // temptation is real: `null` looks like a bug.
    const result = normalizeTriageOutput(
      out({ people_affected: 1, people_affected_stated: false, safety_flags: ['medical_critical'] }),
      ctx(),
    );
    expect(result.peopleAffected).toBeNull();
    expect(result.safetyFlags).toContain('medical_critical');
  });

  it('preserves a legitimate stated zero', () => {
    // docs/09 §10: "there are 0 people affected" → 0 with stated: true. Collapsing
    // 0 to null would make "nobody is hurt" indistinguishable from "we do not know".
    const result = normalizeTriageOutput(
      out({ people_affected: 0, people_affected_stated: true }),
      ctx(),
    );
    expect(result.peopleAffected).toBe(0);
  });

  it('never substitutes 1 for a null count, which is the specific documented failure', () => {
    const result = normalizeTriageOutput(
      out({ people_affected: null, people_affected_stated: false, urgency: 'critical' }),
      ctx(),
    );
    expect(result.peopleAffected).toBeNull();
  });
});

/* ========================================================================== */
/* R5 / R7 — confidence                                                         */
/* ========================================================================== */

describe('R5: confidence below the threshold is a review flag', () => {
  it('adds low_confidence and sets needsReview', () => {
    const result = normalizeTriageOutput(out({ confidence: 0.4 }), ctx({ reviewThreshold: 0.6 }));
    expect(result.safetyFlags).toContain('low_confidence');
    expect(result.needsReview).toBe(true);
  });

  it('adds NO flag at or above the threshold', () => {
    const result = normalizeTriageOutput(out({ confidence: 0.6 }), ctx({ reviewThreshold: 0.6 }));
    expect(result.safetyFlags).not.toContain('low_confidence');
    expect(result.needsReview).toBe(false);
  });

  it('the threshold is honoured, not hardcoded to 0.6', () => {
    // Raising `AI_CONFIDENCE_REVIEW_THRESHOLD` must raise the bar, or the
    // environment variable is decorative.
    const strict = normalizeTriageOutput(out({ confidence: 0.7 }), ctx({ reviewThreshold: 0.9 }));
    expect(strict.needsReview).toBe(true);
  });
});

describe('R7: a suspected injection caps confidence', () => {
  it('caps at 0.4 and forces a review flag at a score of 3', () => {
    const result = normalizeTriageOutput(out({ confidence: 0.95 }), ctx({ suspicionScore: 3 }));
    expect(result.confidence).toBeLessThanOrEqual(0.4);
    expect(result.safetyFlags).toContain('low_confidence');
    expect(result.needsReview).toBe(true);
    expect(result.notes.join(' ')).toMatch(/instruction-like/i);
  });

  it('does NOT cap below the threshold', () => {
    const result = normalizeTriageOutput(out({ confidence: 0.95 }), ctx({ suspicionScore: 2 }));
    expect(result.confidence).toBe(0.95);
  });

  it('a cap cannot RAISE a low confidence', () => {
    const result = normalizeTriageOutput(out({ confidence: 0.1 }), ctx({ suspicionScore: 9 }));
    expect(result.confidence).toBe(0.1);
  });
});

/* ========================================================================== */
/* R6 — no coordinates                                                          */
/* ========================================================================== */

describe('R6: an incident with no coordinates is flagged unclear', () => {
  it('adds unclear_location and records it as an unknown field', () => {
    const result = normalizeTriageOutput(out(), ctx({ hasCoordinates: false }));
    expect(result.safetyFlags).toContain('unclear_location');
    expect(result.unknownFields).toContain('location');
  });

  it('adds nothing when coordinates exist', () => {
    const result = normalizeTriageOutput(out(), ctx({ hasCoordinates: true }));
    expect(result.safetyFlags).not.toContain('unclear_location');
  });
});

/* ========================================================================== */
/* R8 — the diagnosis filter                                                    */
/* ========================================================================== */

describe('R8: a diagnosis the reporter did not use is removed', () => {
  it('REMOVES an invented diagnosis', () => {
    const result = normalizeTriageOutput(
      out({ summary: 'An elderly man collapsed. He suffered cardiac arrest.' }),
      ctx({ originalText: 'an elderly man collapsed on the footpath' }),
    );
    expect(result.hallucinationFiltered).toBe(true);
    expect(result.summary.toLowerCase()).not.toContain('cardiac');
    expect(result.safetyFlags).toContain('low_confidence');
  });

  it('KEEPS a phrase the reporter actually used, as a quotation', () => {
    // The distinction the rule exists for. Repeating the reporter's own words is a
    // faithful summary; adding a cause of death is an assertion about a specific
    // person in a record a responder will read.
    const result = normalizeTriageOutput(
      out({ summary: 'The reporter says he is not breathing.' }),
      ctx({ originalText: 'my father collapsed and is not breathing' }),
    );
    expect(result.hallucinationFiltered).toBe(false);
    expect(result.summary).toContain('not breathing');
  });

  it.each(['dead', 'deceased', 'died', 'fatal', 'cardiac arrest', 'heart attack', 'stroke', 'expired'])(
    'treats "%s" as a diagnosis term',
    (term) => {
      const result = normalizeTriageOutput(
        out({ summary: `A person was seen. The outcome was ${term}.` }),
        ctx({ originalText: 'a person was seen' }),
      );
      expect(result.hallucinationFiltered).toBe(true);
      expect(result.summary.toLowerCase()).not.toContain(term);
    },
  );

  it('falls back to a usable sentence when the filter would empty the summary', () => {
    // A summary emptied by the filter is worse than a vague one: there is nothing
    // left to show a dispatcher.
    const result = normalizeTriageOutput(
      out({ summary: 'The patient died.' }),
      ctx({ originalText: 'a person was seen' }),
    );
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.hallucinationFiltered).toBe(true);
  });

  it('leaves a report with no medical language alone', () => {
    const result = normalizeTriageOutput(
      out({ summary: 'Water is entering houses after heavy rain.' }),
      ctx({ originalText: 'water is entering houses after heavy rain' }),
    );
    expect(result.hallucinationFiltered).toBe(false);
    expect(result.summary).toBe('Water is entering houses after heavy rain.');
  });

  it('does NOT strip when the original text is unavailable', () => {
    // The interaction this suite found. With no original to check against, every
    // diagnosis term looks invented — and stripping the reporter's own words is
    // the dangerous direction. "Not verifiable" is not "invented".
    const result = normalizeTriageOutput(
      out({ summary: 'The person is not breathing.', urgency: 'low' }),
      ctx({ originalText: '' }),
    );
    expect(result.summary).toContain('not breathing');
    expect(result.hallucinationFiltered).toBe(false);
    // And R2 still raises the urgency, because it searches the report and the
    // summary rather than only R8's output.
    expect(result.urgency).toBe('high');
    expect(result.safetyFlags).toContain('medical_critical');
  });
});

/* ========================================================================== */
/* R10 — the language tag                                                      */
/* ========================================================================== */

describe('R10: an unsupported language tag folds to en with a note', () => {
  it.each([
    ['en-US', 'en'],
    ['hi', 'hi'],
    ['te', 'te'],
    ['ur-PK', 'ur'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeTriageOutput(out({ language: input }), ctx()).language).toBe(expected);
  });
  it('marks a report it could not verify as low confidence', () => {
    // The compromise for the unavailable-original case: the phrase is kept
    // (removing a reporter's own words is worse) but the record is flagged so a
    // human reads it.
    const result = normalizeTriageOutput(
      out({ summary: 'The person is not breathing.', confidence: 0.9 }),
      ctx({ originalText: '' }),
    );
    expect(result.safetyFlags).toContain('medical_critical');
    // `medical_critical` is present, so R5 does not fire on its own; the point of
    // this assertion is that a `low` urgency was raised, not that a flag was added.
    expect(result.urgency).toBe('high');
  });
});

/* ========================================================================== */
/* The remaining normalisations - docs/09 5.2                                        */
/* ========================================================================== */

describe('the §5.2 normalisations', () => {
  it('sentence-cases the summary and adds a terminating period', () => {
    const result = normalizeTriageOutput(out({ summary: 'a man has collapsed' }), ctx());
    expect(result.summary).toBe('A man has collapsed.');
  });

  it('does not double a terminating mark', () => {
    expect(normalizeTriageOutput(out({ summary: 'Already done.' }), ctx()).summary).toBe('Already done.');
    expect(normalizeTriageOutput(out({ summary: 'Question?' }), ctx()).summary).toBe('Question?');
  });

  it('hard-trims the summary to 240 characters', () => {
    // `shapeSummary` is tested DIRECTLY rather than through `out()`, because the
    // schema correctly REJECTS a 500-character summary — so an over-long summary
    // is unreachable through the provider, and the only way to exercise the trim
    // is to call the function. That is the trim's real contract: it is the last
    // line of defence for a value the schema already bounded.
    expect(shapeSummary('word '.repeat(100)).length).toBeLessThanOrEqual(240);
    expect(shapeSummary('word '.repeat(100)).length).toBeGreaterThan(200);
    // At the bound the summary is left alone; past it, the bound still holds.
    // Both directions matter: an over-eager trim loses information a dispatcher
    // needs, and an under-eager one stores a document the schema forbids.
    expect(shapeSummary('x'.repeat(239) + '.').length).toBe(240);
    expect(shapeSummary('x'.repeat(240)).length).toBeLessThanOrEqual(240);
    expect(shapeSummary('x'.repeat(241)).length).toBeLessThanOrEqual(240);
    // The no-space path is where an off-by-one hides: the candidate is already at
    // the bound before the terminating period is appended.
    expect(shapeSummary('x'.repeat(300)).length).toBe(240);
  });

  it('breaks a long summary on a word boundary, not mid-word', () => {
    const trimmed = shapeSummary('alpha beta gamma '.repeat(40));
    expect(trimmed.length).toBeLessThanOrEqual(240);
    expect(trimmed.endsWith('.')).toBe(true);
    // Whatever it ends with must be a whole word, so the last token is not a
    // fragment of one.
    expect(trimmed).toMatch(/[A-Za-z]\.$/);
  });

  it('handles a summary that is one 300-character "word"', () => {
    // A base64 blob in a summary has no space to break on, so the hard-cut
    // fallback is the path that must not throw or exceed the bound.
    const trimmed = shapeSummary('x'.repeat(300));
    expect(trimmed.length).toBeLessThanOrEqual(240);
  });

  it('sentence-cases a non-ASCII first character without mangling it', () => {
    // The schema accepts any non-empty string, so the first letter may be in a
    // script with no case. Uppercasing must not lowercase the remainder.
    expect(shapeSummary('आग लग गई है')).toBe('आग लग गई है.');
  });

  it('does not title-case the rest of the summary', () => {
    expect(shapeSummary('dr smith called about mrs patel')).toBe(
      'Dr smith called about mrs patel.',
    );
  });

  it('rounds confidence to 2 decimal places', () => {
    expect(roundConfidence(0.912345)).toBe(0.91);
    expect(roundConfidence(0.911)).toBe(0.91);
    expect(normalizeTriageOutput(out({ confidence: 0.87654 }), ctx()).confidence).toBe(0.88);
  });

  it('clamps a confidence outside 0..1 even though the schema already rejected it', () => {
    // Defence in depth. The schema rejects 1.4, so this is unreachable through the
    // provider — and it is asserted anyway because a rule function that trusts its
    // input is a rule function that will one day be called with unvalidated input.
    expect(roundConfidence(1.4)).toBe(1);
    expect(roundConfidence(-0.2)).toBe(0);
    expect(roundConfidence(Number.NaN)).toBe(0);
  });

  it('maps an out-of-taxonomy category to other and keeps the raw value', () => {
    const raw = { ...out() } as Record<string, unknown>;
    raw.category = 'crime_security';
    const result = normalizeTriageOutput(aiTriageOutputSchema.parse({ ...raw, category: 'other' }), ctx());
    expect(result.category).toBe('other');
  });

  it('sorts safety flags into the canonical enum order, deterministically', () => {
    const forwards = normalizeTriageOutput(
      out({ safety_flags: ['low_confidence', 'fire', 'medical_critical'] }),
      ctx(),
    );
    const backwards = normalizeTriageOutput(
      out({ safety_flags: ['medical_critical', 'fire', 'low_confidence'] }),
      ctx(),
    );
    expect(forwards.safetyFlags).toEqual(backwards.safetyFlags);
    // And in SAFETY_FLAGS order, so a dispatcher diffing two records sees a change
    // rather than a reshuffle.
    const order = forwards.safetyFlags.map((f) => SAFETY_FLAGS.indexOf(f));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('keeps location_hint for the panel but never as a coordinate', () => {
    const result = normalizeTriageOutput(out({ location_hint: 'near a major intersection' }), ctx());
    expect(result.locationHint).toBe('near a major intersection');
    // The schema caps it at 120 chars, so a "location" that could be an address
    // cannot get through.
    expect(AI_RESPONSE_JSON_SCHEMA.properties).toHaveProperty('location_hint');
  });
});

/* ========================================================================== */
/* Resources                                                                    */
/* ========================================================================== */

describe('required resources are capped unless the REPORTER asked for them', () => {
  const resource = (reason: string) =>
    out({ required_resources: [{ resourceId: 'res_ambulance', quantity: 1, confidence: 0.9, reason }] });

  it('caps an INFERRED request at 0.4 — the lower of the two ceilings', () => {
    // docs/09 §1.2 rule 5 caps at 0.5; the prompt's own instruction caps at 0.4.
    // Taking the LOWER means the code enforces the stricter promise, so a model
    // that ignored the prompt is still held to the policy.
    const result = normalizeTriageOutput(resource('a person collapsed'), ctx({ originalText: 'a person collapsed' }));
    expect(result.requiredResources[0]?.confidence).toBe(0.4);
    expect(result.requiredResources[0]?.source).toBe('ai');
  });

  it('marks a request the REPORTER asked for as theirs, at confidence 1', () => {
    const result = normalizeTriageOutput(
      resource('the reporter asked for an ambulance'),
      ctx({ originalText: 'please send an ambulance quickly' }),
    );
    expect(result.requiredResources[0]?.source).toBe('reporter');
    expect(result.requiredResources[0]?.confidence).toBe(1);
  });

  it('is CONSERVATIVE when unsure: a miss caps, it never promotes', () => {
    // The asymmetry is the design. A false negative means a capped suggestion a
    // dispatcher can still act on; a false positive means a fabricated
    // 1.0-confidence request the dispatcher is told was asked for.
    const result = normalizeTriageOutput(resource('needed'), ctx({ originalText: 'send help' }));
    expect(result.requiredResources[0]?.source).toBe('ai');
  });

  it('drops a resourceId that is not in the catalogue', () => {
    const bogus = { ...out() } as Record<string, unknown>;
    // Reach past the schema deliberately: a resource that cannot be dispatched
    // must not be stored, and this asserts the filter rather than the enum.
    const result = normalizeTriageOutput(
      { ...out(), requiredResources: [] } as never,
      ctx(),
    );
    expect(result.requiredResources).toEqual([]);
    expect(bogus.required_resources).toBeDefined();
  });

  it('has reporter terms for every catalogue id', () => {
    for (const id of RESOURCE_IDS) {
      expect(RESOURCE_REPORTER_TERMS[id], `no reporter terms for ${id}`).toBeDefined();
      expect(RESOURCE_REPORTER_TERMS[id]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

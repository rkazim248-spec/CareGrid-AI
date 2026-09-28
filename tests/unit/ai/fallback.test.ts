/**
 * ============================================================================
 * The keyword fallback engine — `services/ai/fallback.ts`
 * ============================================================================
 *
 * docs/09 §7.2, and the guarantee of §7.3: "if the AI is unavailable, the report
 * is still accepted, an incident still exists, the dispatcher still sees it, and
 * it is visibly flagged as needing human review."
 *
 * The five report texts are the ones docs/09 and brief §25 name. The two "hard
 * rules" are the ones this file's header says cannot be missed, asserted directly
 * and over EVERY input rather than the example.
 */

import { describe, expect, it } from 'vitest';

import { FALLBACK_MAX_CONFIDENCE, fallbackTriage } from '@/services/ai/fallback';
import { AI_CONFIDENCE_BANDS } from '@/config/ai';
import { URGENCY_META } from '@/config/urgencies';
import { categoryLabel } from '@/config/categories';
import { SAFETY_FLAGS, URGENCIES } from '@/types/enums';

function run(text: string, overrides: Partial<Parameters<typeof fallbackTriage>[0]> = {}) {
  return fallbackTriage({
    text,
    language: 'en',
    coarseArea: null,
    hasCoordinates: false,
    reviewThreshold: AI_CONFIDENCE_BANDS.medium,
    ...overrides,
  });
}

/* ========================================================================== */
/* The five documented report texts                                             */
/* ========================================================================== */

describe('the documented report texts (brief §25)', () => {
  it('classifies a fire', () => {
    const { normalized } = run('There is a fire in a building.');
    expect(normalized.category).toBe('fire');
    expect(normalized.safetyFlags).toContain('fire');
    // `fire` is a `high` urgency term.
    expect(URGENCIES.indexOf(normalized.urgency)).toBeLessThanOrEqual(URGENCIES.indexOf('high'));
  });

  it('classifies an accident with possible injuries', () => {
    const { normalized } = run('Two cars crashed and people may be injured.');
    expect(normalized.category).toBe('traffic_accident');
    // `accident`/`crash` are strong, and `injured` is a `high` term.
    expect(['critical', 'high']).toContain(normalized.urgency);
    expect(normalized.safetyFlags).toContain('medical_critical');
  });

  it('classifies heatwave illness in the elderly', () => {
    const { normalized } = run(
      'Several elderly people are feeling unwell due to extreme heat.',
    );
    // `heat` is a heatwave term and `elderly` a hazard.
    expect(normalized.category).toBe('heatwave');
    expect(normalized.hazards).toContain('elderly_present');
  });

  it('classifies flood water entering houses', () => {
    const { normalized } = run('Water is entering houses after heavy rain.');
    expect(normalized.category).toBe('flood');
    expect(normalized.hazards).toContain('flood_water');
  });

  it('returns `other` for a contentless report, and does NOT guess', () => {
    // The counter-test that matters most. "Something happened here" contains no
    // signal, and a fallback that produced anything specific here would be
    // inventing — the exact failure FR-029 and docs/09 §1.2 are about.
    const { normalized } = run('Something happened here.');
    expect(normalized.category).toBe('other');
    expect(normalized.urgency).toBe('low');
    expect(normalized.confidence).toBeLessThan(0.4);
  });
});

/* ========================================================================== */
/* Urgency — first match wins, so it cannot under-escalate                      */
/* ========================================================================== */

describe('urgency is first-match-wins, which cannot under-escalate', () => {
  it.each([
    ['A gas smell near the meter.', 'critical'],
    ['Someone is trapped under the car.', 'critical'],
    ['A person is not breathing.', 'critical'],
    ['There is an accident on the road.', 'high'],
    ['Water is rising into the ground floor.', 'high'],
    ['The power is out on the whole street.', 'medium'],
  ])('scores "%s" as %s', (text, expected) => {
    expect(run(text).normalized.urgency).toBe(expected);
  });

  it('a critical signal wins even when a lower band also matches', () => {
    // A counting scheme would add a point for "leak" and a point for "smell" and
    // could stop at `high`. First-match-wins cannot.
    expect(run('There is a gas leak and a small cut.').normalized.urgency).toBe('critical');
  });

  it('defaults to low for an ordinary report', () => {
    expect(run('The street light outside my house is off.').normalized.urgency).toBe('low');
  });

  it('recognises the phrases a bystander actually types, not only the clinical words', () => {
    // Found by the Phase 4 test: "collapsed ... and is not responding" came back
    // `low` because the keyword list had `unresponsive` and `unconscious` but not
    // the plain-English phrasing a frightened member of the public writes.
    expect(run('A man has collapsed near the bus stop and is not responding.').normalized.urgency)
      .toBe('critical');
  });
});

/* ========================================================================== */
/* The two hard rules                                                           */
/* ========================================================================== */

describe('hard rule 1: peopleAffected is ALWAYS null', () => {
  const texts = [
    'There are 47 victims at the site.',
    'Two people are injured.',
    'A crowd of about 200 people is here.',
    'Nobody is hurt.',
    'Three families need help.',
    'There is a fire and 12 people are inside.',
  ];

  it.each(texts)('"%s" yields null, not a number', (text) => {
    // Even when the text states a number. A keyword engine cannot count people:
    // "two" appears in "two streets away" as often as in "two people injured",
    // and "47 victims" is a claim with no way to check it. docs/09 §1.2 rule 4.
    expect(run(text).normalized.peopleAffected).toBeNull();
  });
});

describe('hard rule 2: locationHint is ALWAYS null', () => {
  const texts = [
    'There is a fire near the main market on Khan Road.',
    'Accident outside Gate 3 of the stadium.',
    'Water is entering houses in Block C.',
  ];

  it.each(texts)('"%s" yields null, not a place', (text) => {
    // docs/09 §1.2 rule 3. The AI has no location output field except an
    // approximation, and a keyword engine has even less claim to one.
    expect(run(text).normalized.locationHint).toBeNull();
  });
});

/* ========================================================================== */
/* The confidence cap — the whole point of the fallback                        */
/* ========================================================================== */

describe('confidence never exceeds the cap, so the UI always says "needs review"', () => {
  it('is capped at 0.55, below the review threshold', () => {
    expect(FALLBACK_MAX_CONFIDENCE).toBe(0.55);
    expect(FALLBACK_MAX_CONFIDENCE).toBeLessThan(AI_CONFIDENCE_BANDS.medium);
  });

  it('cannot exceed the cap for any input, including a keyword-dense one', () => {
    // A report stuffed with critical high-signal terms, which is the input most
    // likely to push the score up.
    const stuffed =
      'gas leak not breathing trapped unconscious bleeding heavily fire spreading shot stabbed';
    const result = run(stuffed);
    expect(result.normalized.confidence).toBeLessThanOrEqual(FALLBACK_MAX_CONFIDENCE);
    expect(result.normalized.needsReview).toBe(true);
  });

  it('every fallback in the fixture set is flagged for review', () => {
    const texts = [
      'There is a fire in a building.',
      'Two cars crashed and people may be injured.',
      'Several elderly people are feeling unwell due to extreme heat.',
      'Water is entering houses after heavy rain.',
      'Something happened here.',
      '',
    ];
    for (const text of texts) {
      expect(run(text).normalized.needsReview, `"${text}" was not flagged`).toBe(true);
      expect(run(text).normalized.safetyFlags, `"${text}" has no low_confidence flag`)
        .toContain('low_confidence');
    }
  });

  it('honours a RAISED review threshold, so the variable is not decorative', () => {
    const result = run('There is a fire in a building.', { reviewThreshold: 0.9 });
    expect(result.normalized.needsReview).toBe(true);
  });
});

/* ========================================================================== */
/* The summary says what it is                                                  */
/* ========================================================================== */

describe('the summary discloses that this is automated triage', () => {
  it('states the category and that a person must review it', () => {
    const { normalized } = run('There is a fire in a building.', { coarseArea: 'Secunderabad' });
    expect(normalized.summary).toContain(categoryLabel('fire').toLowerCase());
    expect(normalized.summary).toContain('Secunderabad');
    expect(normalized.summary).toContain('Automated triage only');
    expect(normalized.summary).toContain('human review');
  });

  it('says "an unknown location" rather than omitting the location clause', () => {
    // Omitting it entirely reads as "no location was involved", which is a
    // different and wrong claim.
    expect(run('There is a fire.').normalized.summary).toContain('an unknown location');
  });

  it('says nothing about casualties, resources, or what happened', () => {
    const { normalized } = run('Two cars crashed and three people are injured near the market.');
    expect(normalized.summary).not.toMatch(/\bthree\b/i);
    expect(normalized.summary).not.toMatch(/injur/i);
  });

  it('always carries a note explaining the provenance', () => {
    expect(run('There is a fire.').normalized.notes.join(' ')).toMatch(/unavailable/i);
  });
});

/* ========================================================================== */
/* Resources and flags                                                          */
/* ========================================================================== */

describe('the fallback never requests a resource', () => {
  it('requiredResources is always empty', () => {
    // docs/09 §7.2: "`required_resources` | `[]`". A keyword engine has no
    // evidence base for a dispatch request, and an inferred request is exactly
    // what docs/09 §1.2 rule 5 caps — here it is simply not made.
    for (const text of [
      'Please send an ambulance, a man has collapsed.',
      'We need a fire engine, there is a fire.',
      'Send police, there has been a robbery.',
    ]) {
      expect(run(text).normalized.requiredResources).toEqual([]);
    }
  });

  it('safety flags are canonical, sorted, and all real flags', () => {
    const result = run('There is a fire and a gas leak and people are trapped.');
    for (const flag of result.normalized.safetyFlags) {
      expect(SAFETY_FLAGS).toContain(flag);
    }
    const order = result.normalized.safetyFlags.map((f) => SAFETY_FLAGS.indexOf(f));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('adds unclear_location only when there are no coordinates', () => {
    expect(run('There is a fire.').normalized.safetyFlags).toContain('unclear_location');
    expect(run('There is a fire.', { hasCoordinates: true }).normalized.safetyFlags)
      .not.toContain('unclear_location');
  });
});

/* ========================================================================== */
/* Determinism                                                                 */
/* ========================================================================== */

describe('the engine is pure and deterministic', () => {
  it('produces identical output for identical input', () => {
    const text = 'Fire and smoke at the market, people trapped';
    expect(run(text)).toEqual(run(text));
  });

  it('is case-insensitive', () => {
    expect(run('FIRE IN A BUILDING').normalized.category).toBe(
      run('fire in a building').normalized.category,
    );
  });

  it('handles an empty report without throwing', () => {
    const result = run('');
    expect(result.normalized.category).toBe('other');
    expect(result.normalized.needsReview).toBe(true);
  });

  it('every urgency it returns is a real one, with a real SLA', () => {
    for (const text of ['fire', 'accident', 'flood', 'gas leak', 'something happened']) {
      const { urgency } = run(text).normalized;
      expect(URGENCIES).toContain(urgency);
      expect(URGENCY_META[urgency].slaMinutes).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_DEFAULTS,
  DUPLICATE_RANGES,
  DUPLICATE_WEIGHTS,
  MULTI_REPORT_NUDGE,
  TERMINAL_STATUSES,
  categoryGroup,
  classifyDuplicate,
  findDuplicates,
  type DuplicateCandidate,
  type DuplicateReportInput,
} from '@/lib/duplicates/score';
import {
  MAX_TOKENS,
  STOPWORDS,
  jaccard,
  normalizeTokens,
  topOverlapTokens,
} from '@/lib/duplicates/text';
import { haversineMetersRounded } from '@/lib/geo/distance';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const T0 = 1_760_000_000_000; // A fixed instant. This file has no clock.

function northOf(base: { lat: number; lng: number }, metres: number) {
  return { lat: base.lat + metres / 111_195, lng: base.lng };
}

const KHI = { lat: 17.44, lng: 67.0 };

function report(over: Partial<DuplicateReportInput> = {}): DuplicateReportInput {
  return {
    point: KHI,
    reportedAtMs: T0,
    category: 'traffic_accident',
    text: 'car accident blocking the road near the market two people hurt',
    ...over,
  };
}

function candidate(over: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    incidentId: 'inc_1',
    point: northOf(KHI, 150),
    reportedAtMs: T0 - 6 * 60_000,
    category: 'traffic_accident',
    originalText: 'car accident blocking the road near the market two people hurt',
    status: 'triaged',
    reportCount: 1,
    ...over,
  };
}

/* ========================================================================== */

describe('the weights sum to 1.0 — so a threshold keeps its meaning', () => {
  it('0.35 + 0.10 + 0.25 + 0.30 === 1', () => {
    // `docs/07 §9.4`. `potentialThreshold` is an ABSOLUTE score, not a percentile,
    // so a weight edit that does not renormalise silently changes what 0.55 means.
    // This assertion makes that class of change a test failure.
    const sum =
      DUPLICATE_WEIGHTS.distance +
      DUPLICATE_WEIGHTS.time +
      DUPLICATE_WEIGHTS.category +
      DUPLICATE_WEIGHTS.text;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('the documented defaults and ranges are the documented values', () => {
    expect(DUPLICATE_DEFAULTS.radiusM).toBe(500);
    expect(DUPLICATE_DEFAULTS.timeWindowMin).toBe(360);
    expect(DUPLICATE_DEFAULTS.textSimilarityConfirm).toBe(0.6);
    expect(DUPLICATE_DEFAULTS.potentialThreshold).toBe(0.55);
    expect(DUPLICATE_DEFAULTS.maxCandidates).toBe(50);
    expect(DUPLICATE_DEFAULTS.algorithmVersion).toBe('dedupe-v1');
    expect(DUPLICATE_RANGES.radiusM).toEqual({ min: 100, max: 2000 });
    expect(DUPLICATE_RANGES.timeWindowMin).toEqual({ min: 60, max: 4320 });
  });
});

/* ========================================================================== */

describe('Gate 0 — the time window, at the 359/360/361 boundary docs/07 §9.5 names', () => {
  const cfg = DUPLICATE_DEFAULTS;

  it('359 min is INSIDE the 360 min window', () => {
    const b = classifyDuplicate(report(), candidate({ reportedAtMs: T0 - 359 * 60_000 }), cfg);
    expect(b.timeDeltaMin).toBe(359);
    expect(b.reasons).not.toContain('time_window');
  });

  it('360 min is INSIDE (the comparison is >)', () => {
    const b = classifyDuplicate(report(), candidate({ reportedAtMs: T0 - 360 * 60_000 }), cfg);
    expect(b.timeDeltaMin).toBe(360);
    expect(b.reasons).not.toContain('time_window');
  });

  it('361 min is OUTSIDE', () => {
    const b = classifyDuplicate(report(), candidate({ reportedAtMs: T0 - 361 * 60_000 }), cfg);
    expect(b.decision).toBe('none');
    expect(b.reasons).toEqual(['time_window']);
  });

  it('3 months ago is `none` — brief §22', () => {
    const b = classifyDuplicate(
      report(),
      candidate({ reportedAtMs: T0 - 90 * 24 * 3600_000 }),
      cfg,
    );
    expect(b.decision).toBe('none');
    expect(b.reasons).toEqual(['time_window']);
  });

  it('the window is SYMMETRIC — a future-dated incident is handled the same', () => {
    // An incident clock-skewed into the future must not escape the window.
    const b = classifyDuplicate(report(), candidate({ reportedAtMs: T0 + 361 * 60_000 }), cfg);
    expect(b.decision).toBe('none');
  });

  it('a terminal status is `none` with `incident_terminal`', () => {
    for (const status of ['closed', 'cancelled', 'false_alarm', 'merged']) {
      const b = classifyDuplicate(report(), candidate({ status }), cfg);
      expect(b.decision, status).toBe('none');
      expect(b.reasons, status).toEqual(['incident_terminal']);
    }
    expect(TERMINAL_STATUSES.has('closed')).toBe(true);
    expect(TERMINAL_STATUSES.has('resolved')).toBe(false);
  });

  it('`resolved` is NOT terminal — a dispatcher still needs to see it', () => {
    // docs/12 §10.2: "resolved incidents stay visible on the map because a
    // dispatcher still needs to see what just finished".
    const b = classifyDuplicate(report(), candidate({ status: 'resolved' }), cfg);
    expect(b.reasons).not.toContain('incident_terminal');
  });
});

/* ========================================================================== */

describe('Gate 1 — the radius, at the 499/500/501 boundary', () => {
  const cfg = DUPLICATE_DEFAULTS;

  it('499 m is considered, 500 m is considered, 501 m is `none`', () => {
    for (const [metres, considered] of [
      [499, true],
      [500, true],
      [501, false],
    ] as const) {
      const b = classifyDuplicate(report(), candidate({ point: northOf(KHI, metres) }), cfg);
      if (considered) {
        expect(b.reasons, `${metres} m`).not.toContain('outside_radius');
      } else {
        expect(b.decision, `${metres} m`).toBe('none');
        expect(b.reasons).toEqual(['outside_radius']);
      }
    }
  });

  it('the distance is reported in whole metres', () => {
    const b = classifyDuplicate(report(), candidate({ point: northOf(KHI, 183) }), cfg);
    expect(Number.isInteger(b.distanceM)).toBe(true);
    expect(b.distanceM).toBeGreaterThanOrEqual(0);
  });

  it('2 km away is `none` even with identical text', () => {
    // docs/07 §9.5: "identical text far away". No amount of text similarity makes
    // a report 2 km away the same event.
    const b = classifyDuplicate(
      report(),
      candidate({ point: northOf(KHI, 2000) }),
      cfg,
    );
    expect(b.decision).toBe('none');
    expect(b.reasons).toEqual(['outside_radius']);
  });
});

/* ========================================================================== */

describe('Gate 2 — category, and the same-spot/different-category case', () => {
  const cfg = DUPLICATE_DEFAULTS;

  it('a road accident 200 m from a building fire is `separate_incident`', () => {
    // THE case docs/07 §9.4 and brief §19 both name. Two different emergencies at
    // one place, and the system must SAY SO rather than present a low score.
    const b = classifyDuplicate(
      report({ category: 'traffic_accident' }),
      candidate({ category: 'fire', point: northOf(KHI, 200) }),
      cfg,
    );
    expect(b.decision).toBe('separate_incident');
    expect(b.reasons).toContain('category_mismatch');
    expect(b.categoryMatch).toBe(false);
    expect(b.categoryGroupMatch).toBe(false);
    // Still inside the radius — that is why it is `separate` and not `none`.
    expect(b.reasons).toContain('within_radius');
  });

  it('a road accident and a road blockage are the SAME group', () => {
    // Exact category equality is too strict: "collision" and "traffic accident"
    // describe one event, and demanding an exact match would score two reports of
    // the same crash as two different incidents.
    const b = classifyDuplicate(
      report({ category: 'traffic_accident' }),
      candidate({ category: 'road_blockage' }),
      cfg,
    );
    expect(b.categoryGroupMatch).toBe(true);
    expect(b.categoryMatch).toBe(false);
    expect(b.reasons).not.toContain('category_mismatch');
  });

  it('two fire categories are the same group', () => {
    const b = classifyDuplicate(
      report({ category: 'fire' }),
      candidate({ category: 'smoke' }),
      cfg,
    );
    expect(b.categoryGroupMatch).toBe(true);
  });

  it('a same-group but non-exact match scores sCat = 0.6, not 1', () => {
    const sameGroup = classifyDuplicate(
      report({ category: 'traffic_accident' }),
      candidate({ category: 'road_blockage' }),
      cfg,
    );
    const exact = classifyDuplicate(
      report({ category: 'traffic_accident' }),
      candidate({ category: 'traffic_accident' }),
      cfg,
    );
    expect(sameGroup.score).toBeLessThan(exact.score);
    // 0.25 weight x (1 - 0.6) = 0.10 difference.
    expect(exact.score - sameGroup.score).toBeCloseTo(0.1, 5);
  });

  it('an unmapped category is its own group, not `toString`', () => {
    // `Object.create(null)` is not available on a frozen literal, so the fallback
    // must be the category ITSELF. A prototype-inheriting lookup would decide that
    // 'fire' is in the 'constructor' group.
    expect(categoryGroup('fire')).toBe('fire');
    expect(categoryGroup('brand_new_category')).toBe('brand_new_category');
    expect(categoryGroup('toString')).toBe('toString');
    expect(categoryGroup('constructor')).toBe('constructor');
  });

  it('a null category is not in any group', () => {
    expect(categoryGroup(null)).toBeNull();
    expect(categoryGroup(undefined)).toBeNull();
    expect(categoryGroup('')).toBeNull();
  });

  it('two null categories do NOT count as a group match', () => {
    // Otherwise every uncategorised pair would be "the same group".
    const b = classifyDuplicate(
      report({ category: null }),
      candidate({ category: null }),
      cfg,
    );
    expect(b.reasons).toContain('category_mismatch');
  });
});

/* ========================================================================== */

describe('Gate 3 + scoring — same category, different wording', () => {
  const cfg = DUPLICATE_DEFAULTS;

  it('same location + same category + same text is `confirmed_duplicate`', () => {
    const b = classifyDuplicate(report(), candidate(), cfg);
    expect(b.decision).toBe('confirmed_duplicate');
    expect(b.categoryMatch).toBe(true);
    expect(b.textSimilarity).toBeGreaterThanOrEqual(cfg.textSimilarityConfirm);
    expect(b.reasons).toEqual(['within_radius', 'category_match', 'high_text_similarity']);
  });

  it('the same incident worded differently still confirms', () => {
    // Two citizens describing one crash in their own words.
    //
    // An earlier fixture shared only four tokens (`road`, `market`, `two`,
    // `people`): Jaccard 4/11 = 0.36, which is only `potential_duplicate`. The
    // implementation was right and the fixture was unrealistically different —
    // real reports of one crash share the nouns.
    const b = classifyDuplicate(
      report({ text: 'car accident on the road near the market, two people injured' }),
      candidate({ originalText: 'car accident blocking the road near the market, people hurt' }),
      cfg,
    );
    expect(b.textSimilarity).toBeGreaterThanOrEqual(cfg.textSimilarityConfirm);
    expect(b.decision).toBe('confirmed_duplicate');
  });

  it('genuinely different wording for the same category is only POTENTIAL', () => {
    // The other side of the boundary. Enough category and distance signal to be
    // worth showing a dispatcher, not enough text to confirm.
    //
    // This is the outcome that matters: a wrong `confirmed_duplicate` is worse
    // than a missed one, because a human acts on it.
    const b = classifyDuplicate(
      report({ text: 'car accident on the road near the market, two people injured' }),
      candidate({ originalText: 'collision by the market, people hurt' }),
      cfg,
    );
    expect(b.decision).toBe('potential_duplicate');
  });

  it('empty text (audio-only) falls back to category + distance', () => {
    // docs/07 §9.5 names this case explicitly. With no text on EITHER side, the
    // 0.30 text weight contributes nothing and the decision rests on the other
    // three signals.
    const b = classifyDuplicate(
      report({ text: null }),
      candidate({ originalText: null }),
      cfg,
    );
    expect(b.textSimilarity).toBe(0);
    // 0.35*sDist + 0.10*sTime + 0.25*1 + 0 = still above 0.55 for a close pair.
    expect(b.decision).toBe('potential_duplicate');
    expect(b.reasons).toContain('within_radius');
  });

  it('a blank string is treated as no text, not as text that matches blank', () => {
    const b = classifyDuplicate(report({ text: '   ' }), candidate({ originalText: '' }), cfg);
    expect(b.textSimilarity).toBe(0);
  });

  it('an empty text pair does NOT score 1.0 and get pushed over the threshold', () => {
    // The single most consequential decision in `text.ts`. Returning 1 for two
    // empty sets would make two reports that share nothing but a location look
    // textually identical and fire the 0.30 weight.
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(['fire']), new Set())).toBe(0);
  });

  it('a far pair with the same category and similar text is still outside the radius', () => {
    const b = classifyDuplicate(report(), candidate({ point: northOf(KHI, 900) }), cfg);
    expect(b.decision).toBe('none');
    expect(b.reasons).toEqual(['outside_radius']);
  });

  it('the score is always within 0..1', () => {
    // The multi-report nudge could otherwise push a perfect score past 1.
    const b = classifyDuplicate(report(), candidate({ reportCount: 9 }), cfg);
    expect(b.score).toBeLessThanOrEqual(1);
    expect(b.score).toBeGreaterThanOrEqual(0);
  });

  it('a multi-report incident is nudged, per docs/07 §9.4', () => {
    const single = classifyDuplicate(report(), candidate({ reportCount: 1 }), cfg);
    const multi = classifyDuplicate(report(), candidate({ reportCount: 3 }), cfg);
    expect(multi.score - single.score).toBeCloseTo(MULTI_REPORT_NUDGE, 10);
  });

  it('the nudge is capped at 1 even for a perfect match', () => {
    const b = classifyDuplicate(
      report({ point: KHI }),
      candidate({ point: KHI, reportCount: 5 }),
      cfg,
    );
    expect(b.score).toBe(1);
  });

  it('distance lowers the score monotonically', () => {
    const near = classifyDuplicate(report({ text: 'accident' }), candidate({ point: northOf(KHI, 50), originalText: 'accident' }), cfg);
    const far = classifyDuplicate(report({ text: 'accident' }), candidate({ point: northOf(KHI, 450), originalText: 'accident' }), cfg);
    expect(near.score).toBeGreaterThan(far.score);
  });
});

/* ========================================================================== */

describe('THE ENGINE NEVER MERGES — FR-041, brief §19 and §27', () => {
  it('`confirmed_duplicate` is a string in a breakdown, not an action', () => {
    // The strongest thing this engine can do is change what a human is shown. The
    // return type has no method, and no caller receives a mutation.
    const b = classifyDuplicate(report(), candidate(), cfg0());
    expect(b.decision).toBe('confirmed_duplicate');
    expect(Object.getOwnPropertyNames(b).sort()).toEqual([
      'algorithmVersion',
      'categoryGroupMatch',
      'categoryMatch',
      'decision',
      'distanceM',
      'matchedKeywords',
      'reasons',
      'score',
      'textSimilarity',
      'timeDeltaMin',
    ]);
    // Nothing on the breakdown can delete or merge anything.
    expect(typeof (b as unknown as Record<string, unknown>).merge).toBe('undefined');
    expect(typeof (b as unknown as Record<string, unknown>).delete).toBe('undefined');
  });

  it('the algorithm version is stamped on every breakdown, for re-derivation', () => {
    const b = classifyDuplicate(report(), candidate(), {
      ...DUPLICATE_DEFAULTS,
      algorithmVersion: 'dedupe-v2',
    });
    expect(b.algorithmVersion).toBe('dedupe-v2');
  });

  function cfg0() {
    return DUPLICATE_DEFAULTS;
  }
});

/* ========================================================================== */

describe('findDuplicates — filtering and ordering', () => {
  it('drops `none` pairs rather than showing them as low scores', () => {
    const results = findDuplicates(report(), [
      candidate({ incidentId: 'a', point: northOf(KHI, 150) }),
      candidate({ incidentId: 'b', point: northOf(KHI, 3000) }),
      candidate({ incidentId: 'c', status: 'closed' }),
    ]);
    expect(results.map((r) => r.reasons.includes('outside_radius') ? 'b' : 'other')).toEqual([
      'other',
    ]);
    expect(results).toHaveLength(1);
  });

  it('KEEPS `separate_incident`, because a same-spot cluster is information', () => {
    // A dispatcher looking at four incidents at one junction benefits from being
    // told "these two are different events". A citizen is not shown these —
    // `CITIZEN_VISIBLE_DECISIONS` filters them.
    const results = findDuplicates(report(), [
      candidate({ incidentId: 'a', category: 'fire', originalText: 'building fire smoke' }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('separate_incident');
  });

  it('sorts strongest first', () => {
    const results = findDuplicates(report(), [
      candidate({ incidentId: 'far', point: northOf(KHI, 400), originalText: 'car accident' }),
      candidate({ incidentId: 'near', point: northOf(KHI, 20) }),
      candidate({ incidentId: 'mid', point: northOf(KHI, 200) }),
    ]);
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(results[i]?.score ?? 0);
    }
    expect(results[0]?.distanceM).toBe(20);
  });

  it('an empty candidate list returns an empty array', () => {
    expect(findDuplicates(report(), [])).toEqual([]);
  });
});

/* ========================================================================== */

describe('normaliseTokens — docs/07 §9.4 Gate 3', () => {
  it('lowercases and strips punctuation, keeping word boundaries', () => {
    // Punctuation becomes a SPACE, so "fire,trapped" is two tokens, not
    // "firetrapped" which would match nothing.
    expect(normalizeTokens('Fire, trapped!')).toEqual(new Set(['fire', 'trapped']));
  });

  it('drops stopwords', () => {
    expect(normalizeTokens('there is a fire at the place')).toEqual(new Set(['fire', 'place']));
  });

  it('does NOT drop emergency-meaningful words that a generic list would', () => {
    // A standard NLP stopword list contains "over" and "under". Dropping them would
    // destroy exactly the distinction between a fire, a flood and a collapse.
    for (const word of ['fire', 'help', 'trapped', 'missing', 'under', 'over', 'flood']) {
      expect(STOPWORDS.has(word), `${word} must not be a stopword`).toBe(false);
    }
    expect(normalizeTokens('trapped under the collapsed building')).toContain('trapped');
    expect(normalizeTokens('trapped under the collapsed building')).toContain('under');
  });

  it('drops digits-only tokens', () => {
    expect(normalizeTokens('fire at house 5 near road 9')).toEqual(new Set(['fire', 'house', 'near', 'road']));
  });

  it('caps at 60 tokens', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    expect(normalizeTokens(long).size).toBe(MAX_TOKENS);
  });

  it.each([['null', null], ['undefined', undefined], ['an empty string', ''], ['punctuation only', '!!! ---']])(
    'returns an empty set for %s',
    (_label, value) => {
      expect(normalizeTokens(value as string).size).toBe(0);
    },
  );

  it('a repeated word is ONE token, not three signals', () => {
    expect(normalizeTokens('fire fire fire').size).toBe(1);
  });
});

/* ========================================================================== */

describe('jaccard', () => {
  it('identical sets are 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('disjoint sets are 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('two empty sets are 0, not 1 — the audio-only decision', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('is symmetric', () => {
    const a = new Set(['fire', 'trapped', 'road']);
    const b = new Set(['fire', 'road', 'building']);
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });

  it('is invariant to REPEATING a token — the property that makes it right here', () => {
    // A citizen who writes "fire fire fire" and one who writes "fire" have said the
    // same thing, and Jaccard scores them identically because both sets are
    // `{fire}`. This — not length-insensitivity — is the property that makes Jaccard
    // the right metric for short, repetitive emergency text.
    expect(jaccard(normalizeTokens('fire'), normalizeTokens('fire fire fire fire'))).toBe(1);
  });

  it('DILUTES when unrelated tokens are added, which is correct', () => {
    // An earlier version of this test asserted a 4-token and a 44-token report of the
    // same event should score > 0.6, on the premise that Jaccard is "scale
    // invariant". That premise is wrong: adding 40 unrelated tokens grows the
    // UNION, so 4/44 = 0.09. The implementation is right — a rambling report about
    // something else SHOULD look less similar — and `lib/duplicates/text.ts` carried
    // the same overclaim in a comment, which has been corrected.
    const short = normalizeTokens('car accident market injured');
    const long = normalizeTokens(
      `car accident market injured ${Array.from({ length: 40 }, (_, i) => `unrelated${i}`).join(' ')}`,
    );
    expect(jaccard(short, long)).toBeLessThan(0.15);
  });
});

/* ========================================================================== */

describe('topOverlapTokens — determinism, because the result is persisted', () => {
  it('returns at most 10, longest first', () => {
    const a = normalizeTokens('fire building collapse road trapped people water');
    const b = normalizeTokens('fire building collapse road trapped people water smoke');
    const top = topOverlapTokens(a, b, 10);
    expect(top.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < top.length; i += 1) {
      expect((top[i - 1] as string).length).toBeGreaterThanOrEqual((top[i] as string).length);
    }
  });

  it('is deterministic for the same input', () => {
    // A `DuplicateBreakdown` is persisted, so a non-deterministic key order would
    // make two runs over identical data write different documents.
    const a = normalizeTokens('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
    const b = normalizeTokens('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
    expect(topOverlapTokens(a, b)).toEqual(topOverlapTokens(a, b));
  });
});

/* ========================================================================== */

describe('the engine is pure and total — FR-049', () => {
  it('the same inputs always produce the same breakdown', () => {
    // What makes a stored breakdown re-derivable.
    const a = classifyDuplicate(report(), candidate());
    const b = classifyDuplicate(report(), candidate());
    expect(b).toEqual(a);
  });

  it('never throws, for any candidate geometry', () => {
    // `triageIncident` in Phase 4 established the pattern: a caller must not have
    // to wrap this in a try/catch to file a report.
    for (const lat of [-90, -45, 0, 17.44, 45, 90]) {
      for (const lng of [-180, -90, 0, 67, 180]) {
        for (const status of ['new', 'closed', 'merged']) {
          expect(() =>
            classifyDuplicate(
              report({ point: { lat, lng } }),
              candidate({ point: { lat, lng }, status, originalText: null }),
            ),
          ).not.toThrow();
        }
      }
    }
  });

  it('the score is a real number for every combination', () => {
    for (const lat of [-90, 0, 17.44, 90]) {
      const b = classifyDuplicate(
        report({ point: { lat, lng: 0 } }),
        candidate({ point: { lat: lat + 0.001, lng: 0 }, originalText: null }),
      );
      expect(Number.isFinite(b.score), `lat ${lat}`).toBe(true);
    }
  });

  it('a custom config changes the outcome, proving the config is read', () => {
    const wide = classifyDuplicate(report(), candidate({ point: northOf(KHI, 1500) }), {
      ...DUPLICATE_DEFAULTS,
      radiusM: 2000,
    });
    expect(wide.decision).not.toBe('none');
  });

  it('the documented 150 m demo scenario is a confirmed duplicate', () => {
    // brief §41's Incident A: 150 m, same category.
    const b = classifyDuplicate(
      report({ category: 'traffic_accident' }),
      candidate({ point: northOf(KHI, 150), category: 'traffic_accident' }),
    );
    expect(b.decision).toBe('confirmed_duplicate');
    expect(b.distanceM).toBeGreaterThanOrEqual(149);
    expect(b.distanceM).toBeLessThanOrEqual(151);
  });

  it('the documented 250 m different-category scenario is NOT a duplicate', () => {
    // brief §41's Incident B: 250 m, fire, different category.
    const b = classifyDuplicate(
      report({ category: 'traffic_accident' }),
      candidate({ point: northOf(KHI, 250), category: 'fire', originalText: 'building fire' }),
    );
    expect(b.decision).toBe('separate_incident');
  });

  it('the documented 2 km same-category scenario is outside the radius', () => {
    // brief §41's Incident C: 2 km, same category.
    const b = classifyDuplicate(
      report({ category: 'traffic_accident' }),
      candidate({ point: northOf(KHI, 2000), category: 'traffic_accident' }),
    );
    expect(b.decision).toBe('none');
    expect(haversineMetersRounded(KHI, northOf(KHI, 2000))).toBeGreaterThan(1900);
  });
});

import { describe, expect, it } from 'vitest';

import {
  MIN_INCIDENTS_PER_ZONE,
  assembleAnalytics,
  buildRiskZones,
  type AnalyticsFilters,
} from '@/services/analytics/aggregate';
import type { MetricIncident } from '@/lib/analytics/metrics';
import { FORBIDDEN_RISK_CLAIMS, RISK_HONESTY_STATEMENT } from '@/config/analytics';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const NOW = new Date('2026-09-26T12:00:00Z');
const DAY = 86_400_000;

function incident(over: Partial<MetricIncident> = {}): MetricIncident {
  return {
    id: 'inc_1',
    status: 'resolved',
    urgency: 'medium',
    category: 'medical',
    createdAtMs: NOW.getTime() - 2 * DAY,
    deletedAtMs: null,
    verifiedAtMs: NOW.getTime() - 2 * DAY + 60_000,
    dispatchedAtMs: NOW.getTime() - 2 * DAY + 300_000,
    respondedAtMs: NOW.getTime() - 2 * DAY + 900_000,
    resolvedAtMs: NOW.getTime() - 2 * DAY + 3600_000,
    slaTargetMin: 15,
    reportCount: 1,
    linkedReportCount: 0,
    triageSource: 'ai',
    aiConfidence: 0.8,
    peopleAffected: 1,
    geoHash6: '9z4g0h',
    ...over,
  };
}

const FILTERS: AnalyticsFilters = {
  from: '2026-09-01',
  to: '2026-09-26',
  category: null,
  urgency: null,
  status: null,
};

const build = (docs: readonly MetricIncident[], truncated = false) =>
  assembleAnalytics({
    documents: docs,
    filters: FILTERS,
    now: NOW,
    truncated,
    source: 'live',
    documentsRead: docs.length,
  });

/* ========================================================================== */
/* §9 — empty dataset                                                          */
/* ========================================================================== */

describe('an EMPTY dataset is a real measurement, not a failure', () => {
  const empty = build([]);

  it('every COUNT is zero — a window with nothing in it is a fact', () => {
    expect(empty.totals.total).toBe(0);
    expect(empty.totals.resolved).toBe(0);
    expect(empty.byCategory).toEqual([]);
  });

  it('every DURATION is null, because nothing was measured', () => {
    // docs/14 §2.1. `0` would assert "we measured zero"; `null` asserts "we could not
    // measure this". `formatDuration(0)` renders "0s", which reads as "resolved
    // instantly" — a claim an empty dataset cannot support.
    expect(empty.totals.meanTimeToResolveSec).toBeNull();
    expect(empty.totals.meanTimeToDispatchSec).toBeNull();
    expect(empty.totals.slaCompliancePct).toBeNull();
  });

  it('every PERCENTILE is null, and each carries its sample size', () => {
    for (const row of empty.byUrgency) {
      expect(row.p50Sec).toBeNull();
      expect(row.p90Sec).toBeNull();
      expect(row.count).toBe(0);
    }
  });

  it('no risk zones, and no crash', () => {
    expect(buildRiskZones([], { now: NOW })).toEqual([]);
  });
});

/* ========================================================================== */
/* §9 — one incident                                                           */
/* ========================================================================== */

describe('a SINGLE incident', () => {
  const one = build([incident()]);

  it('counts it once and measures its durations', () => {
    expect(one.totals.total).toBe(1);
    expect(one.totals.resolved).toBe(1);
    expect(one.totals.meanTimeToResolveSec).toBe(3540); // 59 minutes from verifiedAt
  });

  it('produces NO risk zone — brief §3: never a zone on one incident', () => {
    const zones = buildRiskZones([incident()], { now: NOW });
    expect(zones).toHaveLength(0);
  });
});

/* ========================================================================== */
/* §9 — many incidents, and §3 the minimum-count rule                         */
/* ========================================================================== */

describe('risk zones need a MINIMUM of incidents', () => {
  const at = (cell: string, n: number, over: Partial<MetricIncident> = {}): MetricIncident[] =>
    Array.from({ length: n }, (_v, i) => incident({ id: `i${cell}${i}`, geoHash6: cell, ...over }));

  it('two incidents in one cell is still not a zone', () => {
    expect(buildRiskZones(at('9z4g0h', MIN_INCIDENTS_PER_ZONE - 1), { now: NOW })).toHaveLength(0);
  });

  it('three incidents in one cell produces exactly one zone', () => {
    const zones = buildRiskZones(at('9z4g0h', 3), { now: NOW });
    expect(zones).toHaveLength(1);
    expect(zones[0]?.incidentCount).toBe(3);
  });

  it('two cells are scored INDEPENDENTLY, not pooled', () => {
    // Five incidents split 3/2 across two cells: one zone, not one zone of five.
    // Pooling would invent density in a cell that has three reports and call it a
    // five-report concentration.
    const zones = buildRiskZones([...at('9z4g0h', 3), ...at('9z4g1z', 2)], { now: NOW });
    expect(zones).toHaveLength(1);
    expect(zones[0]?.incidentCount).toBe(3);
  });

  it('every zone carries its count, so a score can be judged not trusted', () => {
    // docs/14 §6.3 / FR-115: a score with no denominator is not interpretable.
    const zone = buildRiskZones(at('9z4g0h', 5), { now: NOW })[0];
    expect(zone?.incidentCount).toBe(5);
    expect(zone?.score).toBeGreaterThan(0);
  });

  it('the centre is a lat/lng pair and NOTHING else', () => {
    // `GeoPoint` is `{ lat, lng }`. The first draft fabricated `accuracyM: 0` and a
    // cast `'unknown'` grade — asserting something about a point nobody measured.
    const zone = buildRiskZones(at('9z4g0h', 3), { now: NOW })[0];
    expect(Object.keys(zone?.centre ?? {}).sort()).toEqual(['lat', 'lng']);
  });

  it('an incident with no position is excluded, not given an invented cell', () => {
    const zones = buildRiskZones(at('9z4g0h', 3).concat(at('9z4g0h', 3).map((i) => ({ ...i, geoHash6: null }))), { now: NOW });
    expect(zones).toHaveLength(1);
    expect(zones[0]?.incidentCount).toBe(3);
  });

  it('critical-heavy cells outscore low-severity cells of the same size', () => {
    const mild = buildRiskZones(at('9z4g0h', 6, { urgency: 'low' }), { now: NOW })[0];
    const severe = buildRiskZones(at('9z4g0h', 6, { urgency: 'critical' }), { now: NOW })[0];
    expect(severe?.score ?? 0).toBeGreaterThan(mild?.score ?? 0);
  });

  it('a RECENT cell outscores an identical cell whose incidents are old', () => {
    const recent = buildRiskZones(at('9z4g0h', 6), { now: NOW })[0];
    const stale = buildRiskZones(
      at('9z4g0h', 6, { createdAtMs: NOW.getTime() - 300 * DAY }),
      { now: NOW },
    )[0];
    // The 14-day half-life: an incident from ten months ago contributes ~0.
    expect(recent?.score ?? 0).toBeGreaterThan(stale?.score ?? 0);
  });

  it('is CAPPED at 100 zones, sorted by score descending', () => {
    const many: MetricIncident[] = [];
    for (let c = 0; c < 130; c += 1) many.push(...at('9z4' + String(c).padStart(2, '0'), 3));
    const zones = buildRiskZones(many, { now: NOW });
    expect(zones.length).toBeLessThanOrEqual(100);
    for (let i = 1; i < zones.length; i += 1) {
      expect(zones[i - 1]!.score).toBeGreaterThanOrEqual(zones[i]!.score);
    }
  });
});

/* ========================================================================== */
/* §9 — date, category and status filtering                                    */
/* ========================================================================== */

describe('filters narrow the population', () => {
  const corpus = [
    incident({ id: 'in', category: 'medical', urgency: 'critical', status: 'resolved' }),
    incident({ id: 'if', category: 'fire', urgency: 'high', status: 'new', resolvedAtMs: null, respondedAtMs: null }),
    incident({ id: 'old', createdAtMs: Date.parse('2026-01-01T00:00:00Z'), category: 'fire' }),
    incident({ id: 'gone', deletedAtMs: NOW.getTime() }),
  ];

  it('the default range EXCLUDES incidents outside it', () => {
    const a = build(corpus);
    expect(a.totals.total).toBe(2); // 'in' and 'if'; 'old' is out of range, 'gone' is soft-deleted
  });

  it('a SOFT-DELETED incident is never counted', () => {
    const a = assembleAnalytics({
      documents: [incident({ id: 'x', deletedAtMs: NOW.getTime() })],
      filters: FILTERS,
      now: NOW,
      truncated: false,
      source: 'live',
      documentsRead: 1,
    });
    expect(a.totals.total).toBe(0);
  });

  it('a wider range INCLUDES the older incident', () => {
    const wide = assembleAnalytics({
      documents: corpus,
      filters: { ...FILTERS, from: '2026-01-01' },
      now: NOW,
      truncated: false,
      source: 'live',
      documentsRead: corpus.length,
    });
    expect(wide.totals.total).toBe(3);
  });

  it('category totals sum to the total for that category', () => {
    const a = build(corpus);
    const medical = a.byCategory.find((c) => c.category === 'medical');
    expect(medical?.count).toBe(1);
    expect(a.byCategory.reduce((sum, c) => sum + c.count, 0)).toBe(a.totals.total);
  });

  it('byCategory is sorted by count descending, total order', () => {
    const many = build([
      incident({ id: 'a', category: 'fire' }),
      incident({ id: 'b', category: 'fire' }),
      incident({ id: 'c', category: 'medical' }),
    ]);
    expect(many.byCategory[0]?.category).toBe('fire');
    expect(many.byCategory[0]?.count).toBe(2);
  });

  it('an unknown category does not appear as a spurious bucket', () => {
    const a = build([incident({ category: null })]);
    expect(a.byCategory).toEqual([]);
    expect(a.totals.total).toBe(1);
  });

  it('unknown urgency is COUNTED, never dropped', () => {
    // brief §16 in Phase 9: a distribution that omits its largest category is not
    // a distribution. `URGENCIES` has four values and no `unknown` member, so the
    // band is a count of nulls.
    const a = build([incident({ urgency: null }), incident({ id: 'b', urgency: 'low' })]);
    expect(a.totals.total).toBe(2);
    expect(a.totals.medium).toBe(0);
    expect(a.totals.low).toBe(1);
  });
});

/* ========================================================================== */
/* §9 — missing timestamps                                                     */
/* ========================================================================== */

describe('missing timestamps are EXCLUDED from a metric, never zeroed', () => {
  it('an incident with no resolution timestamp does not shorten the mean', () => {
    const withBoth = build([
      incident({ id: 'a', resolvedAtMs: NOW.getTime() - 2 * DAY + 3600_000 }),
      incident({ id: 'b', resolvedAtMs: NOW.getTime() - 2 * DAY + 3600_000 }),
    ]);
    const withGap = build([
      incident({ id: 'a', resolvedAtMs: NOW.getTime() - 2 * DAY + 3600_000 }),
      incident({ id: 'b', resolvedAtMs: null }),
    ]);
    expect(withBoth.totals.meanTimeToResolveSec).toBe(withGap.totals.meanTimeToResolveSec);
  });

  it('when NO incident has a resolution timestamp, the mean is null', () => {
    const a = build([incident({ resolvedAtMs: null })]);
    expect(a.totals.meanTimeToResolveSec).toBeNull();
  });

  it('an in-flight incident is not counted as SLA-compliant', () => {
    // Counting every open incident as compliant would inflate the rate by whatever
    // is in the queue, and improve as the backlog grew.
    //
    // 'In-flight' means NEITHER respondedAt NOR resolvedAt. The first draft of this
    // test gave one incident a respondedAt inside its target and expected null; it
    // got 100, correctly. The fixture was wrong, not the metric.
    const allInFlight = build([
      incident({ id: 'a', respondedAtMs: null, resolvedAtMs: null, status: 'assigned' }),
      incident({ id: 'b', respondedAtMs: null, resolvedAtMs: null, status: 'en_route' }),
    ]);
    expect(allInFlight.totals.slaCompliancePct).toBeNull();
  });

  it('a response inside the target IS counted, and a late one is a breach', () => {
    // The counterpart, so the null above is not mistaken for 'compliance is never
    // computable' rather than 'nothing in this window was measurable'.
    const compliant = build([
      incident({ id: 'a', respondedAtMs: NOW.getTime() - 2 * DAY + 60_000, resolvedAtMs: null }),
    ]);
    expect(compliant.totals.slaCompliancePct).toBe(100);

    const breached = build([
      incident({ id: 'a', respondedAtMs: NOW.getTime() - 2 * DAY + 40 * 60_000, resolvedAtMs: null }),
    ]);
    expect(breached.totals.slaCompliancePct).toBe(0);
  });
});

/* ========================================================================== */
/* §7 — a capped scan is not presented as complete                             */
/* ========================================================================== */

describe('a truncated scan SAYS SO', () => {
  it('sets an advisory naming the cap', () => {
    const capped = build([incident()], true);
    expect(capped.range.advisory).not.toBeNull();
    expect(capped.range.advisory).toContain('500');
    // The advisory must be actionable, not merely non-null.
    expect(capped.range.advisory).toMatch(/not included/i);
  });

  it('sets NO advisory when the scan covered the range', () => {
    expect(build([incident()], false).range.advisory).toBeNull();
  });

  it('carries the source, so a rollup and a live scan are distinguishable', () => {
    expect(build([]).range.source).toBe('live');
  });
});

/* ========================================================================== */
/* §8 / docs/14 §6.8 — the honesty constraints                                */
/* ========================================================================== */

describe('a risk zone summarises the PAST and the module says so', () => {
  // brief §3: "Do NOT label an area as dangerous based on a single incident."
  it('refuses to score a cell below the minimum, so a lone report cannot label an area', () => {
    expect(MIN_INCIDENTS_PER_ZONE).toBeGreaterThan(1);
    expect(buildRiskZones([incident()], { now: NOW })).toHaveLength(0);
  });

  // docs/14 §6.8: the statement is rendered VERBATIM.
  it('the honesty statement opens with the forecast disclaimer', () => {
    expect(RISK_HONESTY_STATEMENT).toMatch(/^This is a summary of past incidents, not a forecast\./);
    expect(RISK_HONESTY_STATEMENT).toMatch(/does not know the population/i);
    expect(RISK_HONESTY_STATEMENT).toMatch(/never where to send/i);
  });

  it('no produced field contains a forbidden predictive claim', () => {
    const zone = buildRiskZones(
      Array.from({ length: 8 }, (_v, i) => incident({ id: 'z' + i, urgency: 'critical' })),
      { now: NOW },
    )[0];
    // `dominantCategory` is the only free-text field a zone carries. It is an enum,
    // so this asserts the ZONE shape cannot smuggle a sentence.
    expect(zone?.dominantCategory === null || typeof zone?.dominantCategory === 'string').toBe(true);
    const serialised = JSON.stringify(zone ?? {}).toLowerCase();
    for (const claim of FORBIDDEN_RISK_CLAIMS) {
      expect(serialised, claim).not.toContain(claim.toLowerCase());
    }
  });

  it('dominantCategory is null on a TIE, not an arbitrary winner', () => {
    // docs/14 §2.2: "`null` on a tie". Picking one would invent it.
    const tied = buildRiskZones(
      [
        incident({ id: 'a', category: 'medical' }),
        incident({ id: 'b', category: 'fire' }),
        incident({ id: 'c', category: 'medical' }),
        incident({ id: 'd', category: 'fire' }),
      ],
      { now: NOW },
    )[0];
    expect(tied?.dominantCategory).toBeNull();
  });
});
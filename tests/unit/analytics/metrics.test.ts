import { describe, expect, it } from 'vitest';

import {
  buildTotals,
  densityPerCell,
  durationSec,
  mean,
  peopleAffected,
  populationOf,
  ratePct,
  slaCompliancePct,
  timeMeans,
  topLocations,
  volumeCounts,
  type MetricIncident,
} from '@/lib/analytics/metrics';
import { ANALYTICS_ACTIVE_STATUSES } from '@/lib/collections/enums';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const T0 = Date.parse('2026-09-20T08:00:00Z');
const MIN = 60_000;

function incident(over: Partial<MetricIncident> = {}): MetricIncident {
  return {
    id: 'inc_1',
    status: 'triaged',
    urgency: 'medium',
    category: 'medical',
    createdAtMs: T0,
    deletedAtMs: null,
    verifiedAtMs: null,
    dispatchedAtMs: null,
    respondedAtMs: null,
    resolvedAtMs: null,
    slaTargetMin: null,
    reportCount: 1,
    linkedReportCount: 0,
    triageSource: 'ai',
    aiConfidence: 0.8,
    peopleAffected: null,
    geoHash6: null,
    ...over,
  };
}

const PERIOD_FROM = T0 - MIN;
const PERIOD_TO = T0 + 24 * 60 * MIN;

/* ========================================================================== */
/* `docs/14 §2.1` — THE rule                                                    */
/* ========================================================================== */

describe('THE RULE: an unmeasurable metric is null, never 0 (docs/14 §2.1)', () => {
  // brief §30: "Never fabricate values. Example: `Not enough data to calculate
  // response time.` is preferable to displaying an invented metric."

  it('mean of an EMPTY population is null, not 0', () => {
    // The load-bearing assertion. `formatDuration(0)` renders "0s" on a
    // dispatcher's screen, which reads as "resolved instantly".
    expect(mean([])).toBeNull();
    expect(mean([10, 20])).toBe(15);
    // A genuine zero IS reachable — a mean of zeros is a measurement.
    expect(mean([0, 0])).toBe(0);
  });

  it('every RATE is null for a zero denominator, never 0%', () => {
    expect(ratePct(0, 0)).toBeNull();
    expect(ratePct(5, 0)).toBeNull();
    expect(ratePct(0, 10)).toBe(0);
  });

  it('a duration with a MISSING endpoint is null', () => {
    expect(durationSec(null, T0)).toBeNull();
    expect(durationSec(T0, null)).toBeNull();
    expect(durationSec(null, null)).toBeNull();
    expect(durationSec(T0, T0 + 90_000)).toBe(90);
  });

  it('a NEGATIVE duration is null, not a negative number', () => {
    // Host clock skew, and a Firestore server timestamp microseconds ahead of the
    // caller's clock, both produce one. A negative response time in an ops report
    // reads as data.
    expect(durationSec(T0, T0 - 5_000)).toBeNull();
  });

  it('the FULL totals block for an empty period has real counts and null means', () => {
    const totals = buildTotals([]);
    // Counts are measurements of "nothing happened", which is a fact.
    expect(totals.total).toBe(0);
    expect(totals.active).toBe(0);
    // Every duration and rate is a null.
    expect(totals.meanTimeToVerifySec).toBeNull();
    expect(totals.meanTimeToDispatchSec).toBeNull();
    expect(totals.meanTimeToResolveSec).toBeNull();
    expect(totals.slaCompliancePct).toBeNull();
    expect(totals.duplicateRatePct).toBeNull();
    expect(totals.aiFallbackRatePct).toBeNull();
    expect(totals.meanAiConfidence).toBeNull();
    expect(totals.reportsPerIncident).toBeNull();
  });
});

/* ========================================================================== */
/* The population — `docs/14 §2.1`                                            */
/* ========================================================================== */

describe('the population is exactly docs/14 §2.1', () => {
  it('excludes soft-deleted incidents', () => {
    // A soft-deleted incident is retained for audit. Including it would make a
    // two-year-old report look like part of this period's volume.
    const population = populationOf(
      [incident(), incident({ id: 'inc_gone', deletedAtMs: T0 + MIN })],
      PERIOD_FROM,
      PERIOD_TO,
    );
    expect(population).toHaveLength(1);
    expect(population[0]?.id).toBe('inc_1');
  });

  it('respects BOTH ends of the range, inclusively', () => {
    const atFrom = incident({ id: 'a', createdAtMs: PERIOD_FROM });
    const atTo = incident({ id: 'b', createdAtMs: PERIOD_TO });
    const before = incident({ id: 'c', createdAtMs: PERIOD_FROM - 1 });
    const after = incident({ id: 'd', createdAtMs: PERIOD_TO + 1 });
    const ids = populationOf([atFrom, atTo, before, after], PERIOD_FROM, PERIOD_TO).map((i) => i.id);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('excludes an incident with no createdAt — it cannot be IN a period', () => {
    expect(populationOf([incident({ createdAtMs: null })], PERIOD_FROM, PERIOD_TO)).toHaveLength(0);
  });
});

/* ========================================================================== */
/* `docs/14 §2.2` — volume                                                     */
/* ========================================================================== */

describe('volume counts, docs/14 §2.2', () => {
  it('counts every urgency including UNKNOWN, never dropping it', () => {
    // brief §16 asks for an "Unknown" band. A distribution that silently omits its
    // largest category is not a distribution.
    const counts = volumeCounts([
      incident({ urgency: 'critical' }),
      incident({ urgency: null }),
      incident({ urgency: null }),
    ]);
    expect(counts.critical).toBe(1);
    expect(counts.unknown).toBe(2);
  });

  it('`active` uses ACTIVE_STATUSES, and an incident is in exactly one status bucket', () => {
    const all = ANALYTICS_ACTIVE_STATUSES.map((status, index) => incident({ id: `a${index}`, status }));
    const counts = volumeCounts([...all, incident({ id: 'done', status: 'resolved' })]);
    expect(counts.active).toBe(ANALYTICS_ACTIVE_STATUSES.length);
    expect(counts.resolved).toBe(1);
    // The buckets are disjoint, so their sum is the total.
    const terminalSum =
      counts.resolved + counts.closed + counts.cancelled + counts.falseAlarm + counts.merged;
    expect(counts.active + terminalSum).toBe(counts.total);
  });

  it('`merged` is counted SEPARATELY and never folded into `resolved`', () => {
    // A merged incident was absorbed into a primary. Counting it as resolved would
    // inflate the resolution count and make response analytics wrong.
    const counts = volumeCounts([incident({ status: 'merged' }), incident({ status: 'resolved' })]);
    expect(counts.merged).toBe(1);
    expect(counts.resolved).toBe(1);
  });

  it('`reports` sums reportCount, `linkedReports` sums linkedReportCount', () => {
    const counts = volumeCounts([
      incident({ reportCount: 3, linkedReportCount: 2 }),
      incident({ reportCount: 1, linkedReportCount: 0 }),
    ]);
    expect(counts.reports).toBe(4);
    expect(counts.linkedReports).toBe(2);
  });
});

/* ========================================================================== */
/* `docs/14 §2.3` — time                                                       */
/* ========================================================================== */

describe('time means use verifiedAt ?? createdAt, docs/14 §2.3', () => {
  it('measures an UNVERIFIED incident from createdAt, not from nothing', () => {
    // The document's stated reason: FR-019 lets a citizen cancel before
    // verification, and the fallback triage path (FR-029) produces one. Measuring
    // from `verifiedAt` alone would drop exactly the incidents most likely to have
    // been fast.
    const only = [incident({ verifiedAtMs: null, createdAtMs: T0, dispatchedAtMs: T0 + 5 * MIN })];
    const times = timeMeans([], only, []);
    expect(times.meanTimeToDispatchSec).toBe(300);
  });

  it('measures a VERIFIED incident from verifiedAt when both exist', () => {
    const only = [
      incident({ createdAtMs: T0, verifiedAtMs: T0 + 2 * MIN, dispatchedAtMs: T0 + 8 * MIN }),
    ];
    // 6 minutes from verification, not 8 from creation.
    expect(timeMeans([], only, []).meanTimeToDispatchSec).toBe(360);
  });

  it('an incident missing the ENDPOINT is excluded from that mean, not zeroed', () => {
    const times = timeMeans(
      [incident({ createdAtMs: T0, verifiedAtMs: T0 + MIN })],
      [incident({ createdAtMs: T0 }), incident({ createdAtMs: T0, dispatchedAtMs: T0 + 10 * MIN })],
      [],
    );
    // The one dispatch-less incident contributes nothing; the mean is over 1.
    expect(times.meanTimeToVerifySec).toBe(60);
    expect(times.meanTimeToDispatchSec).toBe(600);
  });

  it('all three are null when none of the incidents has the timestamp', () => {
    const times = timeMeans([incident()], [incident()], [incident()]);
    expect(times.meanTimeToVerifySec).toBeNull();
    expect(times.meanTimeToDispatchSec).toBeNull();
    expect(times.meanTimeToResolveSec).toBeNull();
  });
});

/* ========================================================================== */
/* `docs/14 §2.4` — SLA compliance                                             */
/* ========================================================================== */

describe('SLA compliance, docs/14 §2.4', () => {
  it('is null when nothing measurable is in the window', () => {
    expect(slaCompliancePct([])).toBeNull();
    // No slaTargetMin, so there is no target to comply with.
    expect(slaCompliancePct([incident({ slaTargetMin: null })])).toBeNull();
  });

  it('does NOT count an in-flight incident as compliant', () => {
    // Counting every open incident as compliant would inflate the rate by whatever
    // is currently in the queue, and would improve as the backlog grew.
    const counts = slaCompliancePct([
      incident({ slaTargetMin: 15, respondedAtMs: T0 + 5 * MIN }),
      incident({ id: 'b', slaTargetMin: 15, respondedAtMs: null, resolvedAtMs: null }),
    ]);
    expect(counts).toBe(100);
  });

  it('counts a breach when the response came in after the target', () => {
    const counts = slaCompliancePct([incident({ slaTargetMin: 15, respondedAtMs: T0 + 20 * MIN })]);
    expect(counts).toBe(0);
  });

  it('excludes MERGED incidents, which have no SLA of their own', () => {
    const counts = slaCompliancePct([
      incident({ status: 'resolved', slaTargetMin: 15, respondedAtMs: T0 + 5 * MIN }),
      incident({ id: 'm', status: 'merged', slaTargetMin: 15, respondedAtMs: T0 + 90 * MIN }),
    ]);
    // The breach is not in the denominator, so this is 100% not 50%.
    expect(counts).toBe(100);
  });

  it('excludes an incident with no createdAt rather than defaulting its clock to zero', () => {
    const counts = slaCompliancePct([
      incident({ id: 'x', createdAtMs: null, slaTargetMin: 15, respondedAtMs: T0 + 60 * MIN }),
    ]);
    expect(counts).toBeNull();
  });
});

/* ========================================================================== */
/* `docs/14 §2.5` — location                                                   */
/* ========================================================================== */

describe('top locations group on geoCells[0], docs/14 §2.5', () => {
  it('counts per geohash-6 cell and returns the top N', () => {
    const { cells } = topLocations([
      incident({ geoHash6: '9z4g0h' }),
      incident({ id: 'b', geoHash6: '9z4g0h' }),
      incident({ id: 'c', geoHash6: '9z4g1z' }),
    ]);
    expect(cells[0]).toEqual({ geohash6: '9z4g0h', count: 2 });
    expect(cells[1]).toEqual({ geohash6: '9z4g1z', count: 1 });
  });

  it('counts positionless incidents and REPORTS them, never dropping them', () => {
    // A report with an address and no coordinates is a real report. A "top
    // locations" list that quietly excludes 20% of the period is not a
    // distribution.
    const result = topLocations([incident({ geoHash6: null }), incident({ id: 'b', geoHash6: '' })]);
    expect(result.cells).toHaveLength(0);
    expect(result.withoutPosition).toBe(2);
  });

  it('the order is TOTAL, so equal counts do not shuffle between renders', () => {
    const rows = ['z9z9z9', 'a1a1a1', 'm5m5m5'].map((geoHash6) => incident({ geoHash6 }));
    const first = topLocations(rows).cells.map((c) => c.geohash6);
    const second = topLocations([...rows].reverse()).cells.map((c) => c.geohash6);
    expect(first).toEqual(second);
  });

  it('densityPerCell is null for a single day, per the document caveat', () => {
    // "Meaningless for a single day; shown only for multi-day ranges."
    expect(densityPerCell(5, 1)).toBeNull();
    expect(densityPerCell(5, 30)).toBeCloseTo(5 / 30, 10);
  });
});

/* ========================================================================== */
/* `docs/14 §2.6` — human factors                                              */
/* ========================================================================== */

describe('people affected is null-heavy BY DESIGN (FR-023)', () => {
  it('is null when nobody recorded a count, and reports the sample size', () => {
    const result = peopleAffected([incident({ peopleAffected: null })]);
    expect(result.avg).toBeNull();
    expect(result.sampleSize).toBe(0);
  });

  it('the sample size is returned, because a mean of 3 is not a mean of 300', () => {
    // FR-023 forbids inventing a count, so this field is mostly null. Showing the
    // mean alone would let a dispatcher conclude something from a sample of four.
    const result = peopleAffected([
      incident({ peopleAffected: 2 }),
      incident({ id: 'b', peopleAffected: 4 }),
      incident({ id: 'c', peopleAffected: null }),
    ]);
    expect(result.avg).toBe(3);
    expect(result.sampleSize).toBe(2);
  });
});

/* ========================================================================== */
/* The assembly                                                                */
/* ========================================================================== */

describe('buildTotals assembles one consistent block', () => {
  it('every field is populated or null — never an invented number', () => {
    const totals = buildTotals([
      incident({
        urgency: 'critical',
        status: 'resolved',
        createdAtMs: T0,
        verifiedAtMs: T0 + MIN,
        dispatchedAtMs: T0 + 3 * MIN,
        resolvedAtMs: T0 + 30 * MIN,
        slaTargetMin: 15,
        respondedAtMs: T0 + 4 * MIN,
        reportCount: 2,
        linkedReportCount: 1,
        triageSource: 'fallback',
        aiConfidence: 0.7,
      }),
    ]);
    expect(totals.total).toBe(1);
    expect(totals.critical).toBe(1);
    expect(totals.resolved).toBe(1);
    expect(totals.meanTimeToVerifySec).toBe(60);
    expect(totals.meanTimeToResolveSec).toBe(1740);
    expect(totals.duplicateRatePct).toBe(50);
    expect(totals.aiFallbackRatePct).toBe(100);
    expect(totals.meanAiConfidence).toBe(0.7);
    expect(totals.reportsPerIncident).toBe(2);
    expect(totals.slaCompliancePct).toBe(100);
  });

  it('a real 0% is distinguishable from a null', () => {
    // Two incidents, neither a duplicate: 0% is a MEASUREMENT.
    const totals = buildTotals([incident(), incident({ id: 'b' })]);
    expect(totals.duplicateRatePct).toBe(0);
    expect(totals.aiFallbackRatePct).toBe(0);
    // An empty period: a NULL.
    expect(buildTotals([]).duplicateRatePct).toBeNull();
  });
});

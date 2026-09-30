/**
 * ============================================================================
 * CareGrid AI — operational metric catalogue
 * ============================================================================
 *
 * `docs/14 §2`, FR-115. **PURE.** No Firestore, no clock, no randomness.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT SHAPES THIS ENTIRE FILE
 * ---------------------------------------------------------------------------
 * `docs/14 §2.1`: "**A metric whose inputs are absent is `null`, never `0`. `0`
 * asserts 'we measured zero'; `null` asserts 'we could not measure this'.**"
 *
 * brief §30 says the same: "Never fabricate values… `Not enough data to calculate
 * response time.` is preferable to displaying an invented metric."
 *
 * This is not a style preference, and the failure it prevents is concrete. A
 * dispatcher's dashboard showing "Average response time: 0s" because no incident in
 * the last 7 days was dispatched does not read as "no data" — it reads as
 * *instantaneous response*, and the correct response to that is to stop dispatching
 * and just accept the queue. So `mean()` here returns `null` for an empty
 * population, every rate returns `null` for a zero denominator, and the UI renders
 * a sentence instead of a number.
 *
 * Every helper below is written so that `null` is the ONLY way to express "we
 * could not measure this", and `0` is reachable only by actually measuring zero.
 *
 * ---------------------------------------------------------------------------
 * `meanTimeToDispatchSec` AND `meanTimeToResolveSec` USE `verifiedAt ?? createdAt`
 * ---------------------------------------------------------------------------
 * `docs/14 §2.3`: "**Why `verifiedAt ?? createdAt` and not `verifiedAt` only?**
 * Because FR-019 allows a citizen to cancel before verification, and the fallback
 * triage path (FR-029) …"
 *
 * An incident that was never verified still happened, and measuring its
 * report-to-dispatch duration from `createdAt` is the honest answer. Measuring from
 * `verifiedAt` would silently drop every unverified incident from the average,
 * which is exactly the set most likely to have been fast.
 *
 * ---------------------------------------------------------------------------
 * INCIDENTS THAT LEAVE THE POPULATION ARE NOT INVISIBLE, THEY ARE SEPARATE
 * ---------------------------------------------------------------------------
 * `docs/14 §2.2` notes `total` "Counts **reports that became incidents**, not
 * reports" and `merged` "Counts **secondary** incidents absorbed into a primary".
 * So a merged incident is counted, but as `merged` — never silently dropped, and
 * never folded into `resolved`, which would inflate the resolution count.
 */

import type { AnalyticsTotals, MaybeNumber } from '@/types';
import { ANALYTICS_ACTIVE_STATUSES } from '@/lib/collections/enums';
import type { IncidentCategory, IncidentStatus, Urgency } from '@/types';

/* ========================================================================== */
/* The input                                                                   */
/* ========================================================================== */

/**
 * The subset of `incidents` the metric catalogue reads.
 *
 * Declared structurally rather than reusing `Incident` because the live path
 * reads raw documents and the rollup path reads aggregated rows, and both produce
 * this. Every timestamp is `number | null` because **that is the whole point**:
 * `docs/14 §2.3` says "Every one of these has a `null` path, and the null path is
 * the common path early in an incident's life."
 */
export type MetricIncident = {
  readonly id: string;
  readonly status: IncidentStatus;
  readonly urgency: Urgency | null;
  readonly category: IncidentCategory | null;
  readonly createdAtMs: number | null;
  readonly deletedAtMs: number | null;
  readonly verifiedAtMs: number | null;
  readonly dispatchedAtMs: number | null;
  readonly respondedAtMs: number | null;
  readonly resolvedAtMs: number | null;
  readonly slaTargetMin: number | null;
  /** `docs/07 §4.1`: "includes the original". */
  readonly reportCount: number;
  readonly linkedReportCount: number;
  readonly triageSource: string | null;
  readonly aiConfidence: number | null;
  readonly peopleAffected: number | null;
  /** `docs/07 §4.1`'s `geoCells[0]` — the incident's own geohash-6 centre cell. */
  readonly geoHash6: string | null;
};

/* ========================================================================== */
/* The primitives                                                              */
/* ========================================================================== */

/**
 * The mean of a list, or `null` for an empty one.
 *
 * **The load-bearing seven lines of this file.** `0` is only ever returned when the
 * population was non-empty and its mean is genuinely zero.
 */
export function mean(values: readonly number[]): MaybeNumber {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * `100 x numerator / denominator`, or `null` for a zero denominator.
 *
 * `docs/14 §2.4` marks `duplicateRatePct`, `cancellationRatePct`,
 * `falseAlarmRatePct` and `aiFallbackRatePct` all "null when … == 0".
 */
export function ratePct(numerator: number, denominator: number): MaybeNumber {
  if (denominator === 0) return null;
  return (100 * numerator) / denominator;
}

/**
 * A duration in seconds from two timestamps, or `null` if either is missing.
 *
 * **A negative duration is `null`, not a negative number.** Host clock skew and a
 * Firestore server timestamp that is microseconds ahead of the caller's clock both
 * produce one, and a negative "response time" in an ops report is a defect that
 * would be read as data.
 */
export function durationSec(fromMs: number | null, toMs: number | null): MaybeNumber {
  if (fromMs === null || toMs === null) return null;
  const seconds = (toMs - fromMs) / 1000;
  return seconds < 0 ? null : seconds;
}

/* ========================================================================== */
/* The population                                                              */
/* ========================================================================== */

/**
 * `docs/14 §2.1`'s "Population P": incidents with `deletedAt == null` and
 * `createdAt` in `[from 00:00, to 23:59:59.999]` in `APP_TIMEZONE`.
 *
 * The two bounds arrive already converted to epoch ms by `lib/analytics/time.ts`,
 * because the local-day boundary is the caller's job and getting it wrong here
 * would be invisible.
 */
export function populationOf(
  incidents: readonly MetricIncident[],
  fromMs: number,
  toMs: number,
): readonly MetricIncident[] {
  return incidents.filter((incident) => {
    // A soft-deleted incident is retained for audit and is NOT in the population.
    if (incident.deletedAtMs !== null) return false;
    if (incident.createdAtMs === null) return false;
    return incident.createdAtMs >= fromMs && incident.createdAtMs <= toMs;
  });
}

/**
 * `docs/14 §2.1`: "**Active statuses** | `new`, `triaged`, `verified`, `assigned`,
 * `en_route`, `on_scene` (**6 values**)" — and it names `resolved` separately as a
 * *terminal* status.
 *
 * **Six, not seven.** `types/enums.ts`'s `ACTIVE_STATUSES` includes `resolved`,
 * because `docs/07 §12.1` uses the name for the seven-element set. Using it here
 * counted every resolved incident in BOTH `active` and `resolved`, and the
 * disjointness assertion in the test suite is what caught it. See
 * `lib/collections/enums.ts` for the full collision note.
 */
const ACTIVE_SET: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(ANALYTICS_ACTIVE_STATUSES);

/** `docs/14 §2.2`: `active` = `count(P where status in ACTIVE_STATUSES)`. */
export function isActive(incident: MetricIncident): boolean {
  return ACTIVE_SET.has(incident.status);
}

/* ========================================================================== */
/* `docs/14 §2.2` — volume                                                     */
/* ========================================================================== */

/**
 * The count block. **Every field here is a real measurement**, so none is
 * nullable: a window with no incidents has a total of 0, and that is a fact about
 * the window rather than an absence of data.
 */
export function volumeCounts(population: readonly MetricIncident[]): {
  total: number;
  active: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** No urgency at all — an incident triaged by a path that set none. */
  unknown: number;
  resolved: number;
  closed: number;
  cancelled: number;
  falseAlarm: number;
  merged: number;
  reports: number;
  linkedReports: number;
} {
  const counts = {
    total: population.length,
    active: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    resolved: 0,
    closed: 0,
    cancelled: 0,
    falseAlarm: 0,
    merged: 0,
    reports: 0,
    linkedReports: 0,
  };

  for (const incident of population) {
    if (isActive(incident)) counts.active += 1;

    // `docs/14 §2.2`: "urgency is the CURRENT urgency". An unknown urgency is
    // counted, not dropped — brief §16 asks for an "Unknown" band and a distribution
    // that silently omits its largest category is not a distribution.
    switch (incident.urgency) {
      case 'critical':
        counts.critical += 1;
        break;
      case 'high':
        counts.high += 1;
        break;
      case 'medium':
        counts.medium += 1;
        break;
      case 'low':
        counts.low += 1;
        break;
      default:
        counts.unknown += 1;
        break;
    }

    switch (incident.status) {
      case 'resolved':
        counts.resolved += 1;
        break;
      case 'closed':
        counts.closed += 1;
        break;
      case 'cancelled':
        counts.cancelled += 1;
        break;
      case 'false_alarm':
        counts.falseAlarm += 1;
        break;
      case 'merged':
        counts.merged += 1;
        break;
      default:
        break;
    }

    counts.reports += incident.reportCount;
    counts.linkedReports += incident.linkedReportCount;
  }

  return counts;
}

/* ========================================================================== */
/* `docs/14 §2.3` — time                                                       */
/* ========================================================================== */

/**
 * The three duration means, each with its own `null` path.
 *
 * | Metric | Over | Null when |
 * | --- | --- | --- |
 * | `meanTimeToVerifySec` | `verifiedAt - createdAt` | nothing in P was verified |
 * | `meanTimeToDispatchSec` | `dispatchedAt - (verifiedAt ?? createdAt)` | nothing in P was dispatched |
 * | `meanTimeToResolveSec` | `resolvedAt - (verifiedAt ?? createdAt)` | nothing in P was resolved |
 *
 * **`docs/14 §2.3` also says the dispatch and resolve metrics are "bucketed by the
 * day of" their endpoint**, not by `createdAt`. That is what the caller does when it
 * groups; here the two are computed over the whole population, and the bucketing
 * function receives the pre-bucketed sets.
 */
export function timeMeans(
  verified: readonly MetricIncident[],
  dispatched: readonly MetricIncident[],
  resolved: readonly MetricIncident[],
): {
  meanTimeToVerifySec: MaybeNumber;
  meanTimeToDispatchSec: MaybeNumber;
  meanTimeToResolveSec: MaybeNumber;
} {
  const verifyDurations: number[] = [];
  for (const incident of verified) {
    const duration = durationSec(incident.createdAtMs, incident.verifiedAtMs);
    if (duration !== null) verifyDurations.push(duration);
  }

  const dispatchDurations: number[] = [];
  for (const incident of dispatched) {
    // `verifiedAt ?? createdAt` — see the file header.
    const from = incident.verifiedAtMs ?? incident.createdAtMs;
    const duration = durationSec(from, incident.dispatchedAtMs);
    if (duration !== null) dispatchDurations.push(duration);
  }

  const resolveDurations: number[] = [];
  for (const incident of resolved) {
    const from = incident.verifiedAtMs ?? incident.createdAtMs;
    const duration = durationSec(from, incident.resolvedAtMs);
    if (duration !== null) resolveDurations.push(duration);
  }

  return {
    meanTimeToVerifySec: mean(verifyDurations),
    meanTimeToDispatchSec: mean(dispatchDurations),
    meanTimeToResolveSec: mean(resolveDurations),
  };
}

/* ========================================================================== */
/* `docs/14 §2.4` — rates                                                      */
/* ========================================================================== */

/**
 * `slaCompliancePct`, `docs/14 §2.4`: "**E** = `P` restricted to incidents that
 * have reached a terminal status **or** are still active", i.e. every incident
 * except the `merged` ones, which have no SLA of their own.
 *
 * **Not `null` for an empty population** — an empty population is a 0 denominator,
 * and this metric's denominator is "incidents eligible for an SLA", which is
 * `total - merged`. It follows the same `ratePct` rule as the others, so it IS
 * `null` when that is zero, and the distinction is preserved rather than special-
 * cased.
 */
export function slaCompliancePct(population: readonly MetricIncident[]): MaybeNumber {
  const eligible = population.filter((incident) => incident.status !== 'merged');
  const withTarget = eligible.filter((incident) => incident.slaTargetMin !== null);

  let breaches = 0;
  let counted = 0;
  for (const incident of withTarget) {
    if (incident.slaTargetMin === null) continue;
    // An incident with no `createdAt` has no clock to measure a target against. It
    // is excluded rather than defaulted to zero, which would put it in the
    // denominator and quietly lower the compliance rate.
    if (incident.createdAtMs === null) continue;
    const breachedAtMs = incident.respondedAtMs ?? incident.resolvedAtMs;
    // An incident still in flight has no breach yet, and counting it as compliant
    // would inflate the rate by every open incident in the window.
    if (breachedAtMs === null) continue;
    counted += 1;
    if (breachedAtMs - incident.createdAtMs > incident.slaTargetMin * 60_000) breaches += 1;
  }

  if (counted === 0) return null;
  return (100 * (counted - breaches)) / counted;
}

/* ========================================================================== */
/* The assembly                                                                */
/* ========================================================================== */

/**
 * The whole `AnalyticsTotals` block for one population.
 *
 * The single entry point, so a caller cannot assemble a totals block that mixes a
 * count from one population with a mean from another — which is the mistake a
 * dozen exported helpers invite.
 */
export function buildTotals(population: readonly MetricIncident[]): AnalyticsTotals {
  const counts = volumeCounts(population);

  // `docs/14 §2.3` scopes each mean to the sub-population that HAS that timestamp.
  // Filtering here rather than inside `timeMeans` keeps one definition of each
  // sub-population and makes the "null path is the common path" explicit.
  const verified = population.filter((i) => i.verifiedAtMs !== null);
  const dispatched = population.filter((i) => i.dispatchedAtMs !== null);
  const resolved = population.filter((i) => i.resolvedAtMs !== null);
  const times = timeMeans(verified, dispatched, resolved);

  const fallbacks = population.filter((i) => i.triageSource === 'fallback');
  const confidences: number[] = [];
  for (const incident of population) {
    if (incident.aiConfidence !== null) confidences.push(incident.aiConfidence);
  }

  return {
    total: counts.total,
    active: counts.active,
    critical: counts.critical,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    resolved: counts.resolved,
    cancelled: counts.cancelled,
    falseAlarm: counts.falseAlarm,
    meanTimeToVerifySec: times.meanTimeToVerifySec,
    meanTimeToDispatchSec: times.meanTimeToDispatchSec,
    meanTimeToResolveSec: times.meanTimeToResolveSec,
    slaCompliancePct: slaCompliancePct(population),
    duplicateRatePct: ratePct(counts.linkedReports, counts.reports),
    aiFallbackRatePct: ratePct(fallbacks.length, counts.total),
    meanAiConfidence: mean(confidences),
    reportsPerIncident: counts.total === 0 ? null : counts.reports / counts.total,
  };
}

/* ========================================================================== */
/* `docs/14 §2.5` — location                                                    */
/* ========================================================================== */

/**
 * `docs/14 §2.5`: "`topLocations` | `count(P grouped by geoCells[0] - the
 * incident's own geohash-6)` | top 10 `{ geohash6, count }`".
 *
 * **`geoCells[0]` is the CENTRE cell, not the incident's exact position** — the
 * document says so in its own caveat, and it is the reason this is a cell count and
 * not a coordinate list. An incident's `geoCells` is a 9-cell block; only the
 * centre is its own, and grouping on the whole block would double-count every
 * incident nine times.
 *
 * Incidents with no position are **counted and reported**, not dropped: a report
 * with an address and no coordinates is a real report, and a "top locations" list
 * that quietly excludes 20% of the period is not a distribution.
 */
export function topLocations(
  population: readonly MetricIncident[],
  cap = 10,
): { readonly cells: readonly { geohash6: string; count: number }[]; readonly withoutPosition: number } {
  const counts = new Map<string, number>();
  let withoutPosition = 0;

  for (const incident of population) {
    if (incident.geoHash6 === null || incident.geoHash6.length === 0) {
      withoutPosition += 1;
      continue;
    }
    counts.set(incident.geoHash6, (counts.get(incident.geoHash6) ?? 0) + 1);
  }

  const cells = [...counts.entries()]
    .map(([geohash6, count]) => ({ geohash6, count }))
    // Count descending, then cell ascending so the order is TOTAL. Without the
    // tiebreak, two cells with the same count would swap places between renders and
    // the top-10 list would appear to shuffle.
    .sort((a, b) => (b.count - a.count) || a.geohash6.localeCompare(b.geohash6))
    .slice(0, cap);

  return { cells, withoutPosition };
}

/**
 * `docs/14 §2.5`: "`densityPerCell` | `count / (windowDays)` | Meaningless for a
 * single day; shown only for multi-day ranges".
 *
 * `null` for a single day rather than a per-day figure, for the reason the
 * document gives.
 */
export function densityPerCell(count: number, windowDays: number): MaybeNumber {
  if (windowDays <= 1) return null;
  return count / windowDays;
}

/* ========================================================================== */
/* `docs/14 §2.6` — human factors                                              */
/* ========================================================================== */

/**
 * `docs/14 §2.6`: `avgPeopleAffected` over "P where `peopleAffected != null`",
 * and the caveat "**This field is null-heavy by design** (FR-023 forbids inventing
 * a count)".
 *
 * **`sampleSize` is returned alongside and is not optional.** A mean over three
 * records is a very different claim from a mean over three hundred, and showing the
 * mean alone is how a dispatcher concludes something about response from a
 * sample of four.
 */
export function peopleAffected(
  population: readonly MetricIncident[],
): { readonly avg: MaybeNumber; readonly sampleSize: number } {
  const values: number[] = [];
  for (const incident of population) {
    if (incident.peopleAffected !== null) values.push(incident.peopleAffected);
  }
  return { avg: mean(values), sampleSize: values.length };
}

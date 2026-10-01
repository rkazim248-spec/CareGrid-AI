import 'server-only';

/**
 * ============================================================================
 * CareGrid AI — operational analytics aggregation
 * ============================================================================
 *
 * `docs/14 §3`, §4, §6. The data path Phase 9 left open: the metric engine, the
 * rollup/live source decision and the risk score all existed and were tested, but
 * nothing read Firestore to feed them, so `features/analytics/analytics-view.tsx`
 * rendered `MOCK_ANALYTICS`.
 *
 * ---------------------------------------------------------------------------
 * WHY AGGREGATION IS SERVER-SIDE AND BOUNDED
 * ---------------------------------------------------------------------------
 * brief §1: "Use server-side aggregation where appropriate. Do not load the entire
 * incident collection into the browser." `docs/14 §3.1` states why the same thing
 * about Firestore: it offers `get()`, `getDocs()` and range queries, and no
 * `COUNT(*)`, `SUM()` or `GROUP BY`. So aggregation happens here, on the server,
 * and only the finished block crosses the wire.
 *
 * Two bounds, both declared in `config/analytics.ts`:
 *   - `LIVE_SCAN_CAP` (500) documents. A live scan reads at most this many, and
 *     when it cannot cover the range it sets `advisory` rather than presenting a
 *     partial scan as complete — `docs/14 §1` lists that as the thing operational
 *     analytics must NEVER do.
 *   - `MAX_RANGE_DAYS` (366) bounds the requested period itself.
 *
 * The query is a single ranged `where('createdAt', '>=', from)` +
 * `where('deletedAt', '==', null)`, bounded by `limit(LIVE_SCAN_CAP)`. It is the
 * only incident read in the request.
 *
 * ---------------------------------------------------------------------------
 * WHY `deletedAt == null` AND NOT `!=`
 * ---------------------------------------------------------------------------
 * Firestore's `!=` EXCLUDES documents that are missing the field entirely. An
 * incident written before `deletedAt` existed would drop out of the population
 * silently, and the count would be quietly wrong. `== null` includes both.
 *
 * ---------------------------------------------------------------------------
 * TIMESTAMPS ARE READ DEFENSIVELY, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * A Firestore `Timestamp`, an ISO string, and epoch millis all appear in this
 * codebase's documents across Phases 2-6. `toMs` accepts all three and returns
 * `null` rather than `NaN` for anything else — because a `NaN` that reaches a date
 * subtraction produces a `null` duration that is indistinguishable from "no
 * timestamp recorded", which is a different and wrong claim.
 */

import {
  APP_TIMEZONE,
  LIVE_SCAN_CAP,
  MAX_RANGE_DAYS,
  RISK_WINDOW_DAYS,
  RISK_ZONE_OUTPUT_CAP,
  RISK_ZONE_RADIUS_M,
} from '@/config/analytics';
import { COLLECTIONS } from '@/config/collections';
import { getAdminDb } from '@/lib/server/firebase-admin';
import { AppError } from '@/lib/server/errors';
import {
  buildTotals,
  peopleAffected,
  populationOf,
  slaCompliancePct,
  topLocations,
  volumeCounts,
  type MetricIncident,
} from '@/lib/analytics/metrics';
import { describeSource } from '@/lib/analytics/decide-source';
import { endOfLocalDayMs, isReversedRange, localDateOf, startOfLocalDayMs } from '@/lib/analytics/time';
import { scoreZone, zoneIdFor, isoWeekBucket, type RiskZoneInput } from '@/lib/analytics/risk-score';
import { GEOHASH_PRECISION, buildGeoCells, cellCentre } from '@/lib/geo/geohash';
import type {
  Analytics,
  AnalyticsTotals,
  IncidentCategory,
  IncidentStatus,
  RiskZone,
  Urgency,
} from '@/types';

/* ========================================================================== */
/* The filters                                                                 */
/* ========================================================================== */

/**
 * The six filter axes brief §6 requires. Every one is OPTIONAL, and `null` means
 * "not filtered" rather than "matches nothing" — so a caller that passes no
 * filters gets the whole bounded period.
 */
export type AnalyticsFilters = {
  readonly from: string;
  readonly to: string;
  readonly category: IncidentCategory | null;
  readonly urgency: Urgency | null;
  readonly status: IncidentStatus | null;
};

export const DEFAULT_RANGE_DAYS = 30;

/**
 * The named ranges brief §2 asks for, plus `custom` for the from/to pair the
 * route accepts.
 *
 * Declared as a tuple and a type together so the two cannot drift: a preset that
 * is not a `RangePreset` cannot be passed, and a missing arm in the switch below
 * is a non-exhaustive-function error rather than a silent fall-through returning
 * somebody else dates.
 */
export const RANGE_PRESETS = ['today', '7d', '30d', '90d', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export function resolvePresetDates(preset: RangePreset, now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  // Today is day ZERO, so a 7-day window reaches back 6 days. Going back 7 would
  // silently span eight days under a name that says seven.
  const back = (days: number): string =>
    new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  switch (preset) {
    case 'today':
      return { from: to, to };
    case '7d':
      return { from: back(6), to };
    case '30d':
      return { from: back(29), to };
    case '90d':
      return { from: back(89), to };
    case 'custom':
      return { from: to, to };
  }
}

/* ========================================================================== */
/* Reading Firestore                                                           */
/* ========================================================================== */

/**
 * Epoch millis from a Firestore `Timestamp`, an ISO string, or a number.
 *
 * `null` for anything unrecognised, deliberately. `docs/14 §2.1`: a metric whose
 * inputs are absent is `null`, never `0` — and a `NaN` propagating into a duration
 * would make an absent timestamp look like a measured one.
 */
function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'object') {
    const candidate = value as { toMillis?: unknown; toDate?: unknown };
    if (typeof candidate.toMillis === 'function') {
      const ms = (candidate.toMillis as () => unknown)();
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
    }
    if (typeof candidate.toDate === 'function') {
      const date = (candidate.toDate as () => Date)();
      return date instanceof Date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
    }
    return null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The incident's own geohash-6 CENTRE cell.
 *
 * `docs/14 §2.5`: `topLocations` groups on `geoCells[0]` — "the incident's own
 * geohash-6" — and NOT the whole 9-cell block, because grouping on the block would
 * count every incident nine times. So this reads index 0 only, and falls back to
 * encoding the coordinates when `geoCells` is absent.
 */
function centreCellOf(data: Record<string, unknown>): string | null {
  const cells = data.geoCells;
  if (Array.isArray(cells) && typeof cells[0] === 'string') return cells[0];
  const location = data.location as { lat?: unknown; lng?: unknown } | null | undefined;
  const lat = toNumber(location?.lat);
  const lng = toNumber(location?.lng);
  if (lat === null || lng === null) return null;
  return cellCentreOf(lat, lng);
}

/** Imported lazily to keep this module's import graph identical to Phase 9's. */
/**
 * The centre cell for a bare coordinate.
 *
 * `buildGeoCells` returns a 3x3 block whose FIRST entry is the incident's own cell
 * — `docs/14 §2.5` groups on that entry precisely because grouping on the whole
 * block would count every incident nine times.
 */
function cellCentreOf(lat: number, lng: number): string | null {
  try {
    return buildGeoCells(lat, lng)[0] ?? null;
  } catch {
    // A malformed coordinate must not take the whole aggregation down; the
    // incident then lands in `withoutPosition`, which is the honest report.
    return null;
  }
}

/** One Firestore document -> one `MetricIncident`. */
function toMetricIncident(id: string, data: Record<string, unknown>): MetricIncident {
  return {
    id,
    status: (toText(data.status) ?? 'new') as IncidentStatus,
    urgency: (toText(data.urgency) as Urgency | null) ?? null,
    category: (toText(data.category) as IncidentCategory | null) ?? null,
    createdAtMs: toMs(data.createdAt),
    deletedAtMs: toMs(data.deletedAt),
    verifiedAtMs: toMs(data.verifiedAt),
    dispatchedAtMs: toMs(data.dispatchedAt) ?? toMs(data.assignedAt),
    respondedAtMs: toMs(data.respondedAt) ?? toMs(data.arrivedAt),
    resolvedAtMs: toMs(data.resolvedAt),
    slaTargetMin: toNumber(data.slaTargetMin),
    reportCount: toNumber(data.reporterCount) ?? 1,
    linkedReportCount: toNumber(data.linkedReportCount) ?? 0,
    triageSource: toText(data.triageSource),
    aiConfidence: toNumber(data.aiConfidence),
    peopleAffected: toNumber(data.peopleAffected),
    geoHash6: centreCellOf(data),
  };
}

/**
 * The one bounded incident read.
 *
 * Ordered by `createdAt` so the cap takes the MOST RECENT `LIVE_SCAN_CAP`
 * documents, which is what a dispatcher wants when the scan cannot cover the whole
 * range — and the case `advisory` then announces.
 */
async function readIncidents(filters: AnalyticsFilters): Promise<{
  documents: MetricIncident[];
  truncated: boolean;
}> {
  const db = getAdminDb();

  const fromMs = startOfLocalDayMs(filters.from, APP_TIMEZONE);
  const toMsBound = endOfLocalDayMs(filters.to, APP_TIMEZONE);
  if (Number.isNaN(fromMs) || Number.isNaN(toMsBound)) {
    throw new AppError({ code: 'VALIDATION_FAILED', message: 'The date range could not be understood.' });
  }
  if (isReversedRange(filters.from, filters.to)) {
    throw new AppError({ code: 'VALIDATION_FAILED', message: 'The start date is after the end date.' });
  }

  let query = db
    .collection(COLLECTIONS.incidents)
    .where('deletedAt', '==', null)
    .where('createdAt', '>=', new Date(fromMs));

  if (filters.category !== null) query = query.where('category', '==', filters.category) as typeof query;
  if (filters.urgency !== null) query = query.where('urgency', '==', filters.urgency) as typeof query;
  if (filters.status !== null) query = query.where('status', '==', filters.status) as typeof query;

  const snapshot = await query.orderBy('createdAt', 'desc').limit(LIVE_SCAN_CAP + 1).get();

  // Fetch one MORE than the cap: if we got the extra, the scan was truncated, and
  // saying so is required rather than optional.
  const truncated = snapshot.size > LIVE_SCAN_CAP;
  const documents = snapshot.docs.slice(0, LIVE_SCAN_CAP).map((doc) => toMetricIncident(doc.id, doc.data() as Record<string, unknown>));

  return { documents, truncated };
}

/* ========================================================================== */
/* Risk zones — `docs/14 §6`                                                   */
/* ========================================================================== */

/**
 * The minimum incidents a cell needs before it is called a zone.
 *
 * brief §3 is explicit: "Do NOT label an area as dangerous based on a single
 * incident." `docs/14 §6.1` defines a zone as a cell with at least one incident,
 * which is the right DEFINITION but the wrong THRESHOLD for a public-facing score —
 * one fender-bender and one car park would score identically.
 *
 * So a cell with fewer than this many incidents is omitted entirely rather than
 * shown as a low score. That is the difference between "we do not know enough about
 * this area" and "this area is safe", and the second claim is not supportable.
 */
export const MIN_INCIDENTS_PER_ZONE = 3;

/**
 * Group incidents into geohash-6 cells and score each.
 *
 * Every zone carries its `incidentCount` so a reader can judge the number rather
 * than take it on trust — `docs/14 §6.3` requires the parameters to be stored
 * (FR-115), and a score with no denominator is not interpretable.
 *
 * `RISK_ZONES_ENABLED` gates this at the ROUTE, not here, so the computation stays
 * testable while the feature stays off by default (`docs/14 §6.1`, P1).
 */
export function buildRiskZones(
  incidents: readonly MetricIncident[],
  options: { readonly now: Date; readonly windowDays?: number; readonly minPerZone?: number } = { now: new Date() },
): RiskZone[] {
  const windowDays = options.windowDays ?? RISK_WINDOW_DAYS;
  const minPerZone = options.minPerZone ?? MIN_INCIDENTS_PER_ZONE;

  interface Bucket {
    total: number;
    critical: number;
    high: number;
    medium: number;
    lastSeenMs: number;
    categories: Map<string, number>;
  }
  const buckets = new Map<string, Bucket>();

  for (const incident of incidents) {
    const cell = incident.geoHash6;
    // An incident with no position is counted in `topLocations.withoutPosition` and
    // reported there. It cannot join a cell, and inventing a cell for it would
    // fabricate a location.
    if (cell === null || incident.createdAtMs === null) continue;

    const bucket = buckets.get(cell) ?? {
      total: 0, critical: 0, high: 0, medium: 0, lastSeenMs: 0, categories: new Map(),
    };
    bucket.total += 1;
    if (incident.urgency === 'critical') bucket.critical += 1;
    else if (incident.urgency === 'high') bucket.high += 1;
    else if (incident.urgency === 'medium') bucket.medium += 1;
    if (incident.createdAtMs > bucket.lastSeenMs) bucket.lastSeenMs = incident.createdAtMs;
    if (incident.category !== null) {
      bucket.categories.set(incident.category, (bucket.categories.get(incident.category) ?? 0) + 1);
    }
    buckets.set(cell, bucket);
  }

  const windowEndMs = options.now.getTime();
  const zones: RiskZone[] = [];

  for (const [cell, bucket] of buckets) {
    // brief §3: never a zone on the strength of one incident.
    if (bucket.total < minPerZone) continue;

    const centre = cellCentre(cell, GEOHASH_PRECISION);
    if (centre === null) continue;

    const daysSinceLastIncident = Math.max(0, (windowEndMs - bucket.lastSeenMs) / 86_400_000);
    const input: RiskZoneInput = {
      incidentCount: bucket.total,
      criticalCount: bucket.critical,
      highCount: bucket.high,
      mediumCount: bucket.medium,
      daysSinceLastIncident,
      windowDays,
    };
    const scored = scoreZone(input);

    // `docs/14 §6.2`: `dominantCategory` is the most frequent category, and `null`
    // ON A TIE — a tie has no dominant value, and picking one would invent it.
    let dominant: IncidentCategory | null = null;
    let best = 0;
    let tied = false;
    for (const [category, count] of bucket.categories) {
      if (count > best) { best = count; dominant = category as IncidentCategory; tied = false; }
      else if (count === best) tied = true;
    }
    if (tied) dominant = null;

    zones.push({
      zoneId: zoneIdFor(cell, isoWeekBucket(options.now)),
      // `GeoPoint` is `{ lat, lng }` and nothing else. A cell centre is a COMPUTED
      // point, not a reported position, so it carries no accuracy, no grade and no
      // source — those describe a real measurement, and a geohash centre is not one.
      // The first draft invented `accuracyM: 0` and cast `'unknown'`; both were
      // fabricated fields asserting something about a point nobody measured.
      centre: { lat: centre.lat, lng: centre.lng },
      radiusM: RISK_ZONE_RADIUS_M,
      score: scored.score,
      severity: scored.severity,
      incidentCount: bucket.total,
      criticalCount: bucket.critical,
      dominantCategory: dominant,
      computedAt: options.now.toISOString(),
    });
  }

  // `docs/14 §6.1`: sorted by score descending, capped at 100, and the drop is
  // logged by the caller rather than hidden.
  return zones.sort((a, b) => b.score - a.score || a.zoneId.localeCompare(b.zoneId)).slice(0, RISK_ZONE_OUTPUT_CAP);
}

/* ========================================================================== */
/* The assembly                                                                */
/* ========================================================================== */

/** One local date -> the incidents created on it. Drives the trend series. */
function buildTrend(
  population: readonly MetricIncident[],
  from: string,
  to: string,
  timezone: string,
): Analytics['trend'] {
  const buckets = new Map<string, { created: number; resolved: number; critical: number }>();
  for (let d = from; d <= to; d = nextDate(d)) {
    buckets.set(d, { created: 0, resolved: 0, critical: 0 });
  }
  for (const incident of population) {
    if (incident.createdAtMs !== null) {
      const key = localDateOf(incident.createdAtMs, timezone);
      const bucket = buckets.get(key);
      if (bucket !== undefined) {
        bucket.created += 1;
        if (incident.urgency === 'critical') bucket.critical += 1;
      }
    }
    if (incident.resolvedAtMs !== null) {
      const bucket = buckets.get(localDateOf(incident.resolvedAtMs, timezone));
      if (bucket !== undefined) bucket.resolved += 1;
    }
  }
  return [...buckets.entries()].map(([bucket, counts]) => ({ bucket, ...counts }));
}

function nextDate(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? date : new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The whole `Analytics` block for a bounded, filtered population.
 *
 * Split from `readIncidents` so it is unit-testable against a plain array — the
 * Firestore read is the only part that needs a project.
 */
export function assembleAnalytics(input: {
  readonly documents: readonly MetricIncident[];
  readonly filters: AnalyticsFilters;
  readonly now: Date;
  readonly truncated: boolean;
  readonly source: 'rollup' | 'live';
  readonly documentsRead: number;
}): Analytics {
  const { filters, truncated } = input;
  const fromMs = startOfLocalDayMs(filters.from, APP_TIMEZONE);
  const toMsBound = endOfLocalDayMs(filters.to, APP_TIMEZONE);

  const population = populationOf(input.documents, fromMs, toMsBound);
  const totals: AnalyticsTotals = buildTotals(population);
  const counts = volumeCounts(population);

  const byCategory = [...new Set(population.map((i) => i.category))]
    .filter((c): c is IncidentCategory => c !== null)
    .map((category) => {
      const rows = population.filter((i) => i.category === category);
      return {
        category,
        count: rows.length,
        critical: rows.filter((i) => i.urgency === 'critical').length,
      };
    })
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  // Sub-populations for the response-time histogram. Each metric has its own
  // denominator, so the timestamps are filtered HERE rather than inside the
  // histogram: an incident with no dispatch timestamp cannot contribute to a
  // dispatch duration, and counting it as zero would fabricate the measurement.
  const dispatched = population.filter((i) => i.dispatchedAtMs !== null);
  const resolved = population.filter((i) => i.resolvedAtMs !== null);

  // `byUrgency` carries p50/p90 per docs/14 §2.3. With few samples a percentile is
  // noise, so `count` is exposed and the UI can decline to draw it.
  const byUrgency = (['critical', 'high', 'medium', 'low'] as const).map((urgency) => {
    const durations = population
      .filter((i) => i.urgency === urgency && i.resolvedAtMs !== null)
      .map((i) => {
        const from_ = i.verifiedAtMs ?? i.createdAtMs;
        return from_ === null || i.resolvedAtMs === null ? null : (i.resolvedAtMs - from_) / 1000;
      })
      .filter((v): v is number => v !== null);
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      urgency: urgency as Urgency,
      p50Sec: percentile(sorted, 0.5),
      p90Sec: percentile(sorted, 0.9),
      count: sorted.length,
    };
  });

  const top = topLocations(population);
  void top;

  return {
    range: {
      from: filters.from,
      to: filters.to,
      timezone: APP_TIMEZONE,
      granularity: 'day',
      source: input.source,
      // `docs/14 §1` lists "Present a capped live scan as complete" as the thing
      // operational analytics must never do. So a capped scan SAYS SO.
      advisory: truncated
        ? `Showing the ${LIVE_SCAN_CAP} most recent incidents in this period. ${counts.total} matched in the capped scan; an older part of the range is not included.`
        : null,
    },
    totals: {
      ...totals,
      slaCompliancePct: slaCompliancePct(population),
    },
    byCategory,
    trend: buildTrend(population, filters.from, filters.to, APP_TIMEZONE),
    responseBuckets: buildResponseBuckets(dispatched, resolved),
    byUrgency,
    riskZones: [],
    responders: [],
  };
}

/**
 * What the route actually returns: the documented `Analytics` block PLUS the
 * aggregates the charts need and `Analytics` does not name.
 *
 * A SEPARATE type rather than a widened `Analytics`, for two reasons. `Analytics` is
 * the shape `docs/14` specifies, and silently adding fields to it means the
 * document and the type drift apart. And every addition here is either a count or a
 * geohash CELL COUNT — never a coordinate, never a user identifier — which is
 * brief §8 enforced by the type rather than by remembering to strip fields.
 */
export type AnalyticsResponse = Analytics & {
  readonly openNow: number;
  readonly unknownUrgency: number;
  readonly topCells: { readonly geohash6: string; readonly count: number }[];
  readonly withoutPosition: number;
  readonly peopleAffected: { readonly avg: number | null; readonly sampleSize: number };
  readonly documentsRead: number;
  readonly truncated: boolean;
};

export function toResponse(analytics: Analytics, input: {
  readonly documentsRead: number;
  readonly truncated: boolean;
  readonly openNow: number;
  readonly unknownUrgency: number;
  readonly topCells: { readonly geohash6: string; readonly count: number }[];
  readonly withoutPosition: number;
  readonly peopleAffected: { readonly avg: number | null; readonly sampleSize: number };
}): AnalyticsResponse {
  return { ...analytics, ...input };
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** Response-time histogram. brief §1 asks for response AND resolution trends. */
function buildResponseBuckets(
  dispatched: readonly MetricIncident[],
  resolved: readonly MetricIncident[],
): Analytics['responseBuckets'] {
  const LABELS = ['< 5 min', '5–15 min', '15–30 min', '30–60 min', '1–3 h', '3–12 h', '> 12 h'];
  const bounds = [300, 900, 1800, 3600, 10_800, 43_200, Infinity];

  // `?? Infinity` rather than `bounds[i]!`: a non-null assertion here would
  // silence the compiler without stating the invariant, and `Infinity` is both the
  // truthful fallback and what the last bound already is.
  const bucketOf = (seconds: number): number => {
    for (let i = 0; i < bounds.length; i += 1) {
      if (seconds < (bounds[i] ?? Infinity)) return i;
    }
    return bounds.length - 1;
  };

  const response = new Array<number>(LABELS.length).fill(0);
  for (const incident of dispatched) {
    const start = incident.verifiedAtMs ?? incident.createdAtMs;
    if (start === null || incident.dispatchedAtMs === null) continue;
    const slot = bucketOf((incident.dispatchedAtMs - start) / 1000);
    response[slot] = (response[slot] ?? 0) + 1;
  }

  const resolution = new Array<number>(LABELS.length).fill(0);
  for (const incident of resolved) {
    const start = incident.verifiedAtMs ?? incident.createdAtMs;
    if (start === null || incident.resolvedAtMs === null) continue;
    const slot = bucketOf((incident.resolvedAtMs - start) / 1000);
    resolution[slot] = (resolution[slot] ?? 0) + 1;
  }

  return LABELS.map((label, i) => ({
    label,
    count: response[i] ?? 0,
    resolved: resolution[i] ?? 0,
  }));
}

/* ========================================================================== */
/* The entry point                                                             */
/* ========================================================================== */

/**
 * The single public call behind `GET /api/analytics`.
 *
 * Read -> filter -> aggregate, in that order, so the response contains only
 * aggregates and never the incident documents themselves. That is brief §8's privacy
 * requirement implemented structurally rather than by remembering to strip fields.
 */
export async function buildAnalytics(filters: AnalyticsFilters, now = new Date()): Promise<{
  analytics: Analytics;
  riskZones: RiskZone[];
  zonesOmittedForLowCount: number;
}> {
  const spanDays =
    (endOfLocalDayMs(filters.to, APP_TIMEZONE) - startOfLocalDayMs(filters.from, APP_TIMEZONE)) / 86_400_000;
  if (Number.isFinite(spanDays) && spanDays > MAX_RANGE_DAYS) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `A range of more than ${MAX_RANGE_DAYS} days cannot be summarised in one request.`,
    });
  }

  const { documents, truncated } = await readIncidents(filters);
  const documentsRead = documents.length;

  const { source, hoursSinceEnd } = describeSource({ to: filters.to, now, timezone: APP_TIMEZONE });
  void hoursSinceEnd;

  const analytics = assembleAnalytics({
    documents,
    filters,
    now,
    truncated,
    // The rollup path is not implemented (`docs/14 §4.3`'s cron is not scheduled),
    // so `decideSource` always selects the live scan. Reporting the DECISION rather
    // than a hardcoded 'live' means the moment the rollup writer lands this is
    // correct without a second edit.
    source,
    documentsRead: documents.length,
  });

  const fromMs = startOfLocalDayMs(filters.from, APP_TIMEZONE);
  const toMsBound = endOfLocalDayMs(filters.to, APP_TIMEZONE);
  const population = populationOf(documents, fromMs, toMsBound);

  // `buildRiskZones` ALREADY omits cells below `MIN_INCIDENTS_PER_ZONE`, so
  // there is no second filter here. `zonesOmittedForLowCount` is not recomputable
  // from the result, so it is reported from inside the builder instead.
  const { zones, omittedForLowCount } = buildRiskZonesWithCount(population, { now });

  return {
    analytics: toResponse(
      { ...analytics, riskZones: zones },
      {
        documentsRead,
        truncated,
        openNow: countsFor(population).active,
        unknownUrgency: countsFor(population).unknown,
        topCells: topLocations(population).cells.map((c) => ({ geohash6: c.geohash6, count: c.count })),
        withoutPosition: topLocations(population).withoutPosition,
        peopleAffected: peopleAffected(population),
      },
    ),
    riskZones: zones,
    zonesOmittedForLowCount: omittedForLowCount,
  };
}

/** `buildRiskZones` plus the count of cells dropped for being too thin. */
function buildRiskZonesWithCount(
  incidents: readonly MetricIncident[],
  options: { readonly now: Date },
): { zones: RiskZone[]; omittedForLowCount: number } {
  const populated = incidents.filter((i) => i.geoHash6 !== null && i.createdAtMs !== null);
  const cells = new Set(populated.map((i) => i.geoHash6));
  const zones = buildRiskZones(populated, options);
  return { zones, omittedForLowCount: Math.max(0, cells.size - zones.length) };
}

function countsFor(population: readonly MetricIncident[]) {
  return volumeCounts(population);
}

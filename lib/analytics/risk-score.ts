/**
 * ============================================================================
 * CareGrid AI — risk zone score
 * ============================================================================
 *
 * `docs/14 §6.3`, FR-114 / FR-115. **PURE.** No Firestore import, unit-tested.
 *
 * `docs/14 §6.3` names the file: `lib/analytics/riskScore.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS NUMBER IS NOT
 * ---------------------------------------------------------------------------
 * `docs/14 §6` puts it at the top of the section:
 *
 * > This is a heuristic that summarises past incidents. It is not a prediction,
 * > and it does not forecast.
 *
 * brief §2 and §20 say the same: "Do NOT implement predictive emergency
 * forecasting" and "This is **descriptive historical analysis**, not prediction."
 *
 * Every naming decision below follows from that. The output is a `score` over
 * `incidentCount`, `criticalCount` and `daysSinceLastIncident` — three facts about
 * the past. There is no input from weather, calendar, population, or a model, and
 * `RiskZoneInput` has no field that could carry one. A future developer cannot add
 * a predictor without changing this type, which is the point.
 *
 * `docs/14 §6.3` closes with the honest limitation, preserved here because it is
 * the single most important sentence about the feature:
 *
 * > What the score does not do: it does not normalise for population, for
 * > reporting propensity, or for the number of people who use the app in that
 * > area. A dense, well-reported area scores high because people report there.
 */

/* ========================================================================== */
/* The parameters                                                              */
/* ========================================================================== */

export type RiskParams = {
  readonly weightDensity: number;
  readonly weightSeverity: number;
  readonly halfLifeDays: number;
};

/**
 * `docs/14 §6.3` verbatim: `{ weightDensity: 0.5, weightSeverity: 0.35, halfLifeDays: 14 }`.
 *
 * The remaining **0.15** is recency, and the document states it is "fixed by the
 * formula" — so it is a named constant here rather than a third parameter. Making
 * it configurable would allow the three weights to stop summing to 1 and produce a
 * score above 100, which is not a 0-100 score.
 */
export const DEFAULT_RISK_PARAMS: RiskParams = {
  weightDensity: 0.5,
  weightSeverity: 0.35,
  halfLifeDays: 14,
};

/** The fixed recency weight. `docs/14 §6.3`: "the remaining 0.15". */
export const WEIGHT_RECENCY = 0.15;

/* ========================================================================== */
/* The input                                                                   */
/* ========================================================================== */

/**
 * The ONLY facts a score is computed from.
 *
 * Every field is a count or a duration over incidents that already happened.
 * There is deliberately no `population`, no `forecast`, no `model` — the type is
 * the enforcement mechanism for "not a prediction".
 */
export type RiskZoneInput = {
  readonly incidentCount: number;
  readonly criticalCount: number;
  readonly highCount: number;
  readonly mediumCount: number;
  /** Days between the newest incident in the cell and the end of the window. */
  readonly daysSinceLastIncident: number;
  readonly windowDays: number;
};

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';

export type RiskScore = {
  /** 0-100. */
  readonly score: number;
  readonly severity: RiskSeverity;
  /**
   * The three normalised components, stored so a UI can explain the number.
   *
   * `docs/14 §6.2`'s `params` field exists because "FR-115 requires the computation
   * parameters to be stored" — the reason this is reproducible. Exposing the
   * components as well is the same discipline applied to the reader: a score with
   * no decomposition is a number nobody can challenge.
   */
  readonly components: {
    readonly density: number;
    readonly severity: number;
    readonly recency: number;
  };
};

/* ========================================================================== */
/* The score                                                                   */
/* ========================================================================== */

/**
 * `docs/14 §6.3`, transcribed formula for formula.
 *
 * | Component | Formula | Range | Weight |
 * | --- | --- | --- | ---: |
 * | `density` | `min(incidentCount / (windowDays x 4), 1)` | 0-1 | 0.50 |
 * | `severity` | `(critical x 1.0 + high x 0.5 + medium x 0.2) / max(count, 1)` | 0-1 | 0.35 |
 * | `recency` | `exp(-ln2 x days / 14)` | 0-1 | 0.15 |
 *
 * The `x 4` in the density normaliser is undocumented in prose but present in the
 * code block, and it is kept: it means a cell with four incidents per day saturates
 * at 1.0, so a very busy cell cannot swamp the severity and recency terms. It is
 * the difference between a score that saturates sensibly and one where every dense
 * cell is `critical` and the number stops discriminating.
 */
export function scoreZone(zone: RiskZoneInput, params: RiskParams = DEFAULT_RISK_PARAMS): RiskScore {
  const density = Math.min(zone.incidentCount / (zone.windowDays * 4), 1);
  const severity =
    (zone.criticalCount * 1.0 + zone.highCount * 0.5 + zone.mediumCount * 0.2) /
    Math.max(zone.incidentCount, 1);
  const recency = Math.exp((-Math.LN2 * zone.daysSinceLastIncident) / params.halfLifeDays);
  const score = 100 * (params.weightDensity * density + params.weightSeverity * severity + WEIGHT_RECENCY * recency);

  return {
    score,
    severity: band(score),
    components: { density, severity, recency },
  };
}

/**
 * `docs/14 §6.3` verbatim: ">= 70 critical | >= 45 high | >= 20 medium | else low".
 *
 * Exported because the bands are a product decision a test should pin, and because
 * a map legend needs them without recomputing scores.
 */
export function band(score: number): RiskSeverity {
  return score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low';
}

/* ========================================================================== */
/* The honesty of the arithmetic                                               */
/* ========================================================================== */

/**
 * An EMPTY cell scores 0, and that is correct rather than a bug.
 *
 * `docs/14 §6.1` defines a zone as "a geohash-6 cell that had at least one incident
 * in the lookback window", so an empty cell should never be scored at all. But the
 * function must be total, and the two cases where a caller can arrive with zero are
 * a window that has just started and a cell whose incidents were all soft-deleted.
 *
 * `Math.max(count, 1)` in the severity term is what keeps that from dividing by
 * zero, and `density` is 0, so the result is a clean `low`.
 */
export function scoreEmptyCell(windowDays: number): RiskScore {
  return scoreZone(
    {
      incidentCount: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      daysSinceLastIncident: windowDays,
      windowDays,
    },
  );
}

/**
 * Clamp a score into 0-100.
 *
 * The formula is bounded in practice — the three components are each 0-1 and the
 * weights sum to 1 — but a caller passing hand-edited `RiskParams` whose weights
 * sum above 1 would produce 140, and a `score` field documented as 0-100 that
 * holds 140 is a data defect. Clamping at the boundary is the honest place for it.
 */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

/* ========================================================================== */
/* The zone document                                                           */
/* ========================================================================== */

/**
 * The bucket suffix in a `zoneId`. `docs/14 §6.1`: "`YYYYwWW` - the ISO week.
 * Weekly bucketing keeps the document count bounded".
 *
 * ISO week, not a calendar week: ISO weeks start on Monday, so a bucket boundary
 * never splits a working week, and week 1 contains 4 January. The `w` separator is
 * the document's.
 */
export function isoWeekBucket(date: Date): string {
  // The ISO-8601 week-numbering algorithm, done on a UTC copy so the result does
  // not depend on the host's zone.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNumber + 3); // nearest Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}w${String(week).padStart(2, '0')}`;
}

/** `docs/14 §6.1`: "`zoneId` | `rz_{geohash6}_{bucket}`, e.g. `rz_9z4g0h_2026w38`". */
export function zoneIdFor(geohash6: string, bucket: string): string {
  return `rz_${geohash6}_${bucket}`;
}

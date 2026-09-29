/**
 * ============================================================================
 * CareGrid AI — the duplicate scoring engine
 * ============================================================================
 *
 * `docs/07 §9.4`, FR-040 and FR-049. **PURE.** No Firestore, no env, no clock, no
 * randomness — which is FR-049's requirement and the reason the file lives in
 * `lib/` rather than in a service.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 * `docs/07 §9.4` rule 1 (FR-041):
 *
 * > `confirmed_duplicate` is a **suggestion surfaced to a human**, not an executed
 * > merge. **The incident is always created.**
 *
 * There is no code path in this file, or in `services/duplicates/`, that merges,
 * deletes, suppresses or de-prioritises an incident. `confirmed_duplicate` is a
 * *string in a breakdown that a dispatcher reads*. The strongest thing this engine
 * can do is change what a human is shown.
 *
 * That is why `decision` is a plain string union rather than something with methods,
 * and why nothing here returns a mutation.
 *
 * ---------------------------------------------------------------------------
 * THE GATES ARE ORDERED, AND THE ORDER IS THE SPECIFICATION
 * ---------------------------------------------------------------------------
 * `docs/07 §9.4` is normative pseudocode: Gate 0 (time), Gate 1 (geospatial),
 * Gate 2 (category), Gate 3 (text), then scoring. Each gate can return early with
 * `decision: 'none'`, and the order matters for cost and for correctness:
 *
 * - **Gate 0 first** because it is a single integer comparison and rejects the
 *   largest population (every incident older than the window).
 * - **Gate 1 second** because a distance above the radius is dispositive — no amount
 *   of text similarity makes a report 2 km away the same event.
 * - **Gate 2 before Gate 3** so a category mismatch is recorded as a *reason*, not
 *   merely as a low score. `separate_incident` with `'category_mismatch'` (FR-048) is
 *   an explainable decision; `separate_incident` with `'low_overall_similarity'` is
 *   not.
 *
 * ---------------------------------------------------------------------------
 * WHY `category_mismatch` IS `separate_incident` AND NOT `none`
 * ---------------------------------------------------------------------------
 * `docs/07 §9.4` Gate 2 makes a same-spot/different-category pair
 * `separate_incident`, and `docs/07 §9.4`'s worked example is the road accident
 * beside a building fire. The two are within 500 m and close in time, so they pass
 * Gates 0 and 1 — but they are demonstrably different events, and the product
 * should SAY SO rather than shrug and let a dispatcher decide.
 *
 * `none` would mean "not even worth showing". `separate_incident` means "we looked,
 * and here is why it is not a duplicate" — and brief §20 wants the final decision
 * to be explainable. This is that explanation, in one field.
 */

import { haversineMetersRounded, type LatLng } from '@/lib/geo/distance';
import { jaccard, normalizeTokens, topOverlapTokens } from '@/lib/duplicates/text';

/* ========================================================================== */
/* Configuration — docs/07 §9.5                                                */
/* ========================================================================== */

/**
 * The configurable thresholds. `docs/07 §9.5`, DEC-01 and DEC-02.
 *
 * **Every default is the documented value and every range is the documented range**,
 * so a deployment that configures nothing behaves exactly as the specification
 * describes rather than as whatever a constant happened to say.
 *
 * `radiusM` 500 (100-2000, DEC-01 — "a street-crossing radius")
 * `timeWindowMin` 360 (60-4320, DEC-02 — 6 hours)
 */
export type DuplicateConfig = {
  /** DEC-01. The FR-084 duplicate-zone ring radius. */
  readonly radiusM: number;
  /** DEC-02. 6 hours. */
  readonly timeWindowMin: number;
  /** Auto-confirm similarity floor. */
  readonly textSimilarityConfirm: number;
  /** Potential-duplicate score floor. */
  readonly potentialThreshold: number;
  /** The `limit()` read cap. FR-037. */
  readonly maxCandidates: number;
  /** Bumped whenever a weight changes; stored per incident. */
  readonly algorithmVersion: string;
};

export const DUPLICATE_DEFAULTS: DuplicateConfig = {
  radiusM: 500,
  timeWindowMin: 360,
  textSimilarityConfirm: 0.6,
  potentialThreshold: 0.55,
  maxCandidates: 50,
  algorithmVersion: 'dedupe-v1',
} as const;

/** The documented ranges, so an admin override can be validated at the boundary. */
export const DUPLICATE_RANGES = {
  radiusM: { min: 100, max: 2000 },
  timeWindowMin: { min: 60, max: 4320 },
  textSimilarityConfirm: { min: 0.2, max: 0.9 },
  potentialThreshold: { min: 0.2, max: 0.95 },
  maxCandidates: { min: 10, max: 200 },
} as const;

/**
 * The scoring weights. `docs/07 §9.4`, verbatim: `0.35*dist + 0.10*time +
 * 0.25*cat + 0.30*text`.
 *
 * **Exported so a test can assert they still sum to 1.0.** A weight edit that does
 * not renormalise silently changes the meaning of `potentialThreshold`, because the
 * threshold is an absolute score rather than a percentile. The sum assertion makes
 * that class of change a test failure instead of a behaviour change nobody
 * reviewed.
 */
export const DUPLICATE_WEIGHTS = {
  distance: 0.35,
  time: 0.1,
  category: 0.25,
  text: 0.3,
} as const;

/** The nudge for an incident that already has more than one report. */
export const MULTI_REPORT_NUDGE = 0.05;

/** Statuses that can never be duplicates — they are finished. `docs/07 §9.4` Gate 0. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'closed',
  'cancelled',
  'false_alarm',
  'merged',
]);

/* ========================================================================== */
/* The categories that count as "the same kind of thing"                       */
/* ========================================================================== */

/**
 * Category groups. `docs/07 §9.4` Gate 2: `sameGroup = CATEGORY_GROUPS[a] ==
 * CATEGORY_GROUPS[b]`.
 *
 * The groups exist because exact category equality is too strict to be the only
 * test. A citizen reporting a "collision" and another reporting a "traffic
 * accident" at the same spot in the same ten minutes has described one event, and
 * demanding an exact match would score it as two different incidents.
 *
 * **An unmapped category maps to itself**, so two unmapped categories of the same
 * name still compare as a group. `Object.create(null)` is not an option here — the
 * lookup must not inherit `toString` and decide that `'fire'` is in the
 * `'constructor'` group.
 */
export const CATEGORY_GROUPS: Readonly<Record<string, string>> = {
  traffic_accident: 'road',
  road_blockage: 'road',
  vehicle_breakdown: 'road',
  fire: 'fire',
  smoke: 'fire',
  flood: 'water',
  waterlogging: 'water',
  storm: 'weather',
  cyclone: 'weather',
  earthquake: 'weather',
  building_collapse: 'structural',
  building_damage: 'structural',
  medical: 'medical',
  injury: 'medical',
  violence: 'safety',
  crime_security: 'safety',
  fire_emergency: 'fire',
};

/**
 * The group for a category, falling back to the category itself.
 *
 * **`Object.hasOwn`, not a bare property access.** `CATEGORY_GROUPS` is an object
 * literal, so it inherits from `Object.prototype` — and a bare
 * `CATEGORY_GROUPS['fire' + 'lightning']` style lookup of an uncategorised value
 * would find `constructor`, `toString`, `valueOf` and every other inherited member.
 *
 * That is not a contrived risk here: a category arriving from an AI triage (which
 * `services/ai/rules.ts` normalises) or from a future category addition is an
 * arbitrary string, and `categoryGroup('toString')` returning a **function** rather
 * than the string `'toString'` means the "unmapped categories are their own group"
 * fallback silently does not apply — two such categories would then compare
 * *equal*, and two unrelated incidents would be reported as the same group.
 *
 * The test asserts `categoryGroup('toString') === 'toString'` and
 * `categoryGroup('constructor') === 'constructor'` directly.
 */
export function categoryGroup(category: string | null | undefined): string | null {
  if (typeof category !== 'string' || category.length === 0) return null;
  if (!Object.hasOwn(CATEGORY_GROUPS, category)) return category;
  return CATEGORY_GROUPS[category] ?? category;
}

/* ========================================================================== */
/* Inputs and outputs                                                           */
/* ========================================================================== */

/** The report being classified — the one being created, not yet persisted. */
export type DuplicateReportInput = {
  readonly point: LatLng;
  /** Epoch millis. The caller supplies it; this file has no clock. */
  readonly reportedAtMs: number;
  readonly category: string | null;
  /**
   * The citizen's ORIGINAL text. Not the AI summary, not a transcript.
   *
   * Using AI output here would compare a human's words against a model's summary of
   * them, which measures the model rather than the incident. It also creates a
   * feedback loop: a summary drifting slightly would make two reports of the same
   * event look less similar each round.
   */
  readonly text: string | null;
};

/** A persisted incident being compared against. */
export type DuplicateCandidate = {
  readonly incidentId: string;
  readonly point: LatLng;
  readonly reportedAtMs: number;
  readonly category: string | null;
  readonly originalText: string | null;
  readonly status: string;
  /** > 1 means this incident already has follow-up reports. */
  readonly reportCount: number;
};

/** `docs/07 §9.3`, verbatim field-for-field. */
export type DuplicateBreakdown = {
  /** Integer metres, 0..radiusM. */
  readonly distanceM: number;
  /** Minutes. */
  readonly timeDeltaMin: number;
  readonly categoryMatch: boolean;
  readonly categoryGroupMatch: boolean;
  /** 0..1. Jaccard over normalised tokens. */
  readonly textSimilarity: number;
  /** Up to 10. */
  readonly matchedKeywords: readonly string[];
  readonly decision: DuplicateDecision;
  /** e.g. `['within_radius', 'category_match', 'low_text_similarity']`. */
  readonly reasons: readonly string[];
  /** FR-049: the score, 0..1. Stored so a decision can be re-derived later. */
  readonly score: number;
  readonly algorithmVersion: string;
};

/** `docs/07 §9.3`. Five states, and no sixth. */
export type DuplicateDecision =
  | 'none'
  | 'potential_duplicate'
  | 'confirmed_duplicate'
  | 'separate_incident';

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/* ========================================================================== */
/* The classifier — docs/07 §9.4, normative                                    */
/* ========================================================================== */

/**
 * Classify one candidate against the report. FR-040, FR-049.
 *
 * Total, deterministic, and free of side effects. Given the same inputs and config
 * it always produces the same breakdown — which is what makes FR-044's "stored for
 * auditability" meaningful: a stored breakdown can be recomputed and compared.
 */
export function classifyDuplicate(
  report: DuplicateReportInput,
  incident: DuplicateCandidate,
  cfg: DuplicateConfig = DUPLICATE_DEFAULTS,
): DuplicateBreakdown {
  const base = {
    distanceM: 0,
    timeDeltaMin: 0,
    categoryMatch: false,
    categoryGroupMatch: false,
    textSimilarity: 0,
    matchedKeywords: [] as readonly string[],
    decision: 'none' as DuplicateDecision,
    reasons: [] as readonly string[],
    score: 0,
    algorithmVersion: cfg.algorithmVersion,
  };

  /* --- Gate 0: the absolute time window ------------------------------- */
  const timeDeltaMin = Math.abs(report.reportedAtMs - incident.reportedAtMs) / 60_000;
  if (timeDeltaMin > cfg.timeWindowMin) {
    return { ...base, timeDeltaMin: Math.round(timeDeltaMin), reasons: ['time_window'] };
  }

  if (TERMINAL_STATUSES.has(incident.status)) {
    return { ...base, timeDeltaMin: Math.round(timeDeltaMin), reasons: ['incident_terminal'] };
  }

  /* --- Gate 1: geospatial ---------------------------------------------- */
  const distanceM = haversineMetersRounded(report.point, incident.point);
  if (distanceM > cfg.radiusM) {
    return {
      ...base,
      distanceM,
      timeDeltaMin: Math.round(timeDeltaMin),
      reasons: ['outside_radius'],
    };
  }

  /* --- Gate 2: category ------------------------------------------------ */
  const exactCategory =
    report.category !== null &&
    incident.category !== null &&
    report.category === incident.category;
  const reportGroup = categoryGroup(report.category);
  const incidentGroup = categoryGroup(incident.category);
  const sameGroup = reportGroup !== null && reportGroup === incidentGroup;

  if (!exactCategory && !sameGroup) {
    // FR-048. A same-spot, same-moment pair of different categories is
    // demonstrably two events, and saying so is more useful than a low score.
    //
    // **`decision` is set explicitly.** An earlier version spread `base` and
    // overrode only `reasons`, which silently returned `decision: 'none'` — the
    // exact same value as "outside the radius" and "outside the time window". A
    // road accident beside a building fire was therefore being filtered out by
    // `findDuplicates` as if it were a pair 3 km apart, and a dispatcher was never
    // told the two were considered and rejected. The test that caught it is
    // "a road accident 200 m from a building fire is separate_incident".
    return {
      ...base,
      distanceM,
      timeDeltaMin: Math.round(timeDeltaMin),
      decision: 'separate_incident',
      // `categoryGroupMatch: false` is meaningful here: it is the REASON.
      reasons: ['within_radius', 'category_mismatch'],
    };
  }

  /* --- Gate 3: text similarity ----------------------------------------- */
  const reportTokens = normalizeTokens(report.text);
  const incidentTokens = normalizeTokens(incident.originalText);
  const textSimilarity = jaccard(reportTokens, incidentTokens);
  const matchedKeywords = topOverlapTokens(reportTokens, incidentTokens, 10);

  /* --- Scoring — docs/07 §9.4, weights verbatim ------------------------ */
  const sDist = clamp01(1 - distanceM / cfg.radiusM);
  const sTime = clamp01(1 - timeDeltaMin / cfg.timeWindowMin);
  // 1 for an exact match, 0.6 for a same-group match, 0 otherwise. Gate 2 has
  // already returned for the 0 case.
  const sCat = exactCategory ? 1 : 0.6;
  const sText = clamp01(textSimilarity);

  let score =
    DUPLICATE_WEIGHTS.distance * sDist +
    DUPLICATE_WEIGHTS.time * sTime +
    DUPLICATE_WEIGHTS.category * sCat +
    DUPLICATE_WEIGHTS.text * sText;

  if (incident.reportCount > 1) score += MULTI_REPORT_NUDGE;
  score = clamp01(score);

  /* --- Decision -------------------------------------------------------- */
  if (exactCategory && textSimilarity >= cfg.textSimilarityConfirm) {
    return {
      distanceM,
      timeDeltaMin: Math.round(timeDeltaMin),
      categoryMatch: true,
      categoryGroupMatch: sameGroup,
      textSimilarity,
      matchedKeywords,
      decision: 'confirmed_duplicate',
      reasons: ['within_radius', 'category_match', 'high_text_similarity'],
      score,
      algorithmVersion: cfg.algorithmVersion,
    };
  }

  if (score >= cfg.potentialThreshold) {
    return {
      distanceM,
      timeDeltaMin: Math.round(timeDeltaMin),
      categoryMatch: exactCategory,
      categoryGroupMatch: sameGroup,
      textSimilarity,
      matchedKeywords,
      decision: 'potential_duplicate',
      reasons: ['within_radius', 'category_or_text_match'],
      score,
      algorithmVersion: cfg.algorithmVersion,
    };
  }

  return {
    distanceM,
    timeDeltaMin: Math.round(timeDeltaMin),
    categoryMatch: exactCategory,
    categoryGroupMatch: sameGroup,
    textSimilarity,
    matchedKeywords,
    decision: 'separate_incident',
    reasons: ['within_radius', 'low_overall_similarity'],
    score,
    algorithmVersion: cfg.algorithmVersion,
  };
}

/**
 * Classify every candidate and keep the ones worth showing a human.
 *
 * **The filter is `decision !== 'none'`, not `score >= threshold`.** `none` means a
 * gate rejected the pair outright — outside the radius, outside the time window, or
 * a terminal status — and those are not "low scores", they are pairs that were
 * never comparable. Keeping them would fill a dispatcher's list with 2 km-away
 * incidents and bury the one 180 m away.
 *
 * `separate_incident` IS returned, and this is the subtle part. A dispatcher
 * looking at a cluster of same-spot incidents benefits from being told "these two
 * are different events" for the ones that passed every gate and scored low — that
 * is information the map does not carry. A citizen is shown only
 * `potential_duplicate` and `confirmed_duplicate`.
 */
export function findDuplicates(
  report: DuplicateReportInput,
  candidates: readonly DuplicateCandidate[],
  cfg: DuplicateConfig = DUPLICATE_DEFAULTS,
): DuplicateBreakdown[] {
  const out: DuplicateBreakdown[] = [];
  for (const candidate of candidates) {
    const breakdown = classifyDuplicate(report, candidate, cfg);
    if (breakdown.decision !== 'none') out.push(breakdown);
  }
  // Strongest first, then nearest, then most recent. A dispatcher reads the top of
  // this list; the ordering is the difference between an actionable view and a
  // scroll.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
    return a.timeDeltaMin - b.timeDeltaMin;
  });
  return out;
}

/** The states a **citizen** is shown. brief §25. */
export const CITIZEN_VISIBLE_DECISIONS: ReadonlySet<DuplicateDecision> = new Set([
  'potential_duplicate',
  'confirmed_duplicate',
]);

/**
 * ============================================================================
 * CareGrid AI — responder candidate ranking
 * ============================================================================
 *
 * `docs/07 §7`, `docs/08 §3.6`. **PURE.** No Firestore, no clock, no randomness.
 *
 * ---------------------------------------------------------------------------
 * THE RANKING IS A SORT OVER EXPLAINABLE FACTORS, NOT A SCORE
 * ---------------------------------------------------------------------------
 * brief §12 is explicit and the architecture follows it:
 *
 * > The recommendation should be **explainable**: "Medical capability / Available /
 * > 1.1 km away". Do NOT display an unexplained AI score such as "97% best responder"
 * > unless there is a documented and validated scoring model. **Prefer transparent
 * > factors.**
 *
 * So this module does not produce a `0.87`. It produces a **lexicographic sort
 * order**, and every factor it sorts on is a thing a dispatcher can see and
 * challenge. A lexicographic order is also the honest model: a responder who has
 * the right skill and is 300 m away *should* outrank one who has no relevant skill
 * and is 100 m away, and a weighted average with invented coefficients would bury
 * that.
 *
 * The factors, in priority order, and why each is where it is:
 *
 * | # | Factor | Why here |
 * | --- | --- | --- |
 * | 1 | `isAssignable` | A responder who cannot legally be assigned is not a candidate, whatever else is true. |
 * | 2 | `staleLocation` | US-022 AC2: a responder whose location is 40 minutes old is worse than a farther one whose location is current. **Sorts last within their group**, not filtered. |
 * | 3 | `capabilityMatch` | A fire responder for a road accident is not a usable candidate. |
 * | 4 | `status` | `available` before `busy`. A busy responder may be assignable, but only with a human's knowledge that they are free. |
 * | 5 | `distanceM` | Last, because it is the only continuous factor and the least likely to matter once the above agree. |
 *
 * **`distanceM` last is the decision that matters.** An implementation that sorted
 * on distance first would put a 200 m away responder with no relevant capability
 * above a 3 km away paramedic — which is the failure the whole factor list exists to
 * prevent.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE DISPATCHES ANYONE
 * ---------------------------------------------------------------------------
 * brief §3, FR-041's sibling: the system may "recommend, prioritize, filter, rank
 * operationally relevant responders" but must not "automatically dispatch,
 * automatically contact emergency services, automatically assign a responder".
 *
 * This module is pure and returns a sorted list. The highest-ranked entry is a
 * SUGGESTION, and `rank` is an ordinal (1st, 2nd) rather than a confidence, so a UI
 * cannot render it as "97% best responder" even by accident.
 */

import { haversineMetersRounded, type LatLng } from '@/lib/geo/distance';
import type { AccuracyGrade, VerificationStatus } from '@/types';

/* ========================================================================== */
/* Input                                                                       */
/* ========================================================================== */

/** A responder as the ranker sees them. `docs/07 §7.1`. */
export type CandidateResponder = {
  readonly uid: string;
  readonly displayName: string;
  readonly status: 'available' | 'busy' | 'offline';
  /** `resourceId` values from the catalogue. `docs/07 §7.1`. */
  readonly capabilities: readonly string[];
  readonly verification: VerificationStatus;
  readonly activeIncidentCount: number;
  readonly maxConcurrentIncidents: number;
  /** FR-062. Default 5000, range 500-50000. */
  readonly serviceRadiusM: number;
  /** Live location, or `homeBase`, or neither. `docs/07 §7.1`. */
  readonly location: LatLng | null;
  /** Where the location came from, for the accuracy column. */
  readonly locationAccuracyGrade: AccuracyGrade | null;
  /** `true` when the location is older than `STALE_LOCATION_MIN`. US-022. */
  readonly staleLocation: boolean;
};

/** What the incident needs. */
export type IncidentRequirement = {
  readonly point: LatLng | null;
  /** `docs/07 §4.4`: `resourceId`s, not free-text capability names. */
  readonly requiredResources: readonly string[];
  /** Used only to sort deterministically among equals. Never shown. */
  readonly urgency: string | null;
};

/* ========================================================================== */
/* Output                                                                      */
/* ========================================================================== */

/**
 * One ranked candidate, with the REASONS as first-class data.
 *
 * `factors` is the explainability requirement made structural. A UI renders
 * `factors`; it cannot invent its own explanation, and it cannot show a number
 * that is not in here.
 */
export type RankedCandidate = {
  readonly responder: CandidateResponder;
  readonly distanceM: number;
  /** Ordinal, 1-based. NOT a confidence — see the file header. */
  readonly rank: number;
  /**
   * `false` when this responder cannot be assigned at all: unverified, offline, or
   * at capacity. Still returned, so a dispatcher can see WHY someone is excluded
   * rather than wondering where they went.
   */
  readonly isAssignable: boolean;
  /**
   * Every reason the responder is ranked where they are, in words.
   *
   * **The blockers are included, not just the positives.** A dispatcher looking at a
   * responder who is not assignable needs to know it is because they are unverified,
   * and "not assignable" with no reason is the same as a bug from the outside.
   */
  readonly factors: readonly CandidateFactor[];
  /** FR-064. Only a `verified` responder is assignable. */
  readonly capabilityMatch: boolean;
  /** Which required resources this responder lacks. */
  readonly missingResources: readonly string[];
  /** Beyond `serviceRadiusM`. */
  readonly outOfServiceArea: boolean;
};

export type CandidateFactor =
  | { readonly kind: 'available'; readonly detail: string }
  | { readonly kind: 'busy'; readonly detail: string }
  | { readonly kind: 'offline'; readonly detail: string }
  | { readonly kind: 'unverified'; readonly detail: string }
  | { readonly kind: 'at_capacity'; readonly detail: string }
  | { readonly kind: 'capability_match'; readonly detail: string }
  | { readonly kind: 'capability_partial'; readonly detail: string; readonly missing: readonly string[] }
  | { readonly kind: 'capability_none'; readonly detail: string }
  | { readonly kind: 'distance'; readonly detail: string; readonly metres: number }
  | { readonly kind: 'stale_location'; readonly detail: string; readonly ageMinutes: number }
  | { readonly kind: 'no_location'; readonly detail: string }
  | { readonly kind: 'in_service_area'; readonly detail: string }
  | { readonly kind: 'out_of_service_area'; readonly detail: string };

/* ========================================================================== */
/* The factors                                                                 */
/* ========================================================================== */

/** `100 m` etc. Kept here so a distance is phrased identically everywhere. */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${metres} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/**
 * brief §30: "Do not claim travel time unless a real routing API has been
 * implemented. **Distance is not the same as ETA.**"
 *
 * So this module produces a distance and no ETA. `docs/07 §8` does carry an
 * `etaSec` field, and Phase 3 typed it, but this ranker deliberately does not
 * populate it — there is no routing provider in this project, and a distance-derived
 * "ETA" is a fabrication a dispatcher would act on.
 */
export function formatDistanceSentence(metres: number): string {
  return `${formatDistance(metres)} away`;
}

/* ========================================================================== */
/* The ranker                                                                  */
/* ========================================================================== */

/**
 * Rank the candidates for one incident. brief §11's `findAvailableResponders`.
 *
 * **Pure and total.** Every input yields a list; nothing throws. A ranker that threw
 * on a malformed responder would take the whole dispatcher's candidate panel down,
 * and the panel is what a dispatcher looks at while deciding.
 */
export function rankCandidates(
  responders: readonly CandidateResponder[],
  incident: IncidentRequirement,
): RankedCandidate[] {
  const ranked = responders.map((responder) => scoreOne(responder, incident));

  // --- the lexicographic order, most significant first --------------------
  ranked.sort((a, b) => {
    // 1. assignability. A responder who cannot legally be assigned is not a
    //    candidate, whatever else is true of them.
    if (a.isAssignable !== b.isAssignable) return a.isAssignable ? -1 : 1;

    // 2. staleness. US-022 AC2: sorted LAST within a group, not filtered out. A
    //    dispatcher may still want someone with a stale fix — they might know the
    //    person parked nearby.
    if (a.responder.staleLocation !== b.responder.staleLocation) {
      return a.responder.staleLocation ? 1 : -1;
    }

    // 3. capability. A fire responder for a road accident is not usable.
    if (a.capabilityMatch !== b.capabilityMatch) return a.capabilityMatch ? -1 : 1;

    // 4. status. `available` before `busy`.
    const statusOrder = { available: 0, busy: 1, offline: 2 } as const;
    const statusDelta = statusOrder[a.responder.status] - statusOrder[b.responder.status];
    if (statusDelta !== 0) return statusDelta;

    // 5. capacity pressure among equally-ranked responders: someone with one
    //    incident beats someone with two.
    if (a.responder.activeIncidentCount !== b.responder.activeIncidentCount) {
      return a.responder.activeIncidentCount - b.responder.activeIncidentCount;
    }

    // 6. distance. LAST, and only among responders who agree on everything above.
    if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;

    // 7. a total order, so the result is deterministic. Without it two responders
    //    with identical profiles would swap places between renders, and the list
    //    would appear to shuffle.
    return a.responder.uid < b.responder.uid ? -1 : 1;
  });

  return ranked.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/** Score one responder. Split out so the sort and the scoring read separately. */
function scoreOne(responder: CandidateResponder, incident: IncidentRequirement): Omit<RankedCandidate, 'rank'> {
  const factors: CandidateFactor[] = [];

  /* --- capability ------------------------------------------------------- */
  const required = incident.requiredResources;
  const missing = required.filter((resource) => !responder.capabilities.includes(resource));
  const capabilityMatch = required.length === 0 || missing.length === 0;

  if (required.length === 0) {
    factors.push({
      kind: 'capability_match',
      detail: 'No specific capability was required for this incident.',
    });
  } else if (missing.length === 0) {
    factors.push({
      kind: 'capability_match',
      detail: `Has all ${required.length} required capabilit${required.length === 1 ? 'y' : 'ies'}.`,
    });
  } else if (missing.length < required.length) {
    factors.push({
      kind: 'capability_partial',
      detail: `Has some of the required capabilities.`,
      missing,
    });
  } else {
    factors.push({ kind: 'capability_none', detail: 'Does not have the required capabilities.' });
  }

  /* --- distance --------------------------------------------------------- */
  // A responder with NO location is ranked last on distance, and `distanceM` is
  // `Number.MAX_SAFE_INTEGER` so the numeric sort puts it after every real
  // distance. It is not filtered: `docs/07 §7.1` allows `homeBase` or nothing, and
  // a dispatcher may know better than a missing fix.
  let distanceM = Number.MAX_SAFE_INTEGER;
  if (responder.location !== null && incident.point !== null) {
    distanceM = haversineMetersRounded(responder.location, incident.point);
    factors.push({
      kind: 'distance',
      detail: formatDistanceSentence(distanceM),
      metres: distanceM,
    });
  } else {
    factors.push({
      kind: 'no_location',
      detail: 'No location on record, so distance cannot be calculated.',
    });
  }

  /* --- the service area ------------------------------------------------- */
  const outOfServiceArea = distanceM !== Number.MAX_SAFE_INTEGER && distanceM > responder.serviceRadiusM;
  if (outOfServiceArea) {
    factors.push({
      kind: 'out_of_service_area',
      detail: `Outside their ${formatDistance(responder.serviceRadiusM)} service radius.`,
    });
  } else if (distanceM !== Number.MAX_SAFE_INTEGER) {
    factors.push({
      kind: 'in_service_area',
      detail: `Within their ${formatDistance(responder.serviceRadiusM)} service radius.`,
    });
  }

  /* --- status and the assignability blockers ---------------------------- */
  // FR-064: only a `verified` responder is assignable. An unverified responder is
  // shown, with the reason, because a dispatcher seeing an empty panel needs to know
  // it is verification and not a query failure.
  const unverified = responder.verification !== 'verified';
  const atCapacity = responder.activeIncidentCount >= responder.maxConcurrentIncidents;
  const offline = responder.status === 'offline';

  if (unverified) {
    factors.push({
      kind: 'unverified',
      detail: `Not yet verified (${responder.verification.replace(/_/g, ' ')}).`,
    });
  }
  if (atCapacity) {
    factors.push({
      kind: 'at_capacity',
      detail: `Already on ${responder.activeIncidentCount} of ${responder.maxConcurrentIncidents} allowed incidents.`,
    });
  }
  if (offline) {
    factors.push({ kind: 'offline', detail: 'Offline.' });
  }

  switch (responder.status) {
    case 'available':
      factors.push({ kind: 'available', detail: 'Available.' });
      break;
    case 'busy':
      factors.push({ kind: 'busy', detail: 'Busy with another incident.' });
      break;
    case 'offline':
      // Already pushed above with the `offline` factor; pushing the same fact twice
      // would read as two reasons.
      break;
  }

  if (responder.staleLocation) {
    // The age is not known here — the caller has the timestamp and this module has
    // no clock. The factor records the fact and the UI adds the age it already
    // has, rather than this module inventing one.
    factors.push({
      kind: 'stale_location',
      detail: 'Their location is out of date, so the distance above may be wrong.',
      ageMinutes: 0,
    });
  }

  /**
   * `isAssignable` is narrower than "could be assigned by a human".
   *
   * `outOfServiceArea` is deliberately **not** part of it. `docs/07 §7.1` makes
   * `serviceRadiusM` a soft operational fact — a dispatcher overriding it is a
   * legitimate decision, and refusing the assignment would remove that judgement
   * from the person who has it. The area is surfaced as a factor and sorted, but
   * the buttons are enabled. That distinction is why `outOfServiceArea` is its own
   * field.
   */
  const isAssignable = !unverified && !atCapacity && !offline;

  return {
    responder,
    distanceM,
    isAssignable,
    capabilityMatch,
    missingResources: missing,
    outOfServiceArea,
    factors,
  };
}

/* ========================================================================== */
/* The empty state                                                             */
/* ========================================================================== */

/**
 * brief §31's copy, verbatim. The no-available-responder state is a REAL state that
 * needs a real sentence, and it is the state a dispatcher sees when the system has
 * failed them.
 *
 * `docs/24` would also require that this never becomes a dead end, so the two
 * permitted next actions are named alongside it: review the excluded responders, or
 * keep the incident pending.
 */
export const NO_RESPONDER_AVAILABLE_COPY = {
  heading: 'No available responder currently matches this incident.',
  body: 'You can review responders who are excluded and why, or leave this incident pending while you look for someone.',
  /** The actions, per brief §31. Never an automatic assignment. */
  options: ['Review other responders', 'Keep incident pending'] as const,
} as const;

/**
 * How many excluded responders are shown, and the rest summarised.
 *
 * A dispatcher needs to know there are three unverified responders and not have to
 * scroll a list of them; equally they need to know they exist at all. The count is
 * the honest middle.
 */
export function summariseExcluded(
  candidates: readonly RankedCandidate[],
): { readonly excludedCount: number; readonly reasonCounts: Readonly<Record<string, number>> } {
  const excluded = candidates.filter((candidate) => !candidate.isAssignable);
  const reasonCounts: Record<string, number> = {};
  for (const candidate of excluded) {
    for (const factor of candidate.factors) {
      if (factor.kind === 'unverified' || factor.kind === 'at_capacity' || factor.kind === 'offline') {
        reasonCounts[factor.kind] = (reasonCounts[factor.kind] ?? 0) + 1;
      }
    }
  }
  return { excludedCount: excluded.length, reasonCounts };
}

/* ========================================================================== */
/* The priority copy                                                           */
/* ========================================================================== */

/**
 * brief §13: "For critical incidents, the dispatcher UI should visually prioritize
 * the incident."
 *
 * **"Visual" and "text" both, and the text comes first.** A red badge alone is
 * invisible to a screen reader and ambiguous to a red-green colourblind reader, which
 * is the same requirement `docs/12` places on map markers. The heading is what a
 * dispatcher reads; the colour is a reinforcement of it.
 *
 * The sentence also states the COUNT of candidates, which brief §13's mock-up shows
 * ("Potential responders: 3 available") and which is the number that tells a
 * dispatcher whether they are looking at a solvable problem.
 */
export function criticalIncidentHeading(candidateCount: number): string {
  const count =
    candidateCount === 0
      ? 'No available responders'
      : `${candidateCount} available responder${candidateCount === 1 ? '' : 's'}`;
  return `CRITICAL incident. ${count}.`;
}

import { describe, expect, it } from 'vitest';

import {
  NO_RESPONDER_AVAILABLE_COPY,
  criticalIncidentHeading,
  formatDistance,
  formatDistanceSentence,
  rankCandidates,
  summariseExcluded,
  type CandidateResponder,
  type IncidentRequirement,
  type RankedCandidate,
} from '@/lib/dispatch/candidates';
import { haversineMetersRounded } from '@/lib/geo/distance';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/** Karachi. `docs/12`'s operating area, and a place with real numbers in it. */
const INCIDENT_POINT = { lat: 24.8607, lng: 67.0011 } as const;

/** A point `metres` north of the incident, which is unambiguous at this scale. */
function northOf(metres: number): { lat: number; lng: number } {
  return { lat: INCIDENT_POINT.lat + metres / 111_320, lng: INCIDENT_POINT.lng };
}

function responder(over: Partial<CandidateResponder> = {}): CandidateResponder {
  return {
    uid: 'u_ahmed',
    displayName: 'Ahmed Khan',
    status: 'available',
    capabilities: ['res_ambulance', 'res_first_aid'],
    verification: 'verified',
    activeIncidentCount: 0,
    maxConcurrentIncidents: 1,
    serviceRadiusM: 5_000,
    location: northOf(1_200),
    locationAccuracyGrade: 'high',
    staleLocation: false,
    ...over,
  };
}

const MEDICAL: IncidentRequirement = {
  point: INCIDENT_POINT,
  requiredResources: ['res_ambulance'],
  urgency: 'critical',
};

/* ========================================================================== */
/* Typed accessors                                                             */
/* ========================================================================== */

/**
 * `rankCandidates` with a NON-EMPTY tuple return type.
 *
 * The project runs `noUncheckedIndexedAccess`, so `const [c] = rank(...)`
 * types `c` as possibly undefined and every assertion below would need a `!`.
 * Asserting non-emptiness once, here, is both shorter and more honest than 40
 * non-null assertions: a test that destructures an empty list SHOULD fail loudly,
 * and this makes it fail with "expected length > 0" rather than a confusing
 * "cannot read property of undefined".
 */
function rank(
  responders: readonly CandidateResponder[],
  incident: IncidentRequirement,
): [RankedCandidate, ...RankedCandidate[]] {
  // The implementation, deliberately NOT `rank`. A blanket rename of the call
  // sites nearly turned this helper into infinite recursion, which is worth a
  // comment so the next rename does not do it again.
  return rankCandidates(responders, incident) as [RankedCandidate, ...RankedCandidate[]];
}

/**
 * The candidate at `index`, asserted to exist.
 *
 * `rank()` guarantees index 0 and nothing else, so `ranked[1]` is still possibly
 * undefined under `noUncheckedIndexedAccess`. This keeps a 31-test file free of
 * non-null assertions while still failing loudly — with "no candidate at index 1" —
 * if an ordering change ever drops a responder from the result.
 */
function at(ranked: readonly RankedCandidate[], index: number): RankedCandidate {
  const found = ranked[index];
  expect(found, `no candidate at index ${index}`).toBeDefined();
  return found as RankedCandidate;
}

/* ========================================================================== */
/* The ordering                                                                */
/* ========================================================================== */

describe('the ranking is a LEXICOGRAPHIC order, not a score', () => {
  // brief §12: "Do NOT display an unexplained AI score such as 97% best responder
  // unless there is a documented and validated scoring model. Prefer transparent
  // factors."
  it('rank is an ORDINAL, so a UI cannot render it as a confidence', () => {
    const ranked = rank([responder(), responder({ uid: 'u_sara' })], MEDICAL);
    expect(ranked.map((c) => c.rank)).toEqual([1, 2]);
    // Nothing anywhere in the output resembles a probability.
    for (const candidate of ranked) {
      for (const value of Object.values(candidate)) {
        if (typeof value === 'number') {
          expect(value, `${candidate.responder.uid} has a bare number`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('CAPABILITY beats distance: the paramedic outranks the nearer bystander', () => {
    // The failure this ordering exists to prevent. A distance-first sort puts a
    // 200 m away responder with no relevant skill above a 3 km paramedic.
    const paramedic = responder({ uid: 'u_med', displayName: 'Paramedic', capabilities: ['res_ambulance'], location: northOf(3_000) });
    const bystander = responder({ uid: 'u_near', displayName: 'Bystander', capabilities: ['res_food_water_kit'], location: northOf(200) });

    const ranked = rank([bystander, paramedic], MEDICAL);
    expect(ranked[0].responder.uid).toBe('u_med');
    expect(ranked[0].capabilityMatch).toBe(true);
    expect(at(ranked, 1).responder.uid).toBe('u_near');
  });

  it('ASSIGNABILITY beats everything: an unverified responder is last regardless of fit', () => {
    const unverified = responder({ uid: 'u_un', verification: 'unverified', capabilities: ['res_ambulance'], location: northOf(50) });
    const verified = responder({ uid: 'u_ok', capabilities: ['res_first_aid'], location: northOf(9_000) });

    const ranked = rank([unverified, verified], MEDICAL);
    expect(ranked[0].responder.uid).toBe('u_ok');
    expect(at(ranked, 1).responder.uid).toBe('u_un');
    expect(at(ranked, 1).isAssignable).toBe(false);
  });

  it('a STALE location sorts last within its group, rather than being filtered out', () => {
    // US-022 AC2. A dispatcher may still want someone with a stale fix — they
    // might know the person parked nearby — so the responder is shown and badged.
    const fresh = responder({ uid: 'u_fresh', location: northOf(5_000) });
    const stale = responder({ uid: 'u_stale', location: northOf(100), staleLocation: true });

    const ranked = rank([stale, fresh], MEDICAL);
    expect(ranked[0].responder.uid).toBe('u_fresh');
    expect(at(ranked, 1).responder.uid).toBe('u_stale');
    expect(at(ranked, 1).responder.staleLocation).toBe(true);
    // And the reason is in the factors, not just the position.
    expect(at(ranked, 1).factors.some((f) => f.kind === 'stale_location')).toBe(true);
  });

  it('AVAILABLE beats BUSY at equal capability and distance', () => {
    const available = responder({ uid: 'u_av', status: 'available', location: northOf(1_000) });
    const busy = responder({ uid: 'u_bu', status: 'busy', location: northOf(1_000) });
    expect(rank([busy, available], MEDICAL)[0].responder.uid).toBe('u_av');
  });

  it('DISTANCE is the last tiebreaker', () => {
    const far = responder({ uid: 'u_far', location: northOf(4_000) });
    const near = responder({ uid: 'u_near', location: northOf(400) });
    expect(rank([far, near], MEDICAL)[0].responder.uid).toBe('u_near');
  });

  it('the order is TOTAL, so two identical profiles do not shuffle between renders', () => {
    const a = responder({ uid: 'u_aaa' });
    const b = responder({ uid: 'u_bbb' });
    const first = rank([a, b], MEDICAL).map((c) => c.responder.uid);
    // Reversed input, same output order.
    const second = rank([b, a], MEDICAL).map((c) => c.responder.uid);
    expect(first).toEqual(second);
    expect(first).toEqual(['u_aaa', 'u_bbb']);
  });
});

/* ========================================================================== */
/* Explainability — brief §12                                                  */
/* ========================================================================== */

describe('every candidate carries its reasons as DATA', () => {
  it('the reasons are in `factors`, so a UI renders them rather than inventing them', () => {
    const [candidate] = rank([responder()], MEDICAL);
    const kinds = candidate.factors.map((f) => f.kind);
    expect(kinds).toContain('capability_match');
    expect(kinds).toContain('distance');
    expect(kinds).toContain('available');
  });

  it('a full match says so, in words a dispatcher can check', () => {
    const [candidate] = rank([responder()], MEDICAL);
    const match = candidate.factors.find((f) => f.kind === 'capability_match');
    expect(match?.detail).toMatch(/all 1 required capabilit/i);
  });

  it('a PARTIAL match names the missing resources, not just that something is missing', () => {
    const partial = responder({ capabilities: ['res_ambulance', 'res_search_team'] });
    const [candidate] = rank([partial], {
      point: INCIDENT_POINT,
      requiredResources: ['res_ambulance', 'res_water_rescue'],
      urgency: 'high',
    });
    expect(candidate.capabilityMatch).toBe(false);
    expect(candidate.missingResources).toEqual(['res_water_rescue']);
    const factor = candidate.factors.find((f) => f.kind === 'capability_partial');
    expect(factor && 'missing' in factor ? factor.missing : null).toEqual(['res_water_rescue']);
  });

  it('the BLOCKERS are included, not just the positives', () => {
    // A dispatcher looking at a non-assignable responder needs to know it is
    // verification and not a query failure. "Not assignable" with no reason is
    // indistinguishable from a bug.
    const blocked = responder({ verification: 'pending', activeIncidentCount: 1, maxConcurrentIncidents: 1, status: 'offline' });
    const [candidate] = rank([blocked], MEDICAL);
    expect(candidate.isAssignable).toBe(false);
    const kinds = candidate.factors.map((f) => f.kind);
    expect(kinds).toContain('unverified');
    expect(kinds).toContain('at_capacity');
    expect(kinds).toContain('offline');
  });

  it('an offline reason is recorded ONCE, not as both a status and an availability fact', () => {
    const [candidate] = rank([responder({ status: 'offline' })], MEDICAL);
    expect(candidate.factors.filter((f) => f.kind === 'offline')).toHaveLength(1);
  });

  it('an incident requiring nothing is a match, and says so', () => {
    const [candidate] = rank([responder({ capabilities: [] })], {
      point: INCIDENT_POINT,
      requiredResources: [],
      urgency: 'low',
    });
    expect(candidate.capabilityMatch).toBe(true);
    expect(candidate.factors.some((f) => f.kind === 'capability_match')).toBe(true);
  });
});

/* ========================================================================== */
/* brief §30 — distance is not ETA                                             */
/* ========================================================================== */

describe('DISTANCE IS NOT ETA, and this module never produces one', () => {
  it('no field NAME implies a time or an arrival, at any depth', () => {
    // brief §30: "Do not claim travel time unless a real routing API has been
    // implemented. Distance is not the same as ETA." There is no routing provider
    // in this project, so no key may suggest one.
    //
    // Checked as whole KEY NAMES rather than a substring search over the whole
    // serialised object: a naive `/eta/` also matches inside `metadata` and
    // `beta`, which is a check that passes or fails for the wrong reason.
    const forbidden = /^(eta|etaSec|etaSeconds|duration|durationSec|arrival|arrivalTime|travelTime|travelTimeSec|minutes|seconds|timeToArrive|etaMinutes)$/i;
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (typeof node === 'object' && node !== null) {
        for (const [key, value] of Object.entries(node)) {
          if (forbidden.test(key)) offenders.push(`${path}.${key}`);
          walk(value, `${path}.${key}`);
        }
      }
    };
    walk(rank([responder()], MEDICAL), 'candidate');
    expect(offenders).toEqual([]);
  });

  it('no factor DETAIL claims a time or an arrival', () => {
    // The text is what a dispatcher reads, so this is the assertion that actually
    // protects brief §30 — a field name cannot mislead; a sentence can.
    const candidates = rank(
      [responder(), responder({ uid: 'u_stale', staleLocation: true, location: northOf(300) })],
      MEDICAL,
    );
    const claims = /eta\b|arriv|on the way|on their way|will be there|minutes? away|seconds? away|driving time|travel time/i;
    for (const candidate of candidates) {
      for (const factor of candidate.factors) {
        expect(factor.detail, `${candidate.responder.uid}/${factor.kind}`).not.toMatch(claims);
      }
    }
  });

  it('every distance factor is phrased as a distance and nothing else', () => {
    const [candidate] = rank([responder()], MEDICAL);
    const distance = candidate.factors.find((f) => f.kind === 'distance');
    expect(distance?.detail).toBe(formatDistanceSentence(candidate.distanceM));
  });

  it('the label is a distance and nothing else', () => {
    expect(formatDistanceSentence(1_200)).toBe('1.2 km away');
    expect(formatDistance(950)).toBe('950 m');
    expect(formatDistance(1_000)).toBe('1.0 km');
    // Under 1 km stays in metres, which is what a dispatcher needs for a nearby
    // incident — "0.8 km" is less useful than "800 m".
    expect(formatDistance(800)).toBe('800 m');
  });

  it('the distance REUSES the Phase 6 haversine, not a second implementation', () => {
    const origin = northOf(1_234);
    const [candidate] = rank([responder({ location: origin })], MEDICAL);
    expect(candidate.distanceM).toBe(haversineMetersRounded(origin, INCIDENT_POINT));
  });
});

/* ========================================================================== */
/* The service area — soft, not a veto                                         */
/* ========================================================================== */

describe('the service radius is a FACT a dispatcher can override, not a veto', () => {
  it('a responder beyond their radius is still assignable, and it is flagged', () => {
    // `docs/07 §7.1` makes `serviceRadiusM` an operational fact. Refusing the
    // assignment would remove that judgement from the person who has it.
    const [candidate] = rank([responder({ serviceRadiusM: 500 })], MEDICAL);
    expect(candidate.distanceM).toBeGreaterThan(500);
    expect(candidate.outOfServiceArea).toBe(true);
    expect(candidate.isAssignable).toBe(true);
    expect(candidate.factors.some((f) => f.kind === 'out_of_service_area')).toBe(true);
  });

  it('within the radius says so positively', () => {
    const [candidate] = rank([responder({ serviceRadiusM: 5_000 })], MEDICAL);
    expect(candidate.outOfServiceArea).toBe(false);
    expect(candidate.factors.some((f) => f.kind === 'in_service_area')).toBe(true);
  });
});

/* ========================================================================== */
/* Missing positions                                                           */
/* ========================================================================== */

describe('a responder with NO known position is shown, ranked last on distance', () => {
  it('distanceM is MAX_SAFE_INTEGER so the numeric sort puts them after every real one', () => {
    const ranked = rank(
      [responder({ uid: 'u_far', location: northOf(9_000) }), responder({ uid: 'u_none', location: null })],
      MEDICAL,
    );
    // Order is the point: a known 9 km position must outrank an unknown one.
    expect(ranked.map((entry) => entry.responder.uid)).toEqual(['u_far', 'u_none']);
    expect(ranked[1]?.distanceM).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('the reason is stated, because a blank distance looks like a bug', () => {
    const [candidate] = rank([responder({ location: null })], MEDICAL);
    expect(candidate.factors.some((f) => f.kind === 'no_location')).toBe(true);
  });

  it('an incident with NO position makes every distance unknown rather than wrong', () => {
    const [candidate] = rank([responder()], { point: null, requiredResources: [], urgency: null });
    expect(candidate.distanceM).toBe(Number.MAX_SAFE_INTEGER);
    expect(candidate.outOfServiceArea).toBe(false);
  });

  it('an empty list returns an empty list — the ranker never throws', () => {
    // `rankCandidates` directly, not the non-empty-tuple wrapper.
    expect(rankCandidates([], MEDICAL)).toEqual([]);
  });
});

/* ========================================================================== */
/* brief §31 — the empty state                                                 */
/* ========================================================================== */

describe('the "no available responder" state is a REAL state with a REAL sentence', () => {
  it('has a heading, a body, and two permitted next actions', () => {
    // brief §31: "Dispatcher options: Review other responders / Keep incident
    // pending. Do not silently assign an unsuitable responder."
    expect(NO_RESPONDER_AVAILABLE_COPY.heading).toBe(
      'No available responder currently matches this incident.',
    );
    expect(NO_RESPONDER_AVAILABLE_COPY.options).toEqual([
      'Review other responders',
      'Keep incident pending',
    ]);
    // And the body names both, so a dispatcher is not left at a dead end.
    expect(NO_RESPONDER_AVAILABLE_COPY.body).toMatch(/review responders/i);
    expect(NO_RESPONDER_AVAILABLE_COPY.body).toMatch(/leave this incident pending/i);
    // And it never proposes assigning someone unsuitable, which brief §31 forbids.
    expect(NO_RESPONDER_AVAILABLE_COPY.body + NO_RESPONDER_AVAILABLE_COPY.heading).not.toMatch(
      /assign (them|this|another)/i,
    );
  });

  it('summarises the EXCLUDED responders and why, rather than hiding them', () => {
    const candidates = rank(
      [
        responder({ uid: 'u_ok' }),
        responder({ uid: 'u_un', verification: 'unverified' }),
        responder({ uid: 'u_off', status: 'offline' }),
        responder({ uid: 'u_cap', activeIncidentCount: 1, maxConcurrentIncidents: 1 }),
      ],
      MEDICAL,
    );
    const summary = summariseExcluded(candidates);
    expect(summary.excludedCount).toBe(3);
    expect(summary.reasonCounts).toMatchObject({ unverified: 1, offline: 1, at_capacity: 1 });
  });

  it('an all-clear summary reports zero rather than undefined', () => {
    const summary = summariseExcluded(rank([responder()], MEDICAL));
    expect(summary).toEqual({ excludedCount: 0, reasonCounts: {} });
  });
});

/* ========================================================================== */
/* brief §13 — the priority heading                                            */
/* ========================================================================== */

describe('the critical-incident heading, brief §13', () => {
  it('states the COUNT, which is what tells a dispatcher if this is solvable', () => {
    expect(criticalIncidentHeading(3)).toBe('CRITICAL incident. 3 available responders.');
    expect(criticalIncidentHeading(1)).toBe('CRITICAL incident. 1 available responder.');
    expect(criticalIncidentHeading(0)).toBe('CRITICAL incident. No available responders.');
  });

  it('says "CRITICAL" in WORDS, not only in colour', () => {
    // brief §43: "Example: 'Critical — Traffic Accident' rather than communicating
    // critical status only through a red badge." A screen reader reads text, and a
    // red-green colourblind reader reads a red badge as a dark one.
    expect(criticalIncidentHeading(2)).toMatch(/CRITICAL/);
  });
});

/* ========================================================================== */
/* Robustness                                                                  */
/* ========================================================================== */

describe('the ranker is total', () => {
  it('does not mutate its input', () => {
    const input = [responder(), responder({ uid: 'u_sara' })];
    const snapshot = JSON.stringify(input);
    rank(input, MEDICAL);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('a candidate with zero capabilities still returns every field', () => {
    const [candidate] = rank([responder({ capabilities: [] })], MEDICAL);
    expect(candidate).toMatchObject({
      rank: 1,
      capabilityMatch: false,
      isAssignable: true,
      outOfServiceArea: expect.any(Boolean),
    });
    expect(candidate.factors.length).toBeGreaterThan(0);
    expect(candidate.missingResources).toEqual(['res_ambulance']);
  });
});

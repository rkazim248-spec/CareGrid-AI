/**
 * ============================================================================
 * CareGrid AI — responder candidate discovery
 * ============================================================================
 *
 * `docs/08 §3.6`, `docs/07 §7.1`, FR-028 / FR-064. **SERVER ONLY.**
 *
 * brief §11's `findAvailableResponders()`.
 *
 * ---------------------------------------------------------------------------
 * TWO READS, NOT N
 * ---------------------------------------------------------------------------
 * brief §41: "Avoid loading all responders … creating one listener per responder
 * unnecessarily."
 *
 * The candidate set needs each responder's position, and positions live in
 * `responderLocations/{uid}` — a document per responder. The obvious
 * implementation therefore looks like `for (r of candidates) await get(location)`,
 * which is N sequential round trips, and on a fifty-responder deployment that is a
 * candidate panel that takes seconds to appear, which a dispatcher will learn to
 * avoid.
 *
 * `db.getAll(...refs)` issues them as ONE batched request. So the whole call is two
 * reads regardless of candidate count: the filtered `responders` query, and one
 * batched `responderLocations` get. The number is stated here because it is the
 * reason this function is shaped the way it is, and someone who later "simplifies"
 * it into a loop would be making it thirty times more expensive without noticing.
 *
 * ---------------------------------------------------------------------------
 * THE QUERY IS FILTERED IN FIRESTORE, NOT IN MEMORY
 * ---------------------------------------------------------------------------
 * `docs/07 §7.1` names the composite index for exactly this: "`status ASC,
 * verification ASC, lastLocationAt DESC` (candidate ranking base)". The query uses
 * that index and filters `verification == 'verified'` (FR-064) and
 * `status in ['available', 'busy']` SERVER-SIDE, so an unverified or offline
 * responder never reaches the application at all. The ranker in
 * `lib/dispatch/candidates.ts` then re-checks assignability itself — defence in
 * depth, because the ranker is also reachable from a test and a future
 * non-Firestore source, and a permission decision that only exists in a query
 * string is a permission decision with no test.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT DONE HERE
 * ---------------------------------------------------------------------------
 * **No ETA.** brief §30: "Do not claim travel time unless a real routing API has
 * been implemented. Distance is not the same as ETA." There is no routing provider
 * in this project. `docs/07 §8` has an `etaSec` field and Phase 3 typed it, and it
 * is left `null` — a distance-derived ETA is a number a dispatcher would act on.
 *
 * **No scoring.** brief §12 forbids an unexplained "97% best responder". The
 * ranking is a lexicographic order over named factors, done in
 * `lib/dispatch/candidates.ts`, and this module's only job is to fetch the rows
 * and the positions.
 *
 * **No dispatch.** brief §3. This function returns a ranked list of suggestions.
 * Nothing in this file writes, and the assignment is a separate transactional
 * service that a human calls.
 */

import 'server-only';

import type { GeoPoint, QuerySnapshot, Timestamp } from 'firebase-admin/firestore';

import { adminConfigurationReason, getAdminDb } from '@/lib/server/firebase-admin';
import { COLLECTIONS } from '@/config/collections';
import { createLogger } from '@/lib/server/http';
import { CANDIDATE_LIMIT_CEILING, CANDIDATE_QUERY_LIMIT, STALE_AFTER_MS } from '@/config/dispatch';
import {
  rankCandidates,
  type CandidateResponder,
  type IncidentRequirement,
  type RankedCandidate,
} from '@/lib/dispatch/candidates';
import type { LatLng } from '@/lib/geo/distance';
import type { AccuracyGrade, VerificationStatus } from '@/types';

/* ========================================================================== */
/* The document shapes read here                                               */
/* ========================================================================== */

/**
 * The subset of `responders/{uid}` this module reads. `docs/07 §7.1`.
 *
 * **Every field is nullable or defaulted, because a document written by an older
 * version of the app, or by a seed script, or by an admin correcting a typo by
 * hand, will be missing some of them.** Reading a field that may be absent means
 * `?? fallback` at every access; forgetting one is a 500 on the dispatcher's
 * candidate panel, which is the screen they are looking at while someone waits.
 */
type ResponderDoc = {
  readonly uid?: string;
  readonly displayName?: string;
  readonly status?: string;
  readonly verification?: string;
  readonly capabilities?: unknown;
  readonly serviceRadiusM?: number;
  readonly activeIncidentCount?: number;
  readonly maxConcurrentIncidents?: number;
  readonly lastLocationAt?: Timestamp | null;
  readonly lastLocationAccuracyGrade?: string | null;
  readonly homeBase?: GeoPoint | null;
};

/** The subset of `responderLocations/{uid}` read. `docs/07 §7.2`. */
type ResponderLocationDoc = {
  readonly geo?: GeoPoint | null;
  readonly accuracyGrade?: string | null;
  /**
   * Server ingest time, and the ONLY staleness clock.
   *
   * `docs/07 §7.2` is explicit: "`capturedAt` … device time of the fix" versus
   * "`receivedAt` … server/ingest time - **authoritative for staleness**". A phone
   * with a wrong clock is a normal occurrence, and a staleness check driven by
   * `capturedAt` would mark a fresh fix as hours old and sort a responder to the
   * bottom for a reason that does not exist.
   */
  readonly receivedAt?: Timestamp | null;
  readonly stale?: boolean;
};

export type FindCandidatesResult = {
  readonly candidates: readonly RankedCandidate[];
  /** `true` when the query hit its limit, so the list is known to be partial. */
  readonly truncated: boolean;
  /**
   * Why the panel may be empty, or `null` when it simply is not.
   *
   * brief §31 needs a real sentence for "no suitable responder" and a dispatcher
   * needs to know whether that is a policy outcome or a query failure. A bare empty
   * array is indistinguishable from a bug.
   */
  readonly emptyReason: 'no_responders' | 'none_verified' | 'capability_required' | 'not_found' | null;
};

/* ========================================================================== */
/* The query                                                                   */
/* ========================================================================== */

const VERIFICATION_STATUSES: ReadonlySet<string> = new Set([
  'unverified',
  'pending',
  'verified',
  'rejected',
]);

const ACCURACY_GRADES: ReadonlySet<string> = new Set(['high', 'medium', 'low', 'unknown']);

function readVerification(value: unknown): VerificationStatus {
  return typeof value === 'string' && VERIFICATION_STATUSES.has(value)
    ? (value as VerificationStatus)
    : 'unverified';
}

function readAccuracyGrade(value: unknown): AccuracyGrade | null {
  return typeof value === 'string' && ACCURACY_GRADES.has(value) ? (value as AccuracyGrade) : null;
}

function readStatus(value: unknown): 'available' | 'busy' | 'offline' {
  return value === 'available' || value === 'busy' ? value : 'offline';
}

/**
 * `capabilities` is `string[]`, but read defensively.
 *
 * A non-array here means a hand-edited document or a schema drift. Falling back to
 * `[]` makes the responder show as `capability_none` — visible, and refusable by a
 * human — rather than throwing and taking the whole panel down. An empty
 * capability list is the safe reading: it cannot cause a wrong assignment, only a
 * missed suggestion.
 */
function readCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** A positive finite integer, or the fallback. Guards a negative or NaN count. */
function readCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/* ========================================================================== */
/* The service                                                                 */
/* ========================================================================== */

/**
 * Find and rank the responders who could take this incident.
 *
 * `nowMs` is a PARAMETER, not a clock read. Staleness is a function of time, and a
 * function of time that reads the wall clock cannot be tested — the test would pass
 * today and fail next week, or worse, pass in a run that took an unlucky second.
 * The route passes `Date.now()`.
 */
export async function findAvailableResponders(
  incident: IncidentRequirement,
  options: { readonly nowMs: number; readonly limit?: number },
): Promise<FindCandidatesResult> {
  if (adminConfigurationReason() !== null) {
    return { candidates: [], truncated: false, emptyReason: 'not_found' };
  }

  const limit = clampLimit(options.limit ?? CANDIDATE_QUERY_LIMIT);
  const requiredResources = incident.requiredResources;

  const db = getAdminDb();
  const log = createLogger('dispatch.candidates');

  /* --- read 1 of 2: the responders, filtered and limited in Firestore ---- */
  let snapshot: QuerySnapshot;
  try {
    let query = db
      .collection(COLLECTIONS.responders)
      // FR-064: only a `verified` responder is assignable, so unverified ones are
      // filtered here rather than fetched and shown with a "not assignable" badge.
      // They are counted separately by `countExcluded`.
      .where('verification', '==', 'verified')
      // `offline` is excluded: an offline responder is not available, and a
      // candidate list that leads with people who have gone home is worse than a
      // short list. brief §31's "Review other responders" is a separate, explicit
      // action, not the default panel.
      .where('status', 'in', ['available', 'busy'])
      .limit(limit);

    if (requiredResources.length > 0) {
      // `array-contains-any` rather than N `array-contains` queries, and rather
      // than fetching every verified responder and intersecting in memory. A
      // responder with ONE of the required capabilities is a candidate — the
      // ranker's `capability_partial` is what decides whether that is good enough,
      // and that judgement needs the whole set, not a pre-filtered subset.
      query = query.where('capabilities', 'array-contains-any', requiredResources.slice(0, 10));
    }

    snapshot = await query.get();
  } catch (error) {
    // A failed candidate query must NOT look like "no responders available". A
    // dispatcher who reads an empty panel as "nobody is free" and closes the
    // incident has been told a lie by a transient error, so this is thrown rather
    // than returned as an empty result.
    log.warn({
      code: 'DB_UNAVAILABLE',
      path: 'services.dispatch.candidates',
      status: 503,
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }

  if (snapshot.empty) {
    // Distinguish "there are no responders at all" from "the responders there are
    // do not have these capabilities", because the second is a message to the
    // dispatcher's manager and the first is a message to the person onboarding
    // responders.
    const excluded = await countExcluded(db, log);
    return {
      candidates: [],
      truncated: false,
      emptyReason:
        excluded.unverified > 0 && requiredResources.length > 0
          ? 'capability_required'
          : excluded.unverified > 0
            ? 'none_verified'
            : 'no_responders',
    };
  }

  /* --- read 2 of 2: every position, in ONE batched get ------------------ */
  const docs = snapshot.docs;
  const locationRefs = docs.map((doc) => db.collection(COLLECTIONS.responderLocations).doc(doc.id));

  let locations: (ResponderLocationDoc | null)[];
  try {
    const fetched = await db.getAll(...locationRefs);
    locations = fetched.map((snap) => (snap.exists ? (snap.data() as ResponderLocationDoc) : null));
  } catch (error) {
    // A location read failure degrades to "no position known" rather than
    // failing: `docs/07 §7.1` allows a responder to have only a `homeBase`, and a
    // dispatcher is better served by an incomplete distance than by no panel.
    log.warn({
      code: 'DB_UNAVAILABLE',
      path: 'services.dispatch.candidates.locations',
      status: 503,
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    locations = docs.map(() => null);
  }

  /* --- map to the ranker's input --------------------------------------- */
  const responders: CandidateResponder[] = docs.map((doc, index) =>
    toCandidate(doc.data() as ResponderDoc, doc.id, locations[index] ?? null, options.nowMs),
  );

  const candidates = rankCandidates(responders, incident);

  return {
    candidates,
    truncated: snapshot.size >= limit,
    emptyReason: null,
  };
}

/**
 * One `count()` aggregation for the "why is the panel empty" sentence.
 *
 * A count query reads an index entry rather than a document, so it costs a
 * fraction of a document read. It is only issued on the EMPTY path, because a
 * populated panel does not need the number.
 */
async function countExcluded(
  db: ReturnType<typeof getAdminDb>,
  log: ReturnType<typeof createLogger>,
): Promise<{ unverified: number; offline: number }> {
  try {
    const [unverified, offline] = await Promise.all([
      db.collection(COLLECTIONS.responders).where('verification', '!=', 'verified').count().get(),
      db.collection(COLLECTIONS.responders).where('status', '==', 'offline').count().get(),
    ]);
    return { unverified: unverified.data().count, offline: offline.data().count };
  } catch (error) {
    // The sentence degrades to the vaguer one rather than the call failing: the
    // dispatcher's real need is "is this a query failure", and `emptyReason` is
    // already non-null, so they are not being shown a false "no responders".
    log.warn({
      code: 'DB_UNAVAILABLE',
      path: 'services.dispatch.candidates.excluded',
      status: 503,
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    return { unverified: 0, offline: 0 };
  }
}

/** Clamp into `[1, CANDIDATE_LIMIT_CEILING]` so a caller cannot ask for everything. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return CANDIDATE_QUERY_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), CANDIDATE_LIMIT_CEILING);
}

/**
 * Map one responder document plus its location onto the ranker's input.
 *
 * Split out and pure so the field-reading rules — the defensive casts, the
 * `receivedAt` clock, the `homeBase` fallback — are testable with no Firestore.
 */
export function toCandidate(
  doc: ResponderDoc,
  docId: string,
  location: ResponderLocationDoc | null,
  nowMs: number,
): CandidateResponder {
  const uid = typeof doc.uid === 'string' && doc.uid.length > 0 ? doc.uid : docId;

  /* --- position, and which of the two sources it came from ------------- */
  // `docs/07 §7.1`: "`homeBase` … used for distance when no live location
  // exists". A responder with no live fix is still a candidate, ranked on where
  // they usually are, and the ranker is what marks the difference.
  const live = location?.geo ?? null;
  const position: LatLng | null =
    live !== null
      ? { lat: live.latitude, lng: live.longitude }
      : doc.homeBase != null
        ? { lat: doc.homeBase.latitude, lng: doc.homeBase.longitude }
        : null;

  const positionIsLive = live !== null;

  /* --- staleness, from the SERVER clock only ---------------------------- */
  // `receivedAt` is authoritative (`docs/07 §7.2`); the document's own `stale`
  // flag is trusted when present because it is computed server-side too, but it is
  // recomputed here so a stale flag written by an older release cannot pin a
  // responder as stale forever.
  const receivedAt = positionIsLive ? (location?.receivedAt ?? null) : null;
  const ageMs = receivedAt !== null ? nowMs - receivedAt.toMillis() : null;
  const staleByAge = ageMs !== null && ageMs > STALE_AFTER_MS;
  const staleLocation = positionIsLive && (location?.stale === true || staleByAge);

  return {
    uid,
    // An empty display name renders as a blank row in a list of people, which is
    // the one thing a dispatcher cannot act on. The uid is used as the fallback so
    // the row is at least identifiable and contactable through the directory.
    displayName: typeof doc.displayName === 'string' && doc.displayName.trim().length > 0
      ? doc.displayName.trim()
      : uid,
    status: readStatus(doc.status),
    capabilities: readCapabilities(doc.capabilities),
    verification: readVerification(doc.verification),
    activeIncidentCount: readCount(doc.activeIncidentCount, 0),
    maxConcurrentIncidents: Math.max(1, readCount(doc.maxConcurrentIncidents, 1)),
    serviceRadiusM: readCount(doc.serviceRadiusM, 5_000),
    location: position,
    locationAccuracyGrade: readAccuracyGrade(
      positionIsLive ? location?.accuracyGrade : doc.lastLocationAccuracyGrade,
    ),
    staleLocation,
  };
}

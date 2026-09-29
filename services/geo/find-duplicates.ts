/**
 * ============================================================================
 * CareGrid AI — server-side duplicate candidate search
 * ============================================================================
 *
 * `docs/07 §9.2`. One Firestore read, then the pure engine. This is the only
 * place Firestore is touched for duplicate detection.
 *
 * ---------------------------------------------------------------------------
 * WHY SERVER-SIDE, AND WHY ONE READ
 * ---------------------------------------------------------------------------
 * brief §23: "Do NOT download the entire incidents collection into the browser.
 * Duplicate detection must happen server-side or through an appropriate backend
 * query strategy."
 *
 * `docs/07 §9.2` then fixes the read count:
 *
 * > **Implementation rule (normative):** exactly **one** Firestore read for the
 * > candidate set, `limit(50)`, ordered by `createdAt DESC`, composite index #6.
 *
 * So this is one `array-contains` query on the query point's **own** geohash-6.
 * Using all 10 (now 9) cells would be a 9x read-cost bug, and the reason it is
 * sufficient is the subject of `lib/geo/geohash.ts`'s header: every incident
 * stores its own neighbours, so a query for one cell matches the 3x3 block.
 *
 * The exact distance filter is then applied in code by `classifyDuplicate`. That
 * is not optional: a geohash cell is a ~1.2 x 0.6 km **rectangle**, so a matched
 * document's own point can be well outside 500 m — the corners of the cell can be
 * 600 m from its centre.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ADMIN SDK AND NOT A CLIENT LISTENER
 * ---------------------------------------------------------------------------
 * A client `onSnapshot` would bill document reads on every emission and would put
 * the `geoCells` array — and therefore the incident locations — into a browser
 * payload a citizen could inspect. brief §17 forbids exposing exact coordinates
 * unnecessarily. A single Admin SDK read scoped by an authenticated caller's own
 * request keeps the location data server-side and billed once.
 */

import 'server-only';

import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { getAdminDb } from '@/lib/server/firebase-admin';
import { duplicateConfig } from '@/lib/env.server';
import { COLLECTIONS } from '@/config/collections';
import { queryCellFor } from '@/lib/geo/geohash';
import {
  classifyDuplicate,
  findDuplicates,
  type DuplicateBreakdown,
  type DuplicateCandidate,
  type DuplicateConfig,
  type DuplicateReportInput,
} from '@/lib/duplicates/score';

/* ========================================================================== */
/* Open statuses — docs/12 §10.2                                               */
/* ========================================================================== */

/**
 * The seven statuses a map query and a duplicate check consider "live".
 *
 * **`resolved` is included on purpose.** docs/12 §10.2: "resolved incidents stay
 * visible on the map because a dispatcher still needs to see what just finished."
 * Excluding it would make a car crash vanish from the map the moment a responder
 * arrived, which is exactly when someone else reporting the same crash most needs
 * to see it.
 */
export const OPEN_STATUSES: readonly string[] = [
  'new',
  'triaged',
  'verified',
  'assigned',
  'en_route',
  'on_scene',
  'resolved',
];

/* ========================================================================== */
/* Configuration bridging                                                      */
/* ========================================================================== */

/**
 * The engine config, from the environment.
 *
 * `algorithmVersion` is a CONSTANT here rather than an env var: it identifies the
 * scoring formula, and it must change when the *code* changes. An operator who
 * could set it from the environment could label a `dedupe-v1` computation as
 * `dedupe-v9`, and `docs/07 §9.5` requires it be bumped when the weights change so a
 * stored breakdown stays interpretable.
 */
export function duplicateEngineConfig(): DuplicateConfig {
  const env = duplicateConfig();
  return {
    radiusM: env.radiusM,
    timeWindowMin: env.timeWindowMin,
    textSimilarityConfirm: env.textSimilarityConfirm,
    potentialThreshold: env.potentialThreshold,
    maxCandidates: env.maxCandidates,
    algorithmVersion: 'dedupe-v1',
  };
}

/* ========================================================================== */
/* The candidate read                                                          */
/* ========================================================================== */

/** What the candidate query returns, before the exact filter. */
export type CandidateSearch = {
  readonly candidates: readonly DuplicateCandidate[];
  /** Documents the query actually read. For the read-budget assertion. */
  readonly readCount: number;
  /** The one cell queried. Logged; never shown to a client. */
  readonly cell: string;
  /** `true` when `readCount` hit the cap, so the UI can say "showing the first N". */
  readonly capped: boolean;
};

/**
 * Find candidate incidents near a point. ONE read. `docs/07 §9.2`.
 *
 * **Soft-deleted incidents are excluded** (`deletedAt == null`), and so is anything
 * in a terminal status — a cancelled or merged incident is not a duplicate of
 * anything, it is history.
 *
 * Ordered by `createdAt DESC` because the newest incidents are the most likely
 * duplicates: a citizen reporting a crash is nearly always within minutes of
 * someone else, and ordering by distance would need the exact filter to run first,
 * which it cannot — Firestore cannot sort by a computed distance.
 *
 * Requires composite index #6: `geoCells (array-contains) + createdAt (desc)`.
 * `docs/12 §10.2` adds `status in [...]`, which is a third field; if the deployed
 * index is #6 as specified, the `status` filter is applied after the read instead,
 * which is cheaper on the index and equivalent here because the candidate set is
 * already capped at 50.
 */
export async function findDuplicateCandidates(
  point: { lat: number; lng: number },
  atMs: number,
  cfg: DuplicateConfig = duplicateEngineConfig(),
): Promise<CandidateSearch> {
  const log = createLogger('');

  const cell = queryCellFor(point.lat, point.lng);
  // No valid cell means no valid coordinate, and an incident with no location
  // cannot be compared. `[]` and `readCount: 0` is the honest answer: not an
  // error, and emphatically NOT a result that says "no duplicates".
  if (cell === null) {
    return { candidates: [], readCount: 0, cell: '', capped: false };
  }

  const windowStart = new Date(atMs - cfg.timeWindowMin * 60_000);

  try {
    // --- THE ONE READ. docs/07 §9.2, normative. ------------------------
    const snapshot = await getAdminDb()
      .collection(COLLECTIONS.incidents)
      .where('geoCells', 'array-contains', cell)
      .where('deletedAt', '==', null)
      .where('createdAt', '>=', windowStart)
      .orderBy('createdAt', 'desc')
      .limit(cfg.maxCandidates)
      .get();

    const candidates: DuplicateCandidate[] = [];
    for (const doc of snapshot.docs) {
      const data = doc.data() as {
        geo?: { lat?: unknown; lng?: unknown } | null;
        category?: unknown;
        originalText?: unknown;
        createdAt?: { toMillis?: () => number } | null;
        status?: unknown;
        reportCount?: unknown;
      };

      // --- the status filter, applied after the read ------------------
      const status = typeof data.status === 'string' ? data.status : 'new';
      if (!OPEN_STATUSES.includes(status)) continue;

      // A candidate with no usable point cannot be distance-checked. Skipped, not
      // defaulted to (0,0) — a document at null island would be 5 000 km from
      // anything and would score 0 on distance, which is arithmetically fine but
      // would put a meaningless row in the explainable breakdown.
      const lat = data.geo?.lat;
      const lng = data.geo?.lng;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const createdAtMs =
        typeof data.createdAt?.toMillis === 'function' ? data.createdAt.toMillis() : atMs;

      candidates.push({
        incidentId: doc.id,
        point: { lat, lng },
        reportedAtMs: createdAtMs,
        category: typeof data.category === 'string' ? data.category : null,
        // The citizen's ORIGINAL text, never an AI summary. See
        // `DuplicateReportInput.text` for why comparing against model output would
        // measure the model rather than the incident.
        originalText: typeof data.originalText === 'string' ? data.originalText : null,
        status,
        reportCount: typeof data.reportCount === 'number' ? data.reportCount : 1,
      });
    }

    return {
      candidates,
      readCount: snapshot.size,
      cell,
      capped: snapshot.size >= cfg.maxCandidates,
    };
  } catch (error) {
    // A missing composite index surfaces as a Firestore error naming `createdAt`.
    // That is a DEPLOYMENT problem and the message says so, because the fix is to
    // publish index #6 and nothing else will make it work.
    const message = error instanceof Error ? error.message : String(error);
    if (/index|failed to query/i.test(message)) {
      log.error({ code: 'DB_UNAVAILABLE', path: 'duplicates.findCandidates', status: 500 });
      throw new AppError({
        code: 'DB_UNAVAILABLE',
        message:
          'Duplicate checking is unavailable because the incidents geoCells index is not deployed.',
      });
    }
    throw new AppError({
      code: 'DB_UNAVAILABLE',
      message: 'Could not look for nearby reports. Your emergency report can still be submitted.',
      cause: error,
    });
  }
}

/* ========================================================================== */
/* The whole check                                                             */
/* ========================================================================== */

/** brief §25's response shape, plus the server-only fields. */
export type DuplicateCheckResult = {
  readonly hasPotentialDuplicate: boolean;
  /** The strongest matches, best first. Empty when there are none. */
  readonly matches: readonly DuplicateMatch[];
  /** The `distanceM` values, for the FR-084 ring and the map's join line. */
  readonly nearestM: number | null;
  /** The configured radius, so the UI does not hardcode 500. */
  readonly radiusM: number;
  /** `true` when the read hit `maxCandidates` and the list may be incomplete. */
  readonly truncated: boolean;
  readonly algorithmVersion: string;
};

/** One match, shaped for a human. brief §25. */
export type DuplicateMatch = {
  readonly incidentId: string;
  readonly distanceM: number;
  readonly timeDifferenceMinutes: number;
  readonly categoryMatch: boolean;
  /** 0..1. `docs/07 §9.3`. */
  readonly similarity: number;
  /** The decision. A string a human reads; never an action. FR-041. */
  readonly decision: DuplicateBreakdown['decision'];
  /** The explainable reasons. brief §20. */
  readonly reasons: readonly string[];
  readonly matchedKeywords: readonly string[];
};

/**
 * The full check: one read, then the pure engine.
 *
 * **Never throws for a citizen's report.** `docs/16` and the FR-041 spirit both
 * require that a failed duplicate check must not block an emergency report —
 * brief §37 states the required behaviour: *"Unable to check nearby reports right
 * now. You can continue submitting your emergency report."*
 *
 * So a Storage failure is caught here and returned as a result with no matches and
 * `hasPotentialDuplicate: false`. **That false is a lie the caller must not
 * believe**, which is why it is paired with a `candidatesUnavailable` flag rather
 * than being silently indistinguishable from "we checked and found nothing".
 */
export async function checkForDuplicates(
  report: DuplicateReportInput,
  cfg: DuplicateConfig = duplicateEngineConfig(),
): Promise<DuplicateCheckResult & { readonly candidatesUnavailable: boolean }> {
  const log = createLogger('');

  let search: CandidateSearch;
  try {
    search = await findDuplicateCandidates(report.point, report.reportedAtMs, cfg);
  } catch (error) {
    // Logged, not thrown. The reason is a fixed string from this file — an SDK
    // message can contain a query with coordinates in it.
    log.warn({ code: 'DB_UNAVAILABLE', path: 'duplicates.check', status: 503 });
    void error;
    return {
      hasPotentialDuplicate: false,
      matches: [],
      nearestM: null,
      radiusM: cfg.radiusM,
      truncated: false,
      algorithmVersion: cfg.algorithmVersion,
      // The flag that stops a caller treating "we could not check" as "no duplicates".
      candidatesUnavailable: true,
    };
  }

  // --- pair each breakdown with its candidate, in ONE pass ----------------
  // An earlier version re-found the candidate by searching on `distanceM` — a value
  // that is only unique by accident. Two incidents at exactly 183 m from the query
  // point, which is entirely plausible on a 3x3 cell grid, would both resolve to
  // whichever came first, and one match would carry the WRONG incidentId. A
  // dispatcher clicking "183 m away" would be taken to a different incident.
  //
  // `findDuplicates` returns one breakdown per candidate in input order, so the
  // pairing is positional. It is verified by construction rather than assumed: the
  // lengths are compared, and a mismatch falls back to no ids at all rather than to
  // mis-attributed ones. A match with a blank id is visibly broken; a match with the
  // WRONG id is silently dangerous.
  const breakdowns = findDuplicates(report, search.candidates, cfg);
  const aligned = breakdowns.length === search.candidates.length;

  const matches: DuplicateMatch[] = breakdowns.map((b, index) => ({
    incidentId: aligned ? (search.candidates[index] as DuplicateCandidate).incidentId : '',
    distanceM: b.distanceM,
    timeDifferenceMinutes: b.timeDeltaMin,
    categoryMatch: b.categoryMatch,
    // Rounded for transport. The full float is in the stored breakdown; a citizen
    // never needs 15 significant digits of a similarity score, and brief §25 says not
    // to expose the internal implementation unnecessarily.
    similarity: Number(b.textSimilarity.toFixed(2)),
    decision: b.decision,
    reasons: b.reasons,
    matchedKeywords: b.matchedKeywords,
  }));

  return {
    hasPotentialDuplicate: breakdowns.some(
      (b) => b.decision === 'potential_duplicate' || b.decision === 'confirmed_duplicate',
    ),
    matches,
    nearestM: breakdowns.length === 0 ? null : (breakdowns[0] as DuplicateBreakdown).distanceM,
    radiusM: cfg.radiusM,
    truncated: search.capped,
    algorithmVersion: cfg.algorithmVersion,
    candidatesUnavailable: false,
  };
}

/**
 * Classify ONE already-loaded candidate. Exported for tests and for a caller that
 * has a candidate in hand (a dispatcher comparing two specific incidents).
 */
export { classifyDuplicate };

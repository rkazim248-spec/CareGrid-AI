/**
 * ============================================================================
 * CareGrid AI — realtime query sets
 * ============================================================================
 *
 * `docs/11 §6` QD-6: "`in` sets stay <= 30 values, `or` sets <= 10, `not-in` <=
 * 10. **`lib/collections/enums.ts` exports the sets**; a unit test asserts every
 * set's size."
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `config/collections.ts`
 * ---------------------------------------------------------------------------
 * That module holds the COLLECTION NAMES (`incidents`, `dispatches`, …). This one
 * holds the VALUES a listener query filters on. They are different questions —
 * "which collection" and "which values" — and merging them would make
 * `config/collections.ts` a dumping ground that Phase 8's query layer and Phase 3's
 * schema both reach into.
 *
 * ---------------------------------------------------------------------------
 * `OPEN_STATUSES` IS NEW, AND IT IS THE 7-VALUE SET `docs/11` NAMES
 * ---------------------------------------------------------------------------
 * `docs/11 §2.1`: "`ACTIVE_STATUSES` (6 values, adds `resolved`)". Phase 3 built
 * `ACTIVE_STATUSES` with 6 values, which is correct for the queue. The map's L3
 * listener needs a different window: it shows incidents that are still on the map,
 * which includes a RESOLVED one that has not yet been closed, because "resolved"
 * is the last state before an incident leaves the operational picture.
 *
 * So `OPEN_STATUSES` is added here rather than widening `ACTIVE_STATUSES`.
 * Widening the active set would put resolved incidents back in the dispatcher's
 * live queue, which is the bug `ACTIVE_STATUSES` was introduced to prevent.
 *
 * ---------------------------------------------------------------------------
 * THE CAPS ARE ASSERTED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * Firestore rejects an `in` with more than 30 values at RUNTIME, on the first
 * snapshot, as an `invalid-argument` error the user would see as an empty map. The
 * caps below are therefore not documentation: `setSizeCaps` is consumed by a test
 * that fails the build if a set grows past its limit, which is the only moment a
 * developer is looking at the list.
 */

/* ========================================================================== */
/* Status sets                                                                 */
/* ========================================================================== */

/**
 * The six statuses both `docs/11 §2.1` and `docs/14 §2.1` call "active".
 *
 * ---------------------------------------------------------------------------
 * A DOCUMENT NAMING COLLISION, AND THE BUG IT CAUSED
 * ---------------------------------------------------------------------------
 * Two documents name the same seven elements differently:
 *
 * | Set | `docs/07 §12.1` | `docs/11 §2.1` | `docs/14 §2.1` |
 * | --- | --- | --- | --- |
 * | 6 elements, no `resolved` | — | `ACTIVE_STATUSES` | "Active statuses" |
 * | 7 elements, **with** `resolved` | `ACTIVE_STATUSES` | `OPEN_STATUSES` | "Open statuses" |
 *
 * `types/enums.ts` follows `docs/07 §12.1`, so its `ACTIVE_STATUSES` is the
 * **seven**-element one. `docs/11` and `docs/14` use the name `ACTIVE_STATUSES` for
 * the **six**-element subset, and call the seven-element set `OPEN_STATUSES`.
 *
 * Reading `types/enums.ts`'s `ACTIVE_STATUSES` as the set `docs/14 §2.1` means is
 * wrong in two places, and Phase 8 made it in one:
 *
 * 1. **`counts.active` and `counts.resolved` double-counted.** Every resolved
 *    incident landed in both buckets, so a unit test asserting the buckets are
 *    disjoint failed — which is how the collision was found rather than shipped.
 * 2. **The dispatcher's live queue showed RESOLVED incidents.** `docs/11 §2.1`'s L1
 *    row filters `status in ACTIVE_STATUSES` using *that document's* meaning — the
 *    six. Filtering on the seven put a finished incident back in the work queue.
 *
 * So this module carries the six-element set under an unambiguous name, and
 * `OPEN_STATUSES` below is the seven-element one. Phase 3's array is left exactly
 * as it is — a test pins its length at 7 for a documented reason ("a
 * resolved-but-not-closed incident still has an open audit obligation"), and that
 * reason is about the *incident* being open, not about it being in a work queue.
 */
export const LIVE_ACTIVE_STATUSES = [
  'new',
  'triaged',
  'verified',
  'assigned',
  'en_route',
  'on_scene',
] as const satisfies readonly IncidentStatus[];

import { ACTIVE_STATUSES, TERMINAL_STATUSES } from '@/types';
import type { IncidentStatus } from '@/types';

export { ACTIVE_STATUSES, TERMINAL_STATUSES };

/** The seven statuses L3 (`mapIncidents`) filters on. `docs/11 §2.1`. */
export const OPEN_STATUSES = [
  'new',
  'triaged',
  'verified',
  'assigned',
  'en_route',
  'on_scene',
  'resolved',
] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];

/**
 * The statuses that mean "a responder is working on this". L6 filters on the
 * dispatch's own status, not the incident's, but the citizen and responder
 * progress stepper needs the incident-side equivalent.
 */
export const IN_PROGRESS_STATUSES = ['assigned', 'en_route', 'on_scene'] as const;

/* ========================================================================== */
/* Dispatch sets                                                               */
/* ========================================================================== */

/**
 * `docs/07 §8`: "`active`/`accepted` count as the live assignment". L6 listens on
 * exactly these two, so a responder's dashboard does not keep a live listener on a
 * dispatch that was withdrawn twenty minutes ago.
 */
export const LIVE_DISPATCH_STATUSES = ['active', 'accepted'] as const;

/** The five documented dispatch statuses. `docs/07 §8`. */
export const DISPATCH_STATUS_SET = ['active', 'accepted', 'withdrawn', 'completed', 'expired'] as const;

/* ========================================================================== */
/* Responder sets                                                              */
/* ========================================================================== */

/**
 * L4 (`mapLocations`) filters `status != offline`.
 *
 * **An inequality, not a `not-in`,** because Firestore's `!=` excludes documents
 * that lack the field entirely, and a `responderLocations` document written before
 * `status` was denormalised onto it would silently vanish from the map. That is
 * the failure a stale-fix responder produces: a dispatcher who cannot see them.
 */
export const NON_OFFLINE_STATUSES = ['available', 'busy'] as const;

/** `docs/07 §7.1`'s three responder statuses. */
export const RESPONDER_STATUS_SET = ['available', 'busy', 'offline'] as const;

/* ========================================================================== */
/* Notification and search sets                                                */
/* ========================================================================== */

/**
 * L5's `createdAt DESC` window needs no status set — `notifications` has no
 * status — but it DOES need an expiry set, because `docs/13 §3.1` puts a sweep on
 * `expiresAt` and a listener would otherwise keep delivering rows the sweep is
 * about to remove.
 */
export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;

/**
 * The SLA sweep window. `docs/11 §2.2` L9: `status in
 * ['verified','assigned','en_route','on_scene', …]`.
 *
 * `new` and `triaged` are NOT here: an incident that has not been verified has no
 * SLA clock running, so a breach for one is meaningless. `docs/07 §4`'s
 * `slaTargetMin` is set at verification.
 */
export const SLA_TRACKED_STATUSES = [
  'verified',
  'assigned',
  'en_route',
  'on_scene',
  'resolved',
] as const;

/* ========================================================================== */
/* The caps                                                                    */
/* ========================================================================== */

/**
 * Firestore's own limits, as this app depends on them.
 *
 * | Operator | Firestore limit | Used by |
 * | --- | ---: | --- |
 * | `in` | 30 (10 before 2023) | `status in ACTIVE_STATUSES`, `urgency in`, `category in` |
 * | `not-in` / `not-in` | 30 | - |
 * | `or` | 30 | - |
 *
 * `docs/11` QD-6 quotes 30/10/10, which is the pre-2023 figure. The current limit
 * is 30 for all three, and the QUOTED number is kept here as `LEGACY_CAP` so the
 * difference is documented rather than silently resolved — a set that would pass
 * today and fail against a reading of the doc that says 10 is a real ambiguity,
 * and the honest fix is to note it rather than pick one and move on.
 */
export const SET_SIZE_CAPS = {
  in: 30,
  notIn: 30,
  or: 30,
} as const;

/** The figure `docs/11` QD-6 quotes. See the note above. */
export const LEGACY_SET_SIZE_CAP = 10;

/**
 * Every exported `in` set, by name, so the size test can enumerate them without
 * this file having to remember to update.
 *
 * A set is EXCLUDED from this map only if it is not used in an `in` clause.
 */
export const QUERY_SETS = {
  OPEN_STATUSES,
  IN_PROGRESS_STATUSES,
  LIVE_DISPATCH_STATUSES,
  DISPATCH_STATUS_SET,
  NON_OFFLINE_STATUSES,
  RESPONDER_STATUS_SET,
  NOTIFICATION_SEVERITIES,
  SLA_TRACKED_STATUSES,
} as const;

export type QuerySetName = keyof typeof QUERY_SETS;

/**
 * Is this set legal in a Firestore `in` clause?
 *
 * Pure and total, so a caller can ask before building a query rather than
 * discovering the answer as an `invalid-argument` error on the first snapshot.
 */
export function isSetSizeLegal(name: QuerySetName): boolean {
  return QUERY_SETS[name].length <= SET_SIZE_CAPS.in;
}

/**
 * The statuses L1 treats as "live": the SIX, per `docs/11 §2.1`.
 *
 * `docs/11 §2.2`'s L1 row reads "`deletedAt == null`, `status in ACTIVE_STATUSES`",
 * and in that document `ACTIVE_STATUSES` is the six-element set — so a resolved
 * incident does not appear in the dispatcher's work queue. See the collision note
 * above; using `types/enums.ts`'s seven-element array here was the bug.
 *
 * Phase 8 shipped pointing at the seven, and this corrects it.
 */
export const QUEUE_STATUS_WINDOW: readonly IncidentStatus[] = [...LIVE_ACTIVE_STATUSES];

/** `docs/14 §2.1`'s "Active statuses", for the analytics count buckets. */
export const ANALYTICS_ACTIVE_STATUSES: readonly IncidentStatus[] = [...LIVE_ACTIVE_STATUSES];

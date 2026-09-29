/**
 * ============================================================================
 * CareGrid AI — dispatch assignment
 * ============================================================================
 *
 * `docs/08 §3.6` / `docs/08 §3.7`, `docs/07 §8`, FR-053. **SERVER ONLY.**
 *
 * brief §15: "Assignment must be protected against race conditions … The backend
 * must verify current responder availability before confirming assignment. Do not
 * rely solely on the client UI. Use Firestore transactions."
 *
 * ---------------------------------------------------------------------------
 * THE RACE THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * ```
 * Dispatcher A                         Dispatcher B
 *     |                                     |
 *     reads responder X: available          |
 *     |                                     reads responder X: available
 *     v                                     v
 *   assign(X) ---> [ TRANSACTION ] <--- assign(X)
 * ```
 *
 * Both dispatchers saw an available responder, and a check-then-write outside a
 * transaction would let both succeed. The result is two live dispatches for one
 * responder, `activeIncidentCount` incremented twice for one job, and — because
 * `docs/07 §8` constrains "at most one document per incident with `status ==
 * 'active'`" but says nothing about one responder having one — an incident nobody
 * is actually going to, because the responder is driving to the second one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRANSACTION MUST *WRITE* THE RESPONDER, NOT MERELY READ IT
 * ---------------------------------------------------------------------------
 * Firestore aborts and retries a transaction when another committed transaction
 * touched a document it read. A transaction that only READ `responders/{uid}`
 * would therefore conflict, and that is the mechanism.
 *
 * But the subtle part is this one: a transaction that reads a document and does
 * NOT write it is not guaranteed to conflict with a concurrent write to that same
 * document. So the assignment transaction both reads and writes
 * `responders/{uid}` — it is the `activeIncidentCount` increment that creates the
 * contention. Remove that write and the guards still look correct, still pass
 * their unit tests, and still race in production.
 *
 * `responders/{uid}` is also re-read on EVERY attempt, and the same applies to the
 * responder being *replaced* during a reassignment — their counter is decremented
 * with a read-modify-write, so the reassignment path contends too rather than only
 * the first-assignment path.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS TAKEN FROM THE CALLER EXCEPT AN ID AND A NOTE
 * ---------------------------------------------------------------------------
 * brief §36 lists "client role, client userId, client responderId, client
 * incidentId, client status" as things never to trust. The only way to honour that
 * structurally is for the transaction to be the sole authority on every field it
 * writes. In particular the responder's `status` and `verification` are RE-READ,
 * never accepted from the candidate panel: a dispatcher clicking a row rendered
 * thirty seconds ago may be assigning someone who has since gone offline, and the
 * panel they are looking at cannot be the thing that authorises the write.
 *
 * ---------------------------------------------------------------------------
 * REASSIGNMENT PRESERVES THE OLD DISPATCH
 * ---------------------------------------------------------------------------
 * `docs/08 §3.7`: "close the previous active dispatch as `withdrawn` (reason
 * 'reassigned'), create the new one". brief §32: "Do not overwrite the previous
 * dispatch record." So the old document is closed with `withdrawnAt` /
 * `withdrawnReason` and kept. No `assignment_cancelled` status is invented —
 * `docs/07 §8` has five statuses and they are enough.
 *
 * And the incident is NOT auto-reassigned. brief §18: "Do not automatically assign
 * a replacement without dispatcher confirmation."
 *
 * ---------------------------------------------------------------------------
 * `responder.status` BECOMES `busy`, NEVER `assigned` OR `en_route`
 * ---------------------------------------------------------------------------
 * `docs/07 §7.1` defines exactly three values: `available | busy | offline`. A
 * responder holding a dispatch is `busy`. Inventing an `assigned` value would
 * break every query that filters `status in ['available', 'busy']` — including the
 * candidate query this phase depends on — and `en_route` belongs to the INCIDENT
 * lifecycle, not the responder's availability. The operational detail of where the
 * responder is lives on the incident's `status` and the dispatch's `status`, which
 * is where `docs/07 §4` and `docs/07 §8` put it.
 */

import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { adminConfigurationReason, getAdminDb } from '@/lib/server/firebase-admin';
import { COLLECTIONS } from '@/config/collections';
import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { DISPATCH_EXPIRES_SEC } from '@/config/dispatch';
import {
  checkTransitionPrerequisites,
  evaluateIncidentTransition,
  type TransitionRole,
} from '@/lib/dispatch/transitions';
import { haversineMetersRounded, type LatLng } from '@/lib/geo/distance';
import { auditLogInTransaction, buildAuditDiff } from '@/services/dispatch/audit';
import { appendStatusHistoryInTransaction, buildStatusHistoryEvent } from '@/services/dispatch/status-history';
import type { AuditAction, DispatchMode, IncidentStatus, UserRole } from '@/types';

/* ========================================================================== */
/* Input                                                                       */
/* ========================================================================== */

export type AssignResponderInput = {
  readonly incidentId: string;
  /** Supplied by the dispatcher, and verified inside the transaction. */
  readonly responderUid: string;
  /** The authenticated dispatcher. Never taken from the body. */
  readonly actor: { readonly uid: string; readonly role: UserRole };
  /** `docs/07 §8`: dispatcher instruction, <= 280 chars. */
  readonly note: string | null;
  /**
   * `manual` for a dispatcher choosing from the panel; `self_claimed` for
   * `POST /api/dispatches/:id/claim`.
   *
   * `docs/07 §8` also allows `auto_suggest`, and it is deliberately NOT reachable
   * here. An `auto_suggest` dispatch created by this service would be
   * indistinguishable from a human's decision in the audit trail, which is exactly
   * what brief §3 forbids. Creating one requires a separate code path that does not
   * exist in this phase.
   */
  readonly mode: Extract<DispatchMode, 'manual' | 'self_claimed'>;
  readonly requestId: string;
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  /** A clock, passed in so `expiresAt` is testable and not read from the host. */
  readonly nowMs: number;
};

export type AssignResponderResult = {
  readonly dispatchId: string;
  readonly incidentId: string;
  /**
   * The human `CG-XXXXXX` reference, for notification copy and for anything a
   * person will read. `docs/07 §1.1`: "Citizens and responders quote short codes in
   * the field" — so a notification body containing a 20-character Firestore
   * auto-id is copy that fails at the moment it is most used.
   *
   * Read inside the transaction, so it cannot be stale relative to the write.
   */
  readonly incidentReference: string;
  readonly responderUid: string;
  readonly status: 'active';
  /** `null` when neither position was known. `docs/07 §8`: "for audit and fairness". */
  readonly distanceM: number | null;
  readonly capabilityMatch: boolean;
  /** Set when this call also closed a previous dispatch. `docs/08 §3.7`. */
  readonly replacedDispatchId: string | null;
  /** `true` when the incident was moved to `assigned` by this call. */
  readonly incidentStatusChanged: boolean;
  /** The `statusHistory` event id. FR-052. */
  readonly historyEventId: string | null;
  /** `true` when the call was a no-op because the assignment already existed. */
  readonly noop: boolean;
};

/* ========================================================================== */
/* Refusal copy — brief §40                                                    */
/* ========================================================================== */

/**
 * The two "no longer available" cases say the same thing but mean different things.
 *
 * `RESPONDER_UNAVAILABLE` is a race the dispatcher did nothing wrong for — the
 * responder changed state between the panel rendering and the submit, so the copy
 * tells them to choose someone else and moves on. `RESPONDER_NOT_VERIFIED` and
 * `RESPONDER_AT_CAPACITY` mean the panel offered someone who should not have been
 * offered, which is a bug or a permissions problem worth an alert. Same sentence
 * to the user, different code in the log.
 */
const REFUSALS = {
  incidentNotFound: 'We could not find that incident.',
  responderNotFound: 'We could not find that responder.',
  notVerified: 'That responder has not been verified yet, so they cannot be assigned.',
  unavailable: 'This responder is no longer available. Please choose another responder.',
  atCapacity: 'This responder is already handling as many incidents as they can.',
  alreadyAssigned: 'This incident already has an active dispatch. Withdraw it first, or choose another responder.',
  notDispatchable: 'This incident is not ready to be dispatched yet.',
} as const;

/* ========================================================================== */
/* Document shapes                                                             */
/* ========================================================================== */

type IncidentDoc = {
  readonly status?: string;
  readonly reporterUid?: string;
  readonly reference?: string;
  readonly deletedAt?: unknown;
  readonly geo?: { latitude: number; longitude: number } | null;
  readonly requiredResources?: unknown;
  /**
   * `docs/07 §4`: "current assigned responder; denormalised from the active
   * dispatch". Read here so the transaction can tell a first assignment from a
   * reassignment to the same person, and written below because
   * `firestore.rules`' `canRead()` grants a responder access on exactly this
   * field.
   */
  readonly assigneeUid?: string | null;
};

type ResponderDoc = {
  readonly status?: string;
  readonly verification?: string;
  readonly capabilities?: unknown;
  readonly activeIncidentCount?: number;
  readonly maxConcurrentIncidents?: number;
  readonly totalAssignments?: number;
  readonly homeBase?: { latitude: number; longitude: number } | null;
  readonly displayName?: string;
  readonly deletedAt?: unknown;
};

type DispatchDoc = {
  readonly status?: string;
  readonly responderUid?: string;
  readonly dispatchedAt?: Timestamp;
};

type LocationDoc = {
  readonly geo?: { latitude: number; longitude: number } | null;
};

/* ========================================================================== */
/* The transaction                                                             */
/* ========================================================================== */

export async function assignResponder(input: AssignResponderInput): Promise<AssignResponderResult> {
  if (adminConfigurationReason() !== null) {
    throw new AppError({ code: 'DB_UNAVAILABLE', message: REFUSALS.notDispatchable });
  }

  const db = getAdminDb();
  const log = createLogger(input.requestId);

  const incidentRef = db.collection(COLLECTIONS.incidents).doc(input.incidentId);
  const responderRef = db.collection(COLLECTIONS.responders).doc(input.responderUid);
  const locationRef = db.collection(COLLECTIONS.responderLocations).doc(input.responderUid);
  const dispatchRef = db.collection(COLLECTIONS.dispatches).doc();

  let outcome: AssignResponderResult | null = null;

  try {
    await db.runTransaction(async (transaction) => {
      /* ================================================================== *
       * READ PHASE 1 — the three things the guards need
       * ================================================================== */
      const [incidentSnap, responderSnap, liveDispatchQuery] = await Promise.all([
        transaction.get(incidentRef),
        transaction.get(responderRef),
        // `docs/07 §8`: "At most one document per incident with `status ==
        // 'active'` (FR-053)". Reading the LIVE one both detects a second
        // dispatcher and gives a reassignment the record it must close.
        transaction.get(
          db
            .collection(COLLECTIONS.dispatches)
            .where('incidentId', '==', input.incidentId)
            .where('status', 'in', ['active', 'accepted'])
            .limit(1),
        ),
      ]);

      if (!incidentSnap.exists) {
        throw new AppError({ code: 'INCIDENT_NOT_FOUND', message: REFUSALS.incidentNotFound });
      }
      if (!responderSnap.exists) {
        throw new AppError({ code: 'RESPONDER_NOT_FOUND', message: REFUSALS.responderNotFound });
      }

      const incident = incidentSnap.data() as IncidentDoc;
      const responder = responderSnap.data() as ResponderDoc;
      const liveDispatchDoc = liveDispatchQuery.docs[0] ?? null;
      const liveDispatch = liveDispatchDoc === null ? null : (liveDispatchDoc.data() as DispatchDoc);
      const previousResponderUid = liveDispatch?.responderUid ?? null;

      /* ================================================================== *
       * READ PHASE 2 — only what phase 1 revealed we might need
       * ================================================================== *
       * A reassignment must decrement the PREVIOUS responder's counter, and that
       * decrement is floored at zero, which needs their current value. And
       * `docs/07 §8`'s `distanceM` is "for audit and fairness", so it needs the
       * responder's actual position rather than a placeholder.
       *
       * Both reads are issued together, and only when they can be needed, so the
       * common first-assignment path costs one extra read rather than two.
       */
      const needsPreviousCounter =
        previousResponderUid !== null && previousResponderUid !== input.responderUid;

      const [previousResponderSnap, locationSnap] = await Promise.all([
        needsPreviousCounter
          ? transaction.get(db.collection(COLLECTIONS.responders).doc(previousResponderUid as string))
          : Promise.resolve(null),
        transaction.get(locationRef),
      ]);

      const previousResponder: ResponderDoc | null =
        previousResponderSnap !== null && previousResponderSnap.exists
          ? (previousResponderSnap.data() as ResponderDoc)
          : null;

      /* ================================================================== *
       * GUARD 1 — the incident may be dispatched
       * ================================================================== */
      // A soft-deleted incident is refused explicitly rather than by its status,
      // because a deleted incident keeps its last status and would otherwise still
      // look dispatchable.
      if (incident.deletedAt != null) {
        throw new AppError({ code: 'INCIDENT_NOT_FOUND', message: REFUSALS.incidentNotFound });
      }

      const currentStatus = (
        typeof incident.status === 'string' ? incident.status : 'new'
      ) as IncidentStatus;

      const transition = evaluateIncidentTransition(currentStatus, 'assigned', {
        role: input.actor.role as TransitionRole,
        uid: input.actor.uid,
        isReporter: incident.reporterUid === input.actor.uid,
        // A dispatcher creating a dispatch is never the live assignee of it.
        // Asserting otherwise would be a way to reach the `assigned responder`
        // cells of the table through this flag.
        isLiveAssignee: false,
        hasActiveDispatch: liveDispatch !== null,
      });
      if (!transition.allowed) {
        throw new AppError({ code: 'INVALID_STATUS_TRANSITION', message: REFUSALS.notDispatchable });
      }

      const prerequisites = checkTransitionPrerequisites('assigned', {
        // This transaction is what creates the dispatch, so by the time the
        // incident is written the guard's condition is satisfied by construction.
        hasActiveDispatch: true,
        isVerified: false,
        currentStatus,
        resolutionCode: null,
      });
      if (!prerequisites.ok) {
        // `NO_ACTIVE_DISPATCH` cannot actually fire on this path — the transition
        // being attempted always creates one — and the branch is kept so a future
        // caller that does not create a dispatch reports the real invariant rather
        // than the generic "not ready".
        throw new AppError({
          code: prerequisites.code,
          message: REFUSALS.notDispatchable,
        });
      }

      /* ================================================================== *
       * GUARD 2 — the responder is assignable. RE-READ IN PHASE 1.
       * ================================================================== */
      if (responder.verification !== 'verified') {
        throw new AppError({ code: 'RESPONDER_NOT_VERIFIED', message: REFUSALS.notVerified });
      }
      if (responder.status !== 'available' && responder.status !== 'busy') {
        throw new AppError({ code: 'RESPONDER_UNAVAILABLE', message: REFUSALS.unavailable });
      }

      const activeCount = readCount(responder.activeIncidentCount);
      const maxConcurrent = Math.max(1, readCount(responder.maxConcurrentIncidents, 1));
      if (activeCount >= maxConcurrent) {
        throw new AppError({ code: 'RESPONDER_AT_CAPACITY', message: REFUSALS.atCapacity });
      }

      /* ================================================================== *
       * GUARD 3 — assigning the responder who is ALREADY assigned
       * ================================================================== *
       * A no-op, not an error. A dispatcher double-clicking "Confirm assignment"
       * should get the assignment they already made, not a 409 they have to
       * interpret. brief §22's confirmation dialog exists to make an accidental
       * single click harmless; punishing the double click would undo that.
       */
      if (liveDispatch !== null && previousResponderUid === input.responderUid) {
        outcome = {
          dispatchId: liveDispatchDoc?.id ?? '',
          incidentId: input.incidentId,
          incidentReference:
            typeof incident.reference === 'string' ? incident.reference : input.incidentId,
          responderUid: input.responderUid,
          status: 'active',
          distanceM: null,
          capabilityMatch: readCapabilityMatch(incident, responder),
          replacedDispatchId: null,
          incidentStatusChanged: false,
          historyEventId: null,
          noop: true,
        };
        return;
      }

      /* ================================================================== *
       * DERIVED VALUES
       * ================================================================== */
      // `docs/07 §8`: "`etaSec` … derived from distance and `avgResponseSec`;
      // advisory only". It is written as `null` and NOT computed. brief §30: "Do
      // not claim travel time unless a real routing API has been implemented.
      // Distance is not the same than ETA." There is no routing provider in this
      // project, and a straight-line-derived ETA is a number a dispatcher would
      // read as a promise about traffic.
      const distanceM = computeDistanceM(incident, responder, locationSnap?.exists ? (locationSnap.data() as LocationDoc) : null);
      const capabilityMatch = readCapabilityMatch(incident, responder);

      const serverNow = FieldValue.serverTimestamp();
      const expiresAt = Timestamp.fromMillis(input.nowMs + DISPATCH_EXPIRES_SEC * 1000);

      /* ================================================================== *
       * WRITE PHASE
       * ================================================================== *
       * From here on nothing throws, so a refusal above cannot leave a partial
       * write behind. Firestore rolls back on throw regardless, but the ordering
       * means the guards are the only place a refusal is produced.
       */

      // 1. the dispatch. `merge: false`: this document is new.
      transaction.set(
        dispatchRef,
        {
          dispatchId: dispatchRef.id,
          incidentId: input.incidentId,
          responderUid: input.responderUid,
          dispatchedBy: input.actor.uid,
          mode: input.mode,
          status: 'active',
          distanceM,
          etaSec: null,
          capabilityMatch,
          note: input.note,
          notified: true,
          notifiedAt: serverNow,
          responseSec: null,
          dispatchedAt: serverNow,
          acceptedAt: null,
          withdrawnAt: null,
          withdrawnReason: null,
          completedAt: null,
          expiresAt,
          createdAt: serverNow,
          updatedAt: serverNow,
        },
        { merge: false },
      );

      // 2. THE RESPONDER'S COUNTERS. This write is the contention point described
      //    in the file header. Without it this transaction would only read the
      //    responder and two concurrent dispatches would both commit.
      //
      //    `merge: true` deliberately: only these four fields change, and the rest
      //    of the profile — capabilities, certifications, homeBase — must not be
      //    rewritten from a copy that was read at the start of this transaction.
      transaction.set(
        responderRef,
        {
          // `busy`, never `assigned` or `en_route`. `docs/07 §7.1` defines three
          // values and inventing a fourth would break the candidate query.
          status: 'busy',
          activeIncidentCount: activeCount + 1,
          totalAssignments: readCount(responder.totalAssignments) + 1,
          updatedAt: serverNow,
        },
        { merge: true },
      );

      // 3. the incident moves to `assigned`. FR-053 requires a dispatch to exist
      //    for it, and this transaction is what makes one exist, atomically.
      const incidentChanged = currentStatus !== 'assigned';
      if (incidentChanged || incident.assigneeUid !== input.responderUid) {
        transaction.set(
          incidentRef,
          {
            status: 'assigned',
            assignedAt: serverNow,
            // `docs/07 §4`: "`assigneeUid` | `string | null` | current assigned
            // responder; **denormalised from the active dispatch**".
            //
            // This is not an optimisation. `firestore.rules`' `canRead()` for
            // `incidents` grants a responder access when
            // `resource.data.assigneeUid == request.auth.uid`, so WITHOUT this write
            // an assigned responder cannot read their own incident and the whole
            // assignment workflow is unreachable from the client. It is also the
            // index backing `docs/07 §4`'s "responder assignments" query.
            assigneeUid: input.responderUid,
            // `docs/07 §4`'s denormalised summary, so a dispatcher's queue list
            // renders a name without a join. `AssigneeSummary` is exactly
            // `{uid, displayName, status}`.
            assignee: {
              uid: input.responderUid,
              displayName: responderName(responder, input.responderUid),
              status: 'busy',
            },
            updatedAt: serverNow,
          },
          { merge: true },
        );
      }

      // 4. close the previous dispatch, PRESERVING it. brief §32, docs/08 §3.7.
      let replacedDispatchId: string | null = null;
      if (liveDispatchDoc !== null && previousResponderUid !== null) {
        replacedDispatchId = liveDispatchDoc.id;
        transaction.set(
          liveDispatchDoc.ref,
          {
            status: 'withdrawn',
            withdrawnAt: serverNow,
            // `docs/08 §3.7` names this reason verbatim.
            withdrawnReason: 'reassigned',
            updatedAt: serverNow,
          },
          { merge: true },
        );

        // 5. release the previous responder's slot, in the SAME transaction, with a
        //    read-modify-write so the counter is floored at zero.
        //
        //    `inc(-1)` cannot be floored, and a counter that goes negative makes
        //    `activeCount >= maxConcurrent` false forever — that responder would be
        //    permanently assignable past their limit, which is the exact
        //    over-commitment FR-053 exists to prevent.
        //
        //    The read was taken in phase 2, and the write makes this document a
        //    contention point for the reassignment race too.
        if (previousResponder !== null) {
          transaction.set(
            db.collection(COLLECTIONS.responders).doc(previousResponderUid),
            {
              activeIncidentCount: Math.max(0, readCount(previousResponder.activeIncidentCount) - 1),
              // A responder with no incidents left becomes available again, unless
              // they have gone offline in the meantime — which `previousResponder`
              // was re-read for, so this does not resurrect someone who logged off.
              status:
                readCount(previousResponder.activeIncidentCount) - 1 <= 0 && previousResponder.status === 'busy'
                  ? 'available'
                  : previousResponder.status,
              updatedAt: serverNow,
            },
            { merge: true },
          );
        }
      }

      // 6. the status history event, in the same transaction. FR-052.
      const historyEventId = appendStatusHistoryInTransaction(
        transaction,
        incidentRef,
        buildStatusHistoryEvent({
          incidentId: input.incidentId,
          eventType: incidentChanged ? 'assigned' : 'status_change',
          fromStatus: currentStatus,
          toStatus: 'assigned',
          actorUid: input.actor.uid,
          actorRole: input.actor.role as TransitionRole,
          // `docs/07 §6` requires a reason for `unassigned`, not for `assigned` —
          // the reason for assigning is the decision itself.
          reason: null,
          note: input.note,
          // The scalar metadata union makes a coordinate unrepresentable here
          // without a cast. `responderUid` is an id, not a location.
          metadata: {
            dispatchId: dispatchRef.id,
            responderUid: input.responderUid,
            replacedDispatchId,
            mode: input.mode,
          },
          requestId: input.requestId,
        }),
      );

      // 7. the audit row, in the SAME transaction.
      //
      //    `docs/07 §11.5` is append-only and FR-130/FR-131 make the audit trail
      //    the record of privileged actions. Writing it here rather than after the
      //    commit means there is no window in which a responder has been dispatched
      //    and the assignment is not on record. The cost — a retried transaction
      //    writes two audit rows with different ids — is accepted deliberately, and
      //    `auditLogInTransaction`'s note tells consumers to key on
      //    `action + entityId + createdAt` rather than the id.
      transaction.set(
        db.collection(COLLECTIONS.auditLogs).doc(),
        auditLogInTransaction({
          actorUid: input.actor.uid,
          actorRole: input.actor.role,
          action: 'incident.assign',
          entityType: 'dispatch',
          entityId: dispatchRef.id,
          incidentRef: typeof incident.reference === 'string' ? incident.reference : null,
          summary: `Assigned a responder to incident ${input.incidentId}.`,
          // Whitelisted field names, never a spread of the document. A coordinate
          // or a display name cannot reach an audit row through this list.
          before: buildAuditDiff({ status: currentStatus }, ['status']),
          after: buildAuditDiff(
            { status: 'assigned', responderStatus: 'busy', activeIncidentCount: activeCount + 1 },
            ['status', 'responderStatus', 'activeIncidentCount'],
          ),
          reason: input.note,
          requestId: input.requestId,
          ipHash: input.ipHash,
          userAgent: input.userAgent,
        }),
        { merge: false },
      );

      outcome = {
        dispatchId: dispatchRef.id,
        incidentId: input.incidentId,
        incidentReference:
          typeof incident.reference === 'string' ? incident.reference : input.incidentId,
        responderUid: input.responderUid,
        status: 'active',
        distanceM,
        capabilityMatch,
        replacedDispatchId,
        incidentStatusChanged: incidentChanged,
        historyEventId,
        noop: false,
      };
    });
  } catch (error) {
    // An `AppError` is a refusal this module decided on, and the dispatcher's copy
    // is already correct — it is rethrown untouched, including the status.
    if (error instanceof AppError) throw error;

    // Anything else is a lost race that exhausted its retries, or Firestore being
    // unavailable. Both are answered with brief §40's sentence rather than a bare
    // 500, because "this responder is no longer available, please choose another"
    // is what a dispatcher needs to hear, and a bare 503 tells them nothing about
    // what to do next.
    log.warn({
      code: 'DB_UNAVAILABLE',
      path: 'services.dispatch.assign',
      status: 503,
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError({ code: 'DB_UNAVAILABLE', message: REFUSALS.unavailable });
  }

  if (outcome === null) {
    // Unreachable in practice: the callback either sets `outcome` or throws. A
    // `null` would mean the SDK returned without running it, and answering 200 with
    // no dispatch id would be worse than failing loudly.
    throw new AppError({ code: 'INTERNAL', message: REFUSALS.notDispatchable });
  }

  return outcome;
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/** A non-negative finite integer, or the fallback. Guards `NaN` and negatives. */
function readCount(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * The responder's display name, falling back to the uid.
 *
 * A blank name renders as a blank cell in a dispatcher's queue, which is the one
 * thing they cannot act on. The uid fallback keeps the row identifiable and
 * contactable through the directory.
 */
function responderName(responder: ResponderDoc, uid: string): string {
  return typeof responder.displayName === 'string' && responder.displayName.trim().length > 0
    ? responder.displayName.trim()
    : uid;
}

/** A finite coordinate pair, or `null`. Rejects `NaN` and out-of-range. */
function toLatLng(source: { latitude: number; longitude: number } | null | undefined): LatLng | null {
  if (source == null) return null;
  const { latitude, longitude } = source;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  return { lat: latitude, lng: longitude };
}

/**
 * `docs/07 §8`'s `distanceM`: "distance at assignment time, for audit and
 * fairness".
 *
 * Reuses Phase 6's `haversineMetersRounded` — brief §30: "Calculate Responder →
 * Incident using the Phase 6 geographic utilities. **Do not create a second
 * distance implementation.**"
 *
 * The responder's LIVE position is preferred and `homeBase` is the fallback, which
 * is `docs/07 §7.1`'s stated order. `null` when neither is known, because a `0`
 * would record "this responder was standing on the incident" — a false statement in
 * a fairness metric, and the field exists precisely so that distance can be
 * compared between responders over time.
 */
function computeDistanceM(
  incident: IncidentDoc,
  responder: ResponderDoc,
  location: LocationDoc | null,
): number | null {
  const target = toLatLng(incident.geo);
  if (target === null) return null;
  const origin = toLatLng(location?.geo) ?? toLatLng(responder.homeBase);
  if (origin === null) return null;
  return haversineMetersRounded(origin, target);
}

/**
 * `docs/07 §8`: `capabilityMatch` is "all incident
 * `requiredResources.resourceId` present in `capabilities`".
 *
 * Read from the responder document ALREADY read by the transaction, so the answer
 * cannot disagree with the availability check beside it. When the incident
 * requires nothing this is `true`: the dispatch was still a dispatcher's decision,
 * and a record claiming the capabilities did not match would be a false criticism
 * of it.
 */
function readCapabilityMatch(incident: IncidentDoc, responder: ResponderDoc): boolean {
  const required = Array.isArray(incident.requiredResources)
    ? incident.requiredResources.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  if (required.length === 0) return true;
  const capabilities = Array.isArray(responder.capabilities)
    ? responder.capabilities.filter((item): item is string => typeof item === 'string')
    : [];
  return required.every((resource) => capabilities.includes(resource));
}

/** Re-exported so a route can build the `AuditAction` without importing two modules. */
export type { AuditAction };

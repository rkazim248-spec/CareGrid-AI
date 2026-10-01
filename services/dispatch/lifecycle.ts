/**
 * ============================================================================
 * CareGrid AI — dispatch and incident lifecycle
 * ============================================================================
 *
 * `docs/08 §3.8`, `docs/08 §3.7`, `docs/07 §4.3`, `docs/07 §6`, `docs/07 §8`.
 * **SERVER ONLY.**
 *
 * ---------------------------------------------------------------------------
 * EVERY MUTATION HERE IS THE SAME SHAPE
 * ---------------------------------------------------------------------------
 * 1. Verify the actor against the RESOURCE, server-side. Never against a claim.
 * 2. Ask the pure table in `lib/dispatch/transitions.ts` whether the step is legal.
 * 3. Re-read the documents INSIDE one transaction.
 * 4. Write the state change, the `statusHistory` event and the `auditLogs` row in
 *    that ONE transaction.
 * 5. Notify, best-effort, AFTER the commit.
 *
 * Steps 4 and 5 being separate is the important one. A notification written inside
 * the transaction would roll back with it — correct, but then a Firestore write
 * failure inside the notification step would take the dispatch down with it, and
 * FR-107 says a notification failure must never fail the request. A notification
 * written before the commit would tell a responder about an assignment that then
 * failed. So it is after.
 *
 * ---------------------------------------------------------------------------
 * THE AUTHORISATION IS AGAINST THE DOCUMENT, NOT AGAINST A CLAIM
 * ---------------------------------------------------------------------------
 * brief §36: "Never trust: client role, client userId, client responderId, client
 * incidentId, client status."
 *
 * `actor.uid` and `actor.role` come from a verified ID token. Everything else — is
 * this the responder's dispatch, is this the reporter's incident, is there a live
 * dispatch, is the responder still `available` — is answered by reading Firestore
 * inside the transaction. `isLiveAssignee` and `isReporter` are computed HERE and
 * passed to the pure table as booleans, so the table never has to trust anything.
 *
 * ---------------------------------------------------------------------------
 * NOBODY IS REASSIGNED AUTOMATICALLY
 * ---------------------------------------------------------------------------
 * brief §18: "If a responder rejects: Assigned → Rejected → Back to dispatcher →
 * Another responder. Do not automatically assign a replacement without dispatcher
 * confirmation."
 *
 * So a decline closes the dispatch, returns the responder's capacity, moves the
 * incident BACK to the state a dispatcher can act on, notifies the dispatcher, and
 * stops. There is no "find someone else" step anywhere in this file, and that
 * absence is the human-in-the-loop rule.
 */

import 'server-only';

import { FieldValue, type Timestamp } from 'firebase-admin/firestore';

import { adminConfigurationReason, getAdminDb } from '@/lib/server/firebase-admin';
import { COLLECTIONS } from '@/config/collections';
import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import {
  allowedIncidentTransitions,
  canTransitionDispatchStatus,
  checkTransitionPrerequisites,
  evaluateIncidentTransition,
  type DispatchStatus,
  type TransitionRole,
} from '@/lib/dispatch/transitions';
import type { ResolutionRecord } from '@/config/dispatch';
import { auditLogInTransaction, buildAuditDiff } from '@/services/dispatch/audit';
import { appendStatusHistoryInTransaction, buildStatusHistoryEvent } from '@/services/dispatch/status-history';
import { NOTIFICATION_COPY, recipientsForEvent } from '@/services/dispatch/notify';
import { deliverToRecipients } from '@/services/notifications';
import type { AuditAction, HistoryEventType, IncidentStatus, UserRole } from '@/types';

/* ========================================================================== */
/* The shared actor type                                                       */
/* ========================================================================== */

/**
 * The authenticated caller. `uid` and `role` come from a verified ID token; a
 * client-supplied role never reaches this type.
 */
export type DispatchActor = {
  readonly uid: string;
  readonly role: UserRole;
};

export type RequestContextLite = {
  readonly requestId: string;
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  readonly nowMs: number;
};

/* ========================================================================== */
/* Responding to an assignment                                                 */
/* ========================================================================== */

export type RespondInput = {
  readonly dispatchId: string;
  readonly actor: DispatchActor;
  /** `accepted` or `withdrawn`. `docs/07 §8`'s vocabulary. */
  readonly decision: Extract<DispatchStatus, 'accepted' | 'withdrawn'>;
  /**
   * brief §16's decline reasons. Free text, because "Other" plus a responder's own
   * words is the honest option and a mandatory list would force a false one.
   */
  readonly reason: string | null;
  readonly context: RequestContextLite;
};

export type RespondResult = {
  readonly dispatchId: string;
  readonly status: DispatchStatus;
  readonly incidentId: string;
  /** `null` when the call was a no-op. */
  readonly historyEventId: string | null;
  readonly noop: boolean;
  /**
   * The live dispatch id at the time of the answer, so the route can find the
   * incident's reference and the assigning dispatcher for the notification without
   * a second read. `null` on a noop, where nothing changed to describe.
   */
  readonly liveDispatchIdBefore: string | null;
};

const RESPOND_COPY = {
  dispatchNotFound: 'We could not find that assignment.',
  notYourAssignment: 'This assignment is not yours.',
  alreadyAnswered: 'You have already responded to this assignment.',
  expired: 'This assignment expired before you responded to it. Ask a dispatcher to reassign it.',
} as const;

/**
 * Accept or decline an assignment. Transactional.
 *
 * **Only the subject responder may accept** — `canTransitionDispatchStatus` refuses
 * a dispatcher accepting on a responder's behalf, and that refusal is the
 * mechanism by which `accepted` remains a fact about the responder rather than
 * about the dispatcher. Declining is permitted for the subject and for a
 * dispatcher cancelling, which are different acts that happen to share a status.
 */
export async function respondToDispatch(input: RespondInput): Promise<RespondResult> {
  if (adminConfigurationReason() !== null) {
    throw new AppError({ code: 'DB_UNAVAILABLE', message: 'The database is temporarily unavailable.' });
  }

  const db = getAdminDb();
  const log = createLogger(input.context.requestId);
  const dispatchRef = db.collection(COLLECTIONS.dispatches).doc(input.dispatchId);

  let outcome: RespondResult | null = null;

  try {
    await db.runTransaction(async (transaction) => {
      const dispatchSnap = await transaction.get(dispatchRef);
      if (!dispatchSnap.exists) {
        throw new AppError({ code: 'NOT_FOUND', message: RESPOND_COPY.dispatchNotFound });
      }

      const dispatch = dispatchSnap.data() as {
        status?: string;
        responderUid?: string;
        incidentId?: string;
        dispatchedAt?: Timestamp;
        expiresAt?: Timestamp | null;
      };

      const current = (typeof dispatch.status === 'string' ? dispatch.status : 'active') as DispatchStatus;
      const isSubject = dispatch.responderUid === input.actor.uid;

      /* --- the transition table decides, with server-derived facts -------- */
      const permitted = canTransitionDispatchStatus(current, input.decision, {
        role: input.actor.role as TransitionRole,
        isSubject,
        isExpired: isExpired(dispatch.expiresAt, input.context.nowMs),
      });
      if (!permitted) {
        // A repeat is a noop rather than an error: a responder tapping Accept twice
        // on a slow connection has done nothing wrong, and `docs/08 §3.8` sets that
        // precedent for the incident table.
        if (current === input.decision) {
          outcome = {
            dispatchId: input.dispatchId,
            status: current,
            incidentId: dispatch.incidentId ?? '',
            historyEventId: null,
            noop: true,
            liveDispatchIdBefore: null,
          };
          return;
        }
        if (!isSubject && input.actor.role === 'responder') {
          throw new AppError({ code: 'FORBIDDEN', message: RESPOND_COPY.notYourAssignment });
        }
        throw new AppError({ code: 'INVALID_STATUS_TRANSITION', message: RESPOND_COPY.alreadyAnswered });
      }

      // An expired assignment cannot be accepted. `docs/07 §8`: the sweep marks it
      // `expired`, and an `expired` dispatch is terminal. Accepting one anyway
      // would put a responder on their way to an incident a dispatcher has already
      // been told nobody accepted.
      if (
        input.decision === 'accepted' &&
        isExpired(dispatch.expiresAt, input.context.nowMs)
      ) {
        throw new AppError({ code: 'RESPONDER_UNAVAILABLE', message: RESPOND_COPY.expired });
      }

      const incidentId = dispatch.incidentId ?? '';
      const incidentRef = db.collection(COLLECTIONS.incidents).doc(incidentId);
      const incidentSnap = await transaction.get(incidentRef);
      const incident = incidentSnap.exists
        ? (incidentSnap.data() as { reporterUid?: string; reference?: string; status?: string })
        : {};

      const serverNow = FieldValue.serverTimestamp();

      /* --- the dispatch --------------------------------------------------- */
      transaction.set(
        dispatchRef,
        input.decision === 'accepted'
          ? {
              status: 'accepted',
              acceptedAt: serverNow,
              // `docs/07 §8`: "`responseSec` | `respondedAt - dispatchedAt`". A
              // nullable number rather than a FieldValue, because the difference of
              // two server timestamps is not a thing Firestore can compute.
              responseSec: computeResponseSec(dispatch.dispatchedAt, input.context.nowMs),
              updatedAt: serverNow,
            }
          : {
              status: 'withdrawn',
              withdrawnAt: serverNow,
              withdrawnReason: input.reason ?? 'declined',
              responseSec: computeResponseSec(dispatch.dispatchedAt, input.context.nowMs),
              updatedAt: serverNow,
            },
        { merge: true },
      );

      /* --- release the responder's capacity ------------------------------ */
      // A responder who declines must get their slot back, in the same
      // transaction, or a dispatcher who is refused for "at capacity" cannot
      // understand why.
      if (dispatch.responderUid) {
        const responderRef = db.collection(COLLECTIONS.responders).doc(dispatch.responderUid);
        const responderSnap = await transaction.get(responderRef);
        if (responderSnap.exists) {
          const responder = responderSnap.data() as {
            activeIncidentCount?: number;
            status?: string;
          };
          const current2 = readCount(responder.activeIncidentCount);
          transaction.set(
            responderRef,
            {
              activeIncidentCount: Math.max(0, current2 - 1),
              // Back to `available` only if they were `busy` and are now free. An
              // `offline` responder stays `offline` — they may have logged off
              // during the two minutes the assignment sat there.
              status: current2 - 1 <= 0 && responder.status === 'busy' ? 'available' : responder.status,
              updatedAt: serverNow,
            },
            { merge: true },
          );
        }
      }

      /* --- the incident goes BACK to a dispatcher's queue ------------------ */
      // brief §18: a rejection goes "back to the dispatcher". The incident is moved
      // to `triaged` — the state a dispatcher can act on — rather than left at
      // `assigned` pointing at a dispatch that no longer exists. `triaged` is
      // reachable from `assigned` for a dispatcher per `docs/07 §4.3`, so this is
      // a legal transition and not a special case.
      //
      // `assigneeUid` and `assignee` are CLEARED, and this is a security property
      // rather than tidiness: `firestore.rules`' `canRead()` for `incidents` grants
      // a responder access while `resource.data.assigneeUid == request.auth.uid`, so
      // leaving the field set would keep granting a responder who just declined —
      // or whose dispatch a dispatcher cancelled — read access to an incident they
      // are no longer on.
      if (incident.status === 'assigned' && input.decision === 'withdrawn') {
        transaction.set(
          incidentRef,
          { status: 'triaged', assigneeUid: null, assignee: null, updatedAt: serverNow },
          { merge: true },
        );
      }

      /* --- the history event --------------------------------------------- */
      const eventType: HistoryEventType = input.decision === 'accepted' ? 'status_change' : 'unassigned';
      const historyEventId = appendStatusHistoryInTransaction(
        transaction,
        incidentRef,
        buildStatusHistoryEvent({
          incidentId,
          // `docs/07 §6` requires a reason for `unassigned`. The builder throws if
          // one is missing, so a decline without a reason fails here rather than
          // writing a row that explains nothing.
          eventType,
          fromStatus: (incident.status ?? 'assigned') as IncidentStatus,
          toStatus: input.decision === 'withdrawn' ? 'triaged' : 'assigned',
          actorUid: input.actor.uid,
          actorRole: input.actor.role as TransitionRole,
          reason: input.reason,
          note: null,
          metadata: { dispatchId: input.dispatchId, decision: input.decision },
          requestId: input.context.requestId,
        }),
      );

      /* --- the audit row -------------------------------------------------- */
      transaction.set(
        db.collection(COLLECTIONS.auditLogs).doc(),
        auditLogInTransaction({
          actorUid: input.actor.uid,
          actorRole: input.actor.role,
          action: (input.decision === 'accepted'
            ? 'incident.status_change'
            : 'incident.unassign') satisfies AuditAction,
          entityType: 'dispatch',
          entityId: input.dispatchId,
          incidentRef: typeof incident.reference === 'string' ? incident.reference : null,
          summary:
            input.decision === 'accepted'
              ? 'Assignment accepted.'
              : 'Assignment declined or withdrawn.',
          before: buildAuditDiff({ dispatchStatus: current }, ['dispatchStatus']),
          after: buildAuditDiff({ dispatchStatus: input.decision }, ['dispatchStatus']),
          reason: input.reason,
          requestId: input.context.requestId,
          ipHash: input.context.ipHash,
          userAgent: input.context.userAgent,
        }),
        { merge: false },
      );

      outcome = {
        dispatchId: input.dispatchId,
        status: input.decision,
        incidentId,
        historyEventId,
        noop: false,
        // Recorded so the route can resolve the incident reference and the
        // assigning dispatcher for the notification without a second read.
        liveDispatchIdBefore: input.dispatchId,
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    log.warn({
      code: 'DB_UNAVAILABLE',
      path: 'services.dispatch.respond',
      status: 503,
      decision: input.decision,
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError({ code: 'DB_UNAVAILABLE', message: 'The database is temporarily unavailable. Nothing was changed.' });
  }

  if (outcome === null) {
    throw new AppError({ code: 'INTERNAL', message: 'Something went wrong. Nothing was changed.' });
  }

  return outcome;
}

/* ========================================================================== */
/* The generic incident status transition — docs/08 §3.8                       */
/* ========================================================================== */

export type TransitionIncidentInput = {
  readonly incidentId: string;
  readonly to: IncidentStatus;
  readonly actor: DispatchActor;
  readonly reason: string | null;
  readonly note: string | null;
  /** `docs/07 §4`'s `resolutionCode`. Required by FR-054 for `resolved`. */
  readonly resolutionCode: string | null;
  /** brief §34. Every field optional; `null` genuinely means "not recorded". */
  readonly resolution: ResolutionRecord | null;
  readonly context: RequestContextLite;
};

export type TransitionIncidentResult = {
  readonly incidentId: string;
  readonly from: IncidentStatus;
  readonly to: IncidentStatus;
  /** `docs/08 §3.8`: "Repeating the same transition returns `200` with `meta.noop: true`". */
  readonly noop: boolean;
  readonly historyEventId: string | null;
  /** US-012: the legal targets, so the client renders one primary action. */
  readonly allowedNext: readonly IncidentStatus[];
  /** The dispatch to close, when this transition completed one. */
  readonly completedDispatchId: string | null;
};

/**
 * Move an incident to a new status. Transactional.
 *
 * **This is the only path to `en_route`, `on_scene` and `resolved`.** A responder
 * pressing "Mark On Scene" and a dispatcher pressing it on their behalf both land
 * here, and both are checked against the same table with the same server-derived
 * facts — which is what makes "a responder may only update their own assignment"
 * true rather than merely intended.
 */
export async function transitionIncident(
  input: TransitionIncidentInput,
): Promise<TransitionIncidentResult> {
  if (adminConfigurationReason() !== null) {
    throw new AppError({ code: 'DB_UNAVAILABLE', message: 'The database is temporarily unavailable.' });
  }

  const db = getAdminDb();
  const log = createLogger(input.context.requestId);
  const incidentRef = db.collection(COLLECTIONS.incidents).doc(input.incidentId);

  let outcome: TransitionIncidentResult | null = null;

  try {
    await db.runTransaction(async (transaction) => {
      const incidentSnap = await transaction.get(incidentRef);
      if (!incidentSnap.exists) {
        throw new AppError({ code: 'INCIDENT_NOT_FOUND', message: 'We could not find that incident.' });
      }

      const incident = incidentSnap.data() as {
        status?: string;
        reporterUid?: string;
        reference?: string;
        deletedAt?: unknown;
        verifiedAt?: Timestamp | null;
        resolutionCode?: string | null;
      };

      if (incident.deletedAt != null) {
        throw new AppError({ code: 'INCIDENT_NOT_FOUND', message: 'We could not find that incident.' });
      }

      const from = (typeof incident.status === 'string' ? incident.status : 'new') as IncidentStatus;

      /* --- find the LIVE dispatch, so "is this the assignee" is a fact ----- */
      const liveDispatchQuery = await transaction.get(
        db
          .collection(COLLECTIONS.dispatches)
          .where('incidentId', '==', input.incidentId)
          .where('status', 'in', ['active', 'accepted'])
          .limit(1),
      );
      const liveDispatchDoc = liveDispatchQuery.docs[0] ?? null;
      const liveDispatch = liveDispatchDoc === null
        ? null
        : (liveDispatchDoc.data() as { responderUid?: string; status?: string });

      /* --- the table decides --------------------------------------------- */
      const transitionContext = {
        role: input.actor.role as TransitionRole,
        uid: input.actor.uid,
        isReporter: incident.reporterUid === input.actor.uid,
        // SERVER-DERIVED. A client cannot assert this; it is a comparison against
        // the dispatch document just read.
        isLiveAssignee: liveDispatch?.responderUid === input.actor.uid,
        hasActiveDispatch: liveDispatch !== null,
      };

      const decision = evaluateIncidentTransition(from, input.to, transitionContext);

      if (!decision.allowed) {
        throw new AppError({
          code: 'INVALID_STATUS_TRANSITION',
          message: refusalFor(decision.reason),
        });
      }

      /* --- the non-role prerequisites ------------------------------------ */
      const prerequisites = checkTransitionPrerequisites(input.to, {
        hasActiveDispatch: liveDispatch !== null,
        isVerified: incident.verifiedAt != null,
        currentStatus: from,
        resolutionCode: input.resolutionCode ?? incident.resolutionCode ?? null,
      });
      if (!prerequisites.ok) {
        throw new AppError({
          code: prerequisites.code === 'RESOLUTION_CODE_REQUIRED'
            ? 'RESOLUTION_CODE_REQUIRED'
            : prerequisites.code,
          message:
            prerequisites.code === 'RESOLUTION_CODE_REQUIRED'
              ? 'Choose how this incident was resolved before marking it resolved.'
              : 'This incident has no active assignment.',
        });
      }

      /* --- a repeat is a NOOP with `allowedNext` (docs/08 §3.8) ----------- */
      if (from === input.to) {
        outcome = {
          incidentId: input.incidentId,
          from,
          to: input.to,
          noop: true,
          historyEventId: null,
          allowedNext: allowedIncidentTransitions(from, transitionContext),
          completedDispatchId: null,
        };
        return;
      }

      const serverNow = FieldValue.serverTimestamp();

      /* --- the incident --------------------------------------------------- */
      // `docs/07 §4.3` calls `assigned → on_scene` a "documented jump, flagged". The
      // flag is the `skippedEnRoute` metadata below: the transition is allowed
      // because a responder who arrives without opening the app has told us
      // something real, and the record says which step was skipped.
      const skippedEnRoute = from === 'assigned' && input.to === 'on_scene';

      transaction.set(
        incidentRef,
        {
          status: input.to,
          updatedAt: serverNow,
          ...(input.to === 'resolved'
            ? {
                resolvedAt: serverNow,
                resolutionCode: input.resolutionCode,
                resolution: input.resolution === null ? null : { ...input.resolution },
                resolvedBy: input.actor.uid,
              }
            : {}),
        },
        { merge: true },
      );

      /* --- completing the dispatch, when the incident is resolved ---------- */
      // `docs/07 §8`: `completedAt` is set when the work is done. Leaving a
      // `completed` incident with an `accepted` dispatch would hold the responder's
      // capacity for an incident that no longer exists.
      let completedDispatchId: string | null = null;
      if (input.to === 'resolved' && liveDispatchDoc !== null && liveDispatch?.status === 'accepted') {
        completedDispatchId = liveDispatchDoc.id;
        transaction.set(
          liveDispatchDoc.ref,
          { status: 'completed', completedAt: serverNow, updatedAt: serverNow },
          { merge: true },
        );
      }

      /* --- the history event ---------------------------------------------- */
      const historyEventId = appendStatusHistoryInTransaction(
        transaction,
        incidentRef,
        buildStatusHistoryEvent({
          incidentId: input.incidentId,
          eventType: historyEventFor(input.to),
          fromStatus: from,
          toStatus: input.to,
          actorUid: input.actor.uid,
          actorRole: input.actor.role as TransitionRole,
          reason: input.reason,
          note: input.note,
          metadata: {
            dispatchId: liveDispatchDoc?.id ?? null,
            // The documented jump, recorded rather than refused.
            skippedEnRoute,
            completedDispatchId,
          },
          requestId: input.context.requestId,
        }),
      );

      /* --- the audit row --------------------------------------------------- */
      transaction.set(
        db.collection(COLLECTIONS.auditLogs).doc(),
        auditLogInTransaction({
          actorUid: input.actor.uid,
          actorRole: input.actor.role,
          action: 'incident.status_change',
          entityType: 'incident',
          entityId: input.incidentId,
          incidentRef: typeof incident.reference === 'string' ? incident.reference : null,
          summary: `Incident status changed to ${input.to}.`,
          before: buildAuditDiff({ status: from }, ['status']),
          after: buildAuditDiff({ status: input.to }, ['status']),
          // `docs/07 §11.5`: a privileged action carries a reason.
          reason: input.reason,
          requestId: input.context.requestId,
          ipHash: input.context.ipHash,
          userAgent: input.context.userAgent,
        }),
        { merge: false },
      );

      outcome = {
        incidentId: input.incidentId,
        from,
        to: input.to,
        noop: false,
        historyEventId,
        allowedNext: allowedIncidentTransitions(input.to, transitionContext),
        completedDispatchId,
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    log.warn({
      code: 'DB_UNAVAILABLE',
      path: 'services.dispatch.transition',
      status: 503,
      to: input.to,
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError({ code: 'DB_UNAVAILABLE', message: 'The database is temporarily unavailable. Nothing was changed.' });
  }

  if (outcome === null) {
    throw new AppError({ code: 'INTERNAL', message: 'Something went wrong. Nothing was changed.' });
  }

  return outcome;
}

/* ========================================================================== */
/* Notification helpers — AFTER the commit                                     */
/* ========================================================================== */

/**
 * Tell the assigning dispatcher that a dispatch was answered. **Never throws.**
 *
 * Called by the ROUTE, after `respondToDispatch` has committed, which is the only
 * ordering that satisfies both halves of FR-107: the notification cannot roll back
 * the dispatch, and the dispatch cannot fail because of the notification.
 *
 * The recipients come from `recipientsForEvent` rather than from the transaction,
 * because they are a function of WHO ANSWERED and WHO WAS TOLD — facts the route
 * already holds and which did not change atomically. A notification is not a
 * security boundary: if this list were wrong the consequence is a missed or extra
 * in-app row, not an unauthorised action, and every action it describes was
 * already authorised and written by the transaction.
 *
 * `reason` is the responder's own decline wording — the same text
 * `respondToDispatch` already recorded on the dispatch document, carried into the
 * dispatcher's copy rather than re-derived, so there is one version of why.
 */
export async function notifyDispatchAnswered(
  params: {
    readonly event: 'accepted' | 'declined';
    readonly incidentId: string;
    readonly incidentRef: string;
    readonly responderName: string;
    readonly dispatcherUid: string | null;
    readonly reporterUid: string | null;
    readonly reason: string | null;
    readonly requestId: string;
  },
): Promise<void> {
  const { uids, roles } = recipientsForEvent(
    params.event === 'accepted' ? 'dispatch_accepted' : 'dispatch_declined',
    {
      responderUid: null,
      responderName: null,
      dispatcherUid: params.dispatcherUid,
      dispatcherName: null,
      reporterUid: params.reporterUid,
    },
  );

  if (uids.length === 0) return;

  const spec =
    params.event === 'accepted'
      ? {
          // `docs/07 §10.2`: `dispatch_accepted` -> the assigning dispatcher, `info`.
          type: 'dispatch_accepted' as const,
          severity: 'info' as const,
          ...NOTIFICATION_COPY.dispatchAccepted(params.incidentRef, params.responderName),
        }
      : {
          // `docs/07 §10.2`: `dispatch_declined` -> the assigning dispatcher,
          // `warning`. The dispatcher's next action is to choose someone else, so
          // the copy ends with that instruction, not a reassurance.
          type: 'dispatch_declined' as const,
          severity: 'warning' as const,
          ...NOTIFICATION_COPY.dispatchDeclined(params.incidentRef, params.responderName, params.reason),
        };

  await deliverToRecipients({
    spec: {
      ...spec,
      incidentId: params.incidentId,
      incidentRef: params.incidentRef,
      link: null,
      actor: null,
    },
    recipients: uids.map((uid) => ({
      uid,
      // `recipientsForEvent` deduplicates by uid and keeps the FIRST role it saw,
      // so this cannot disagree with the matrix that built the list.
      role: roles.get(uid) ?? 'dispatcher',
    })),
    // In-app only. No external provider is configured in this build, and requesting
    // SMS here would only mint `unavailable` outcomes — rows describing a channel
    // this deployment cannot use.
    channels: ['in_app'],
    requestId: params.requestId,
  });
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

function readCount(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * `docs/07 §8`: "unaccepted assignment expires (default 120 s)".
 *
 * A `null` `expiresAt` is treated as NOT expired rather than as expired. An
 * assignment with no expiry is one written by an older build or by a seed script,
 * and refusing a responder's acceptance of it because a field is missing would
 * strand a dispatch that the system itself created.
 */
function isExpired(expiresAt: Timestamp | null | undefined, nowMs: number): boolean {
  if (expiresAt == null) return false;
  return nowMs > expiresAt.toMillis();
}

/**
 * `docs/07 §8`: "`responseSec` | `respondedAt - dispatchedAt`".
 *
 * A plain subtraction against the caller's clock rather than a server timestamp,
 * because the difference of two `FieldValue.serverTimestamp()` results is not a
 * value Firestore can compute — the increment form would compute a difference
 * against nothing. A few seconds of host-clock skew is immaterial next to a
 * two-minute window; recording `null` instead would lose the field entirely.
 */
function computeResponseSec(dispatchedAt: Timestamp | undefined, nowMs: number): number | null {
  if (dispatchedAt == null) return null;
  const seconds = Math.floor((nowMs - dispatchedAt.toMillis()) / 1000);
  // A negative value means the host clock moved backwards mid-request. Recording
  // it would put a negative response time in an ops report.
  return seconds < 0 ? null : seconds;
}

/** `docs/07 §6`'s `eventType` for a status change. */
function historyEventFor(to: IncidentStatus): HistoryEventType {
  if (to === 'verified') return 'verified';
  if (to === 'false_alarm') return 'false_alarm';
  if (to === 'assigned') return 'assigned';
  return 'status_change';
}

/**
 * The dispatcher's copy for each refusal reason.
 *
 * brief §40: "Do not silently fail." A generic "not allowed" leaves a responder
 * guessing whether they were refused for the wrong user or the wrong state, and
 * the distinction matters most to them — "this is not your incident" is a
 * different message from "this incident is already resolved".
 */
function refusalFor(reason: string): string {
  switch (reason) {
    case 'requires_live_assignee':
      return 'This incident is not assigned to you.';
    case 'not_the_reporter':
      return 'This is not your report.';
    case 'system_only':
      return 'Only the automatic triage step can make that change.';
    case 'terminal_status':
      return 'This incident is closed and cannot be changed.';
    case 'requires_active_dispatch':
      return 'This incident has no active assignment.';
    case 'not_in_transition_table':
    case 'no_permission':
    case 'same_status':
    default:
      return 'That status change is not allowed from here.';
  }
}

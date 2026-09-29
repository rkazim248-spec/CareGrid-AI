/**
 * ============================================================================
 * POST /api/dispatches/:dispatchId/accept
 * POST /api/dispatches/:dispatchId/reject
 * DELETE /api/dispatches/:dispatchId
 * ============================================================================
 *
 * `docs/07 §8`, `docs/08 §3.7`. Matrix rows `r29_assignResponder`,
 * `r30_unassignWithdraw`.
 *
 * Three verbs on one document, because a dispatch has exactly three things that
 * can happen to it by a person: be accepted, be declined, or be cancelled. A
 * separate collection per verb would make "the state of this assignment" a join
 * rather than a field, and `docs/07 §8`'s `status` is the state.
 *
 * ---------------------------------------------------------------------------
 * `accept` AND `reject` ARE THE SAME OPERATION WITH A DIFFERENT TARGET
 * ---------------------------------------------------------------------------
 * `respondToDispatch` takes `decision: 'accepted' | 'withdrawn'`, and these two
 * routes are thin wrappers that differ only in the decision and the capability
 * they require. That is not a shortcut — it is what makes the two paths share the
 * transaction that releases the responder's capacity, writes the history event and
 * writes the audit row. Two separate service functions would be two chances to
 * forget one of those.
 *
 * `docs/07 §8` has no `rejected` status, so a decline is `withdrawn` with a
 * `withdrawnReason`. brief §17 proposes `rejected`; the documented set of five
 * stands, and the reason field is what distinguishes a decline from a cancellation.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY DO WHAT
 * ---------------------------------------------------------------------------
 * | Route | Matrix row | Who |
 * | --- | --- | --- |
 * | accept | `r29_assignResponder` is NOT it — this is the responder's own action | the SUBJECT responder only, and `canTransitionDispatchStatus` refuses everyone else including a dispatcher |
 * | reject | `r30_unassignWithdraw` | the subject responder, or a dispatcher cancelling |
 * | DELETE | `r30_unassignWithdraw` | `dispatcher`/`admin`, reason required |
 *
 * The accept case is the one that looks like a missing check and is not: the
 * capability required is the broad one, and the SUBJECT check happens inside the
 * transaction against the dispatch document. A responder calling this with someone
 * else's `dispatchId` gets "This assignment is not yours", decided server-side from
 * a document they did not control.
 */

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { getAdminDb, adminConfigurationReason } from '@/lib/server/firebase-admin';
import { COLLECTIONS } from '@/config/collections';
import { notifyDispatchAnswered, respondToDispatch } from '@/services/dispatch';
import {
  acceptDispatchBodySchema,
  dispatchIdParamSchema,
  rejectDispatchBodySchema,
  respondResponseSchema,
  withdrawDispatchBodySchema,
} from '@/validators/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read just enough to write notification copy.
 *
 * A separate read AFTER the transaction, deliberately: the transaction is the
 * authority on state, and this read is only for the words a human will read. If it
 * fails, `notifyDispatchAnswered` is skipped and the dispatch is unaffected — which
 * is FR-107's whole point.
 */
async function readNotificationContext(
  dispatchId: string,
): Promise<{
  incidentId: string;
  incidentRef: string;
  responderName: string;
  dispatcherUid: string | null;
  reporterUid: string | null;
} | null> {
  if (adminConfigurationReason() !== null) return null;
  try {
    const db = getAdminDb();
    const [dispatchSnap, incidentSnap] = await Promise.all([
      db.collection(COLLECTIONS.dispatches).doc(dispatchId).get(),
      db
        .collection(COLLECTIONS.dispatches)
        .doc(dispatchId)
        .get()
        .then(async (snap) => {
          const incidentId = snap.exists
            ? ((snap.data() as { incidentId?: string }).incidentId ?? '')
            : '';
          return incidentId === ''
            ? null
            : db.collection(COLLECTIONS.incidents).doc(incidentId).get();
        }),
    ]);

    if (!dispatchSnap.exists) return null;
    const dispatch = dispatchSnap.data() as {
      incidentId?: string;
      responderUid?: string;
      dispatchedBy?: string;
    };

    const responderName = dispatch.responderUid
      ? (((await db.collection(COLLECTIONS.responders).doc(dispatch.responderUid).get()).data() as
          | { displayName?: string }
          | undefined)?.displayName ?? 'The responder')
      : 'The responder';

    const incident = incidentSnap?.exists ? incidentSnap.data() : undefined;
    return {
      incidentId: dispatch.incidentId ?? '',
      incidentRef: (incident as { reference?: string } | undefined)?.reference ?? dispatch.incidentId ?? '',
      responderName,
      dispatcherUid: dispatch.dispatchedBy ?? null,
      reporterUid: (incident as { reporterUid?: string } | undefined)?.reporterUid ?? null,
    };
  } catch {
    // Never throws. A missing notification context costs a notification, not a
    // dispatch, and the dispatcher's own UI reads the dispatch document directly.
    return null;
  }
}

/** Accept. The subject responder only — enforced inside the transaction. */
export const POST = withRequest(
  {
    params: dispatchIdParamSchema,
    body: acceptDispatchBodySchema,
    auth: 'required',
    rateLimit: 'dispatch.respond',
  },
  async (ctx) => {
    const { params, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // A responder accepting their own assignment. `requireRole` rather than
    // `requireCapability`, because there is no capability row for "answer your own
    // assignment" — it is not a privilege over a resource, it IS the resource. The
    // SUBJECT check, which is the one that matters, happens in the transaction.
    if (user.role !== 'responder' && user.role !== 'admin') {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Only the responder this incident was assigned to can accept it.',
      });
    }

    const result = await respondToDispatch({
      dispatchId: params.dispatchId,
      actor: { uid: user.uid, role: user.role },
      decision: 'accepted',
      reason: null,
      context: {
        requestId: ctx.requestId,
        ipHash: ctx.ipHash,
        userAgent: ctx.request?.headers.get('user-agent') ?? null,
        nowMs: Date.now(),
      },
    });

    // AFTER the commit. Never throws.
    if (!result.noop) {
      const notification = await readNotificationContext(params.dispatchId);
      if (notification !== null) {
        await notifyDispatchAnswered({
          event: 'accepted',
          incidentId: notification.incidentId,
          incidentRef: notification.incidentRef,
          responderName: notification.responderName,
          dispatcherUid: notification.dispatcherUid,
          reporterUid: notification.reporterUid,
          requestId: ctx.requestId,
        });
      }
    }

    return { data: respondResponseSchema.parse(result) };
  },
);

/** Decline. The subject responder, or a dispatcher cancelling. brief §16. */
export const PUT = withRequest(
  {
    params: dispatchIdParamSchema,
    body: rejectDispatchBodySchema,
    auth: 'required',
    rateLimit: 'dispatch.respond',
  },
  async (ctx) => {
    const { params, body, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // `r30_unassignWithdraw` is `scoped` for a responder and `full` for a
    // dispatcher. The scoping to "your own" is the transaction's `isSubject`
    // check; this is the broad gate.
    requireCapability(user, 'r30_unassignWithdraw', { requestId: ctx.requestId });

    const result = await respondToDispatch({
      dispatchId: params.dispatchId,
      actor: { uid: user.uid, role: user.role },
      decision: 'withdrawn',
      // Optional, and the absence is recorded rather than invented. brief §16 allows
      // a reason "where appropriate"; forcing an enumerated one would make a
      // responder decline with a reason that is not true.
      reason: body.reason ?? null,
      context: {
        requestId: ctx.requestId,
        ipHash: ctx.ipHash,
        userAgent: ctx.request?.headers.get('user-agent') ?? null,
        nowMs: Date.now(),
      },
    });

    if (!result.noop) {
      const notification = await readNotificationContext(params.dispatchId);
      if (notification !== null) {
        await notifyDispatchAnswered({
          event: 'declined',
          incidentId: notification.incidentId,
          incidentRef: notification.incidentRef,
          responderName: notification.responderName,
          dispatcherUid: notification.dispatcherUid,
          reporterUid: notification.reporterUid,
          requestId: ctx.requestId,
        });
      }
    }

    return { data: respondResponseSchema.parse(result) };
  },
);

/**
 * Cancel. brief §33: "Authorized users may cancel an assignment when appropriate.
 * Require confirmation. … Preserve the audit trail."
 *
 * `DELETE` with a REQUIRED reason, which is how "require confirmation" is
 * implemented in a way that cannot be skipped by a client that forgets: the
 * schema refuses the request without it, so the confirmation dialog's contents are
 * a precondition of the API rather than a convention the UI follows.
 *
 * The dispatch document is NOT deleted. It is closed as `withdrawn`, which is what
 * "preserve the audit trail" means here — and it is the same code path as a
 * responder's decline, because a cancellation and a decline are the same state
 * change by different people.
 */
export const DELETE = withRequest(
  {
    params: dispatchIdParamSchema,
    body: withdrawDispatchBodySchema,
    auth: 'required',
    rateLimit: 'dispatch.respond',
  },
  async (ctx) => {
    const { params, body, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    requireCapability(user, 'r30_unassignWithdraw', { requestId: ctx.requestId });
    // `r30` is `scoped` for a responder; a cancellation is an operational decision
    // and brief §33's "authorized users" means a dispatcher or an admin.
    if (user.role !== 'dispatcher' && user.role !== 'admin') {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Only a dispatcher can cancel an assignment.',
      });
    }

    const result = await respondToDispatch({
      dispatchId: params.dispatchId,
      actor: { uid: user.uid, role: user.role },
      decision: 'withdrawn',
      // Mandatory here, unlike a responder's decline. The schema enforces it.
      reason: body.reason,
      context: {
        requestId: ctx.requestId,
        ipHash: ctx.ipHash,
        userAgent: ctx.request?.headers.get('user-agent') ?? null,
        nowMs: Date.now(),
      },
    });

    if (!result.noop) {
      const notification = await readNotificationContext(params.dispatchId);
      if (notification !== null) {
        await notifyDispatchAnswered({
          event: 'declined',
          incidentId: notification.incidentId,
          incidentRef: notification.incidentRef,
          responderName: notification.responderName,
          dispatcherUid: notification.dispatcherUid,
          reporterUid: notification.reporterUid,
          requestId: ctx.requestId,
        });
      }
    }

    return { data: respondResponseSchema.parse(result) };
  },
);

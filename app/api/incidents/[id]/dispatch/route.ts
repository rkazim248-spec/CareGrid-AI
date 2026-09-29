/**
 * ============================================================================
 * POST /api/incidents/:id/dispatch — assign a responder
 * ============================================================================
 *
 * `docs/08 §3.6`, FR-053. `lib/auth/permissions.ts` matrix row `r29_assignResponder`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ROUTE DOES *NOT* DO
 * ---------------------------------------------------------------------------
 * **It does not decide whether the assignment is allowed.** It verifies the
 * capability, then hands an id and an optional note to
 * `services/dispatch/assign.ts`, which re-reads the incident, the responder and any
 * live dispatch inside a transaction and asks
 * `lib/dispatch/transitions.ts` — the same table the tests pin.
 *
 * That indirection is the point. A route that checked `if (responder.status ===
 * 'available')` and then wrote would be a check-then-write with a network hop in
 * the middle, which is precisely the race brief §15 exists to close. The only
 * decision made here is about the CALLER, and that decision is about a verified ID
 * token rather than about the world.
 *
 * brief §3: the assignment below is made because a human pressed a button. Nothing
 * in this route, and nothing it calls, can reach this endpoint without one.
 */

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import {
  NOTIFICATION_COPY,
  assignResponder,
  notifyInApp,
  recipientsForEvent,
} from '@/services/dispatch';
import {
  assignResponderBodySchema,
  assignResponseSchema,
  incidentIdParamSchema,
} from '@/validators/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRequest(
  {
    params: incidentIdParamSchema,
    body: assignResponderBodySchema,
    auth: 'required',
    rateLimit: 'dispatch.assign',
  },
  async (ctx) => {
    const { body, params, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // Matrix row 29. `dispatcher` and `admin` only — a citizen and a responder are
    // both `denied` here, and requiring it before the body is used means a
    // responder calling this gets a 403 without their chosen uid being logged.
    requireCapability(user, 'r29_assignResponder', { requestId: ctx.requestId });

    // `params.id`, not a body field. `docs/08 §3.6` puts the incident in the path,
    // and accepting it in the body as well would be a request that states its target
    // in two places and can disagree with itself.
    const result = await assignResponder({
      incidentId: params.id,
      responderUid: body.responderUid,
      // From the verified token. NEVER from the body.
      actor: { uid: user.uid, role: user.role },
      note: body.note ?? null,
      // A dispatcher choosing from the panel. `self_claimed` belongs to
      // `POST /api/dispatches/:id/claim`, and `auto_suggest` is unreachable here on
      // purpose — brief §3.
      mode: 'manual',
      requestId: ctx.requestId,
      ipHash: ctx.ipHash,
      userAgent: ctx.request?.headers.get('user-agent') ?? null,
      nowMs: Date.now(),
    });

    /* ---------------------------------------------------------------------- *
     * The notification is AFTER the commit, and best-effort.
     * ---------------------------------------------------------------------- *
     * FR-107: a notification failure must never fail the request that caused it. A
     * dispatch that succeeded but whose notification failed is still a dispatch,
     * and a responder is still on their way — answering 500 would tell a
     * dispatcher the assignment failed and invite a second one.
     *
     * `notifyInApp` never throws, so this is fire-and-forget by construction rather
     * than by a `.catch()` that could be forgotten.
     */
    if (!result.noop) {
      const recipients = recipientsForEvent('assigned', {
        responderUid: result.responderUid,
        responderName: null,
        dispatcherUid: user.uid,
        dispatcherName: user.displayName,
        reporterUid: null,
      });
      if (recipients.uids.length > 0) {
        await notifyInApp(
          {
            // `docs/07 §10.2`: `incident_assigned` -> the assigned responder,
            // severity `critical`.
            type: 'incident_assigned',
            severity: 'critical',
            ...NOTIFICATION_COPY.assignmentReceived(result.incidentReference),
            incidentId: result.incidentId,
            // The human reference, not the Firestore id: a responder reading this
            // on a phone quotes the code back to a dispatcher.
            incidentRef: result.incidentReference,
            link: null,
            actor: { uid: user.uid, displayName: user.displayName },
          },
          recipients.uids.map((uid) => ({
            uid,
            role: 'responder',
            inAppEnabled: true,
          })),
          ctx.requestId,
        );
      }
    }

    return { data: assignResponseSchema.parse(result) };
  },
);

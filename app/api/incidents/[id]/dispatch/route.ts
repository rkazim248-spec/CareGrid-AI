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
import { adminConfigurationReason, getAdminDb } from '@/lib/server/firebase-admin';
import { COLLECTIONS } from '@/config/collections';
import { categoryLabel, resourceName, URGENCY_META } from '@/config';
import { formatClock, formatDistance } from '@/lib/format';
import {
  NOTIFICATION_COPY,
  assignResponder,
  recipientsForEvent,
} from '@/services/dispatch';
import { deliverToRecipients } from '@/services/notifications';
import type { IncidentCategory, Urgency } from '@/types';
import {
  assignResponderBodySchema,
  assignResponseSchema,
  incidentIdParamSchema,
} from '@/validators/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ========================================================================== */
/* Responder-alert copy inputs — brief §3                                      */
/* ========================================================================== */

/**
 * Read the incident fields the §3 alert quotes: category, urgency, location,
 * required resources, time reported.
 *
 * AFTER the commit and best-effort. A failed read downgrades the alert to the
 * short copy rather than failing an assignment that already succeeded (FR-107) —
 * and a responder told "you were assigned" who opens the app is better served
 * than one told nothing at all.
 */
async function readIncidentForAlert(
  incidentId: string,
): Promise<{
  category: IncidentCategory;
  urgency: Urgency;
  placeName: string | null;
  resources: readonly { resourceId: string; quantity: number }[];
  createdAt: string;
} | null> {
  if (adminConfigurationReason() !== null) return null;
  try {
    const snap = await getAdminDb().collection(COLLECTIONS.incidents).doc(incidentId).get();
    if (!snap.exists) return null;
    const data = snap.data() as
      | Partial<{
          category: IncidentCategory;
          urgency: Urgency;
          location: { placeName: string | null } | null;
          requiredResources: { resourceId: string; quantity: number }[];
          createdAt: string;
        }>
      | undefined;
    if (
      typeof data?.category !== 'string' ||
      typeof data.urgency !== 'string' ||
      typeof data.createdAt !== 'string'
    ) {
      return null;
    }
    return {
      category: data.category,
      urgency: data.urgency,
      placeName: data.location?.placeName ?? null,
      resources: data.requiredResources ?? [],
      createdAt: data.createdAt,
    };
  } catch {
    return null;
  }
}

/** `First aid kit ×2, Fire extinguisher ×1` — or the honest `None recorded`. */
function resourcesSummary(
  resources: readonly { resourceId: string; quantity: number }[],
): string {
  if (resources.length === 0) return 'None recorded';
  return resources.map((r) => `${resourceName(r.resourceId)} ×${r.quantity}`).join(', ');
}

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
     * The responder alert is AFTER the commit, and best-effort. FR-107.
     * ---------------------------------------------------------------------- *
     * brief §3: the alert carries the emergency category, the priority, the
     * location, the distance, the required resources and the time reported — the
     * six facts a responder needs in order to decide, in the notification itself
     * rather than behind a tap. A notification failure never fails the request
     * that caused it: a dispatch whose notification failed is still a dispatch,
     * and answering 500 would tell a dispatcher the assignment failed and invite
     * a second one.
     *
     * `deliverToRecipients` never throws, so this is fire-and-forget by
     * construction rather than by a `.catch()` that could be forgotten.
     */
    if (!result.noop) {
      const incident = await readIncidentForAlert(result.incidentId);
      const recipients = recipientsForEvent('dispatched', {
        responderUid: result.responderUid,
        responderName: null,
        dispatcherUid: user.uid,
        dispatcherName: user.displayName,
        reporterUid: null,
      });
      if (recipients.uids.length > 0) {
        await deliverToRecipients({
          spec: {
            // `docs/07 §10.2`: `dispatch_received` -> the assigned responder,
            // severity `critical`. The type is the same on both copy paths so the
            // client's filter for "assignment" rows stays one value.
            type: 'dispatch_received',
            severity: 'critical',
            ...(incident === null
              ? NOTIFICATION_COPY.assignmentReceived(result.incidentReference)
              : NOTIFICATION_COPY.dispatchReceived(
                  result.incidentReference,
                  categoryLabel(incident.category),
                  URGENCY_META[incident.urgency].label,
                  // The place name a human can act on — never raw coordinates in a
                  // push-style alert someone might read on a locked phone in public.
                  incident.placeName ?? 'Location not recorded',
                  formatDistance(result.distanceM),
                  resourcesSummary(incident.resources),
                  formatClock(incident.createdAt),
                )),
            incidentId: result.incidentId,
            // The human reference, not the Firestore id: a responder reading this
            // on a phone quotes the code back to a dispatcher.
            incidentRef: result.incidentReference,
            link: null,
            actor: { uid: user.uid, displayName: user.displayName },
          },
          recipients: recipients.uids.map((uid) => ({ uid, role: 'responder' as const })),
          channels: ['in_app'],
          requestId: ctx.requestId,
        });
      }
    }

    return { data: assignResponseSchema.parse(result) };
  },
);

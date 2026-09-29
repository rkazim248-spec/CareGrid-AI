/**
 * ============================================================================
 * PATCH /api/incidents/:id/status — lifecycle transition
 * ============================================================================
 *
 * `docs/08 §3.8`, FR-050 / FR-051 / FR-052 / FR-054. Matrix rows
 * `r04_updateOwnIncident` and the operations set.
 *
 * ---------------------------------------------------------------------------
 * ONE ROUTE, BECAUSE ONE TABLE
 * ---------------------------------------------------------------------------
 * There is no `POST /api/incidents/:id/en-route` and no
 * `POST /api/incidents/:id/resolve`. A separate endpoint per target would mean a
 * separate authorisation decision per endpoint, and the table in
 * `lib/dispatch/transitions.ts` would become advice rather than the mechanism —
 * which is how "reported → resolved" becomes reachable during a refactor.
 *
 * brief §19 asks for exactly this: "Define a centralized transition validator."
 * Centralised means one route, one table, one place a permission can be wrong.
 *
 * ---------------------------------------------------------------------------
 * THE CAPABILITY IS DELIBERATELY COARSE HERE
 * ---------------------------------------------------------------------------
 * `requireCapability` answers "may this ROLE act on incidents at all". It does NOT
 * answer "may this role make THIS transition" — `docs/07 §4.3`'s matrix is
 * per-transition and per-actor, and the 61-row matrix has no row for "en route".
 * So this route requires the broad capability and then hands the target to the
 * transaction, which asks the per-transition table with server-derived facts.
 *
 * Both checks are needed. The capability check is what keeps a citizen from
 * reaching the transaction at all; the table is what stops a responder reaching an
 * incident that is not theirs. Neither substitutes for the other.
 */

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { transitionIncident } from '@/services/dispatch';
import { incidentStatusBodySchema, incidentStatusResponseSchema, incidentIdParamSchema } from '@/validators/dispatch';
import type { ResolutionRecord } from '@/config/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withRequest(
  {
    params: incidentIdParamSchema,
    body: incidentStatusBodySchema,
    auth: 'required',
    rateLimit: 'dispatch.transition',
  },
  async (ctx) => {
    const { body, params, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    /* --- who may act on an incident at all ------------------------------ */
    // A citizen is NOT refused here. brief §20: a citizen "can view own incident
    // status" and `docs/07 §4.3` grants the `reporter` two transitions — `cancelled`
    // before verification, and nothing else. So the capability is required and the
    // TABLE decides, and a citizen who is not the reporter gets
    // "This is not your report" rather than a bare 403, which is the difference
    // between a sentence they can act on and one they have to guess at.
    //
    // The alternative — refusing every citizen here — would make the reporter's
    // cancellation unreachable, because the only path to it is this route.
    requireCapability(user, 'r01_createIncident', { requestId: ctx.requestId });

    const resolution: ResolutionRecord | null =
      body.resolution === undefined
        ? null
        : {
            resolutionCode: body.resolutionCode ?? 'resolved',
            note: body.note ?? null,
            resourcesUsed: body.resolution.resourcesUsed ?? [],
            // `null` is the honest default and `0` is not an option. brief §34:
            // "Allow unknown/empty values where appropriate" — and a body count of
            // zero asserted as fact is a fabrication about a rescue.
            peopleAssisted: body.resolution.peopleAssisted ?? null,
            followUpRequired: body.resolution.followUpRequired ?? null,
          };

    const result = await transitionIncident({
      incidentId: params.id,
      to: body.to,
      // From the verified token. NEVER from the body — and the body schema has no
      // `role`, `uid` or `isLiveAssignee` field for a client to put one in.
      actor: { uid: user.uid, role: user.role },
      reason: body.reason ?? null,
      note: body.note ?? null,
      resolutionCode: body.resolutionCode ?? null,
      resolution,
      context: {
        requestId: ctx.requestId,
        ipHash: ctx.ipHash,
        userAgent: ctx.request?.headers.get('user-agent') ?? null,
        nowMs: Date.now(),
      },
    });

    return { data: incidentStatusResponseSchema.parse(result) };
  },
);

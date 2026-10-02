/**
 * ============================================================================
 * GET /api/incidents/:id — one incident
 * ============================================================================
 *
 * `docs/08 §3.2`, FR-011. The detail read behind a citizen's `/track` screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO PERMISSION CHECK IN THIS ROUTE
 * ---------------------------------------------------------------------------
 * The same reason as the list route: every role may read something, so a guard
 * here could only be a check everyone passes. The decision is `maySeeIncident`
 * inside `services/incidents/read.ts`, and it happens BEFORE the document is
 * returned — which is the part that matters, because a check that runs after
 * serialization has already read the fields it was supposed to protect.
 *
 * ---------------------------------------------------------------------------
 * A RECORD YOU MAY NOT SEE IS A 404, NOT A 403
 * ---------------------------------------------------------------------------
 * Enforced in the service. The reasoning is short enough to repeat here because it
 * is the kind of decision that gets "corrected" by someone who has not thought it
 * through: a 403 confirms the incident EXISTS. Hand an attacker a list of candidate
 * ids and a 403 tells them which are real, which is most of what they were probing
 * for. A 404 is indistinguishable from an id that was never issued.
 *
 * The cost is that a genuine owner typo reads as "not found" rather than
 * "forbidden". That is a support ticket. The alternative is a privacy incident.
 */

import { withRequest } from '@/lib/server/route';
import { AppError } from '@/lib/server/errors';
import { getIncident } from '@/services/incidents';
import { incidentDetailResponseSchema } from '@/validators';
import { incidentIdParamSchema } from '@/validators/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRequest(
  {
    params: incidentIdParamSchema,
    auth: 'required',
    /**
     * Higher than the list rate limit per request, and lower in absolute terms than
     * it sounds: 60/min is far above a person reading a report they just filed,
     * and this endpoint returns one document rather than a page, so a single call
     * cannot be made expensive.
     */
    rateLimit: 'incidents.read',
  },
  async (ctx) => {
    const { params, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    const result = await getIncident(user, params.id);
    return { data: incidentDetailResponseSchema.parse(result) };
  },
);
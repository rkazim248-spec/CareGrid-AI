/**
 * POST /api/auth/event
 *
 * Records a login, logout, or login failure for the audit trail (FR-135,
 * docs/08 §2.4).
 *
 * ---------------------------------------------------------------------------
 * THIS ROUTE NEVER REVEALS WHETHER AN ACCOUNT EXISTS
 * ---------------------------------------------------------------------------
 * It is the endpoint a "forgot password" form would call to check an address,
 * which is exactly why it must not be one. There is no lookup, no count, and no
 * conditional response: a body describing a sign-in attempt is recorded and the
 * answer is `200 { ok: true }` in every case. A caller cannot distinguish an
 * existing account from a non-existent one by any means through this route.
 * docs/24 TB4.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS EXEMPT FROM THE ACCOUNT STATUS GATE
 * ---------------------------------------------------------------------------
 * A suspended user must still be able to REPORT A LOGOUT. If this route required
 * an active account, the sign-out path would fail for precisely the people who
 * most need it to work, and the client would be left holding a session it cannot
 * clear. So authentication is required and the status gate is waived
 * (docs/10 §3.5).
 *
 * ---------------------------------------------------------------------------
 * WHAT A CLIENT CAN WRITE HERE
 * ---------------------------------------------------------------------------
 * `type`, `provider`, and a `reason` from a CLOSED set. Not free text. A route
 * that accepted an arbitrary string would be a general-purpose log-injection
 * channel into the audit collection.
 */

import { withRequest } from '@/lib/server/route';
import { authEventBodySchema } from '@/validators/me';
import { recordAuthEvent } from '@/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRequest(
  {
    body: authEventBodySchema,
    auth: 'required',
    // See the file header: a suspended user must be able to report a logout.
    allowInactiveAccount: true,
    // docs/10 §17.2: 30 per hour per uid-or-IP.
    rateLimit: 'auth.event',
  },
  async (ctx) => {
    const { body, user, log } = ctx;

    // A `login_failed` is the only shape worth a warn: it is the one an operator
    // scanning a log for brute force is looking for, and it is the only one that
    // arrives without a successful authentication.
    if (body.type === 'login_failed') {
      log.warn({ actorUid: user?.uid ?? 'anonymous', path: '/api/auth/event' });
    }

    const result = await recordAuthEvent(body, { user, requestId: ctx.requestId });

    return { data: result };
  },
);

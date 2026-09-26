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
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS EXEMPT FROM THE ACCOUNT STATUS GATE
 * ---------------------------------------------------------------------------
 * A suspended user must still be able to REPORT A LOGOUT. If this route
 * required an active account, the sign-out path would fail for precisely the
 * people who most need it to work, and the client would be left holding a
 * session it cannot clear. So authentication is required and the status gate is
 * waived (docs/10 §3.5).
 *
 * ---------------------------------------------------------------------------
 * WHAT A CLIENT CAN WRITE HERE
 * ---------------------------------------------------------------------------
 * `type`, `provider`, and a `reason` from a CLOSED set. Not free text. A route
 * that accepted an arbitrary string would be a general-purpose log-injection
 * channel into the audit collection.
 */

import { withRequest } from '@/lib/server/route';
import { auditLog } from '@/lib/server/audit';
import { authEventBodySchema } from '@/validators/me';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRequest(
  {
    body: authEventBodySchema,
    auth: 'required',
    // See the file header: a suspended user must be able to report a logout.
    allowInactiveAccount: true,
  },
  async (ctx) => {
    const { body, user, requestId, log } = ctx;

    // `login` and `login_failed` are already implied by the token's presence or
    // absence. The client-reported type is used as-is: it is a telemetry signal
    // about what the person ATTEMPTED, which the server cannot always see. A
    // client claiming `login` when it is not logged in is harmless — the record
    // says "a token was presented", and the actor uid says who.
    if (body.type === 'login_failed') {
      log.warn({ actorUid: user?.uid ?? 'anonymous', path: '/api/auth/event' });
    }

    await auditLog({
      requestId,
      actorUid: user?.uid ?? 'anonymous',
      actorRole: user?.role ?? 'anonymous',
      action: body.type === 'login_failed' ? 'auth.login_failed' : 'auth.login',
      entityType: 'auth',
      entityId: user?.uid ?? 'unknown',
      summary:
        body.type === 'login'
          ? `Signed in with ${body.provider}`
          : body.type === 'logout'
            ? 'Signed out'
            : `Failed sign-in attempt (${body.provider})`,
      reason: body.reason ?? null,
      // Presence is recorded; the hash itself is not computed here (docs/10
      // §17.4) so this route has no access to the request IP at all.
      hasIp: false,
    });

    return { data: { ok: true as const } };
  },
);

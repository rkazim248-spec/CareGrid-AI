/**
 * POST /api/me/bootstrap
 *
 * Create the `users/{uid}` and `profiles/{uid}` documents for a freshly
 * authenticated caller (docs/10 §3.2, docs/07 §3).
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS A THIN WRAPPER, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * It declares the route's contract — the schema, the auth mode, the rate limit —
 * and delegates every decision to `services/auth/account.ts`. The Firestore
 * batch, the role constant, and the idempotency rule all live in the service.
 *
 * Before Phase 3 this handler held all of that inline. Nothing was functionally
 * wrong; the problem was that the same logic was about to be needed by a second
 * route, and a copy is how two implementations of the same rule drift (docs/06
 * §5.1, docs/32 §3.14).
 *
 * ---------------------------------------------------------------------------
 * THE ROLE IS WRITTEN BY THE SERVER, NOT SUPPLIED
 * ---------------------------------------------------------------------------
 * The body has no `role` field and the schema is `.strict()`; the service writes
 * `citizen` as a constant; `assertNoRoleInBody()` catches a future widening of
 * the schema; and `firestore.rules` sets `users: allow write: if false`, so even
 * a bug here cannot be driven from a browser. Four independent blocks. Removing
 * any one leaves the other three standing.
 */

import { withRequest } from '@/lib/server/route';
import { assertNoRoleInBody } from '@/lib/server/auth-guard';
import { AppError } from '@/lib/server/errors';
import { meBootstrapBodySchema, userPublicSchema } from '@/validators/me';
import { bootstrapUser } from '@/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRequest(
  {
    body: meBootstrapBodySchema,
    // Authentication IS required. Only the `status !== 'active'` gate is waived,
    // which docs/22 §1 lists as one of the two exemptions — a pending or
    // suspended caller must be able to discover that they exist.
    auth: 'required',
    allowInactiveAccount: true,
    // docs/10 §17.2: 10 per hour per uid.
    rateLimit: 'me.bootstrap',
  },
  async (ctx) => {
    const { body, user, log } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // Belt and braces. The strict schema already rejects an injected `role` with
    // a 400; this catches the refactor that widens it.
    assertNoRoleInBody(body);

    const result = await bootstrapUser(body, { user, requestId: ctx.requestId });

    log.info({ actorUid: user.uid, isNew: result.isNew, path: '/api/me/bootstrap' });

    return {
      // 201 on a create, 200 on the idempotent replay. A client that cannot tell
      // the two apart cannot implement "we already had your account" copy, and
      // one that assumes 201 always would show a success screen for a user whose
      // account was merely confirmed.
      status: result.isNew ? 201 : 200,
      data: {
        user: userPublicSchema.parse(result.user),
        isNew: result.isNew,
      },
    };
  },
);

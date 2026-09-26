/**
 * GET /api/auth/me
 *
 * An ALIAS of `GET /api/me`. The two return byte-identical `data`, because they
 * call the same service function.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ALIAS EXISTS
 * ---------------------------------------------------------------------------
 * `/api/me` is the documented path (docs/08 §2.1) and it is what Phase 2 built.
 * It stays canonical, and the client keeps calling it. This alias exists because
 * `/api/auth/me` is the path a reader expects from the shape of the rest of the
 * API — `/api/auth/event` is right next to it — and a second route that had to
 * re-implement the handler would be a second implementation of a security-
 * relevant contract.
 *
 * So rather than copy the handler, this file delegates to `services/auth` exactly
 * as `app/api/me/route.ts` does. That is the whole reason the service layer
 * exists, and this route is the proof: adding a path to the API is now a
 * fifteen-line file rather than a hundred and twenty.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DOCUMENTED RATHER THAN INVENTED
 * ---------------------------------------------------------------------------
 * docs/32 MUST NOT 2 says an endpoint not in docs/08 §3 is a decision that
 * requires an amendment in the same change. `docs/08` §14.1 of this build records
 * the alias, its purpose, and the fact that it is a thin delegation. A
 * documented alias is a contract; an undocumented one is a mystery route that
 * somebody eventually re-implements.
 *
 * ---------------------------------------------------------------------------
 * THE UNAUTHENTICATED ANSWER
 * ---------------------------------------------------------------------------
 * `401 AUTH_REQUIRED`, from `requireUser` step 1, before any Firestore read. Not
 * `403`, and not a redirect: this is an API and the caller is a program.
 */

import { withRequest } from '@/lib/server/route';
import { AppError } from '@/lib/server/errors';
import { meResponseSchema } from '@/validators/me';
import { getMe } from '@/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRequest(
  {
    auth: 'required',
    // Same exemption as `GET /api/me`, and for the same reason: a suspended
    // caller must be able to learn WHY they cannot proceed (docs/22 §1).
    allowInactiveAccount: true,
    // 120/min. Not `none` as on `GET /api/me`: this path is the one a client
    // would poll, and it is a single-document read, so a modest limit costs
    // nothing and stops a script using it as a token validator.
    rateLimit: 'auth.me',
  },
  async (ctx) => {
    const { user, log } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    const me = await getMe({ user });

    log.debug({ actorUid: user.uid, actorRole: me.user.role });

    return { data: meResponseSchema.parse(me) };
  },
);

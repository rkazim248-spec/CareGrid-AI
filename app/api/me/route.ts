/**
 * GET /api/me  ·  PATCH /api/me
 *
 * The one endpoint the whole application is built on. Every screen that shows a
 * name, a role, or a permission reads it (docs/08 §2.1-§2.3).
 *
 * `GET /api/auth/me` is an ALIAS of `GET /api/me` — see that file for why the
 * alias exists and why it is documented rather than invented.
 *
 * ---------------------------------------------------------------------------
 * WHY `permissions[]` IS COMPUTED ON THE SERVER AND SENT TO THE CLIENT
 * ---------------------------------------------------------------------------
 * Because the alternative — the client computing its own permissions from the
 * role it was told — is the vulnerability docs/22 §2 exists to prevent. If the
 * client derived them, anyone who could influence the role could influence the
 * UI, and the UI is not a boundary anyway.
 *
 * So the server walks the 61-row matrix (docs/22 §3) and returns what THIS
 * caller may do. The client renders from that list. The API re-checks every
 * action regardless, because a rendered button is an affordance, not a grant.
 *
 * ---------------------------------------------------------------------------
 * WHY `GET` IS EXEMPT FROM THE ACCOUNT GATE, AND `PATCH` IS NOT
 * ---------------------------------------------------------------------------
 * A suspended or not-yet-bootstrapped caller must be able to find out WHY they
 * cannot proceed. Every other route answers `403 ACCOUNT_UNAVAILABLE`; if this
 * one did too, the UI would have nothing to show but an error, and a suspended
 * person would believe the product was broken rather than that their account is
 * paused. So `GET` waives the status gate and returns the real status, and the
 * shell renders an `ACCOUNT_UNAVAILABLE` state from it (docs/22 §1).
 *
 * `PATCH` does NOT waive it. A suspended account must not be able to edit its
 * profile, and waiving the gate there would make suspension advisory, which is
 * the opposite of its purpose.
 */

import { withRequest } from '@/lib/server/route';
import { AppError } from '@/lib/server/errors';
import { mePatchBodySchema, meResponseSchema, userPublicSchema } from '@/validators/me';
import { getMe, updateMe } from '@/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ========================================================================== */
/* GET                                                                        */
/* ========================================================================== */

export const GET = withRequest(
  {
    auth: 'required',
    // The one exemption, for the reason in the file header.
    allowInactiveAccount: true,
    // NO rate limit, deliberately. This route runs on every authenticated page
    // load and on every session refresh, and it is a single-document read the
    // caller has already proved they may make. A limit here breaks the product
    // for someone who navigates. `RATE_LIMIT_RULES['me.read']` records the
    // decision so it is a decision rather than an omission.
  },
  async (ctx) => {
    const { user, log } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    const me = await getMe({ user });

    log.debug({ actorUid: user.uid, actorRole: me.user.role });

    // Parsed on the way out. The response is a CONTRACT (docs/08 §1.4), and a
    // field that drifts out of `userPublicSchema` should fail here, loudly, in
    // development — not render `undefined` on somebody's profile page.
    return { data: meResponseSchema.parse(me) };
  },
);

/* ========================================================================== */
/* PATCH                                                                      */
/* ========================================================================== */

export const PATCH = withRequest(
  {
    body: mePatchBodySchema,
    auth: 'required',
    // docs/10 §17.2: 30 per hour per uid.
    rateLimit: 'me.update',
  },
  async (ctx) => {
    const { body, user, log } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    /* --- the channels we cannot honour ---------------------------------- */
    // FR-105 / FR-106: no SMS or WhatsApp provider exists. A profile that
    // recorded `sms: true` would be a preference the system silently drops on
    // the floor every time an alert is sent, which is worse than not offering
    // the switch. Refuse the request with a reason, and let the UI render those
    // switches disabled with the same sentence (docs/04 §10.4, docs/30.3 §A6.1).
    if (body.notifPrefs?.sms === true) {
      throw new AppError({
        code: 'NOTIFICATION_DISABLED',
        message: 'SMS notifications are not available: no SMS provider is configured.',
        details: [{ field: 'notifPrefs.sms', issue: 'SMS is not enabled in this deployment.' }],
      });
    }
    if (body.notifPrefs?.whatsapp === true) {
      throw new AppError({
        code: 'NOTIFICATION_DISABLED',
        message:
          'WhatsApp notifications are not available: no WhatsApp provider is configured.',
        details: [
          { field: 'notifPrefs.whatsapp', issue: 'WhatsApp is not enabled in this deployment.' },
        ],
      });
    }

    const result = await updateMe(body, { user, requestId: ctx.requestId });

    log.info({ actorUid: user.uid, path: '/api/me' });

    return { data: { user: userPublicSchema.parse(result.user) } };
  },
);

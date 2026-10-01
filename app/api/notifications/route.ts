import { z } from 'zod';

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { markAllRead, markRead } from '@/services/notifications';

/**
 * ============================================================================
 * /api/notifications
 * ============================================================================
 *
 * `brief §2` — mark as read, and mark all as read.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO "CREATE A NOTIFICATION" ENDPOINT
 * ---------------------------------------------------------------------------
 * `brief §7`: "Never trust client-controlled recipient identity." A POST here would
 * be a server that writes a row into somebody else's bell on request. So the write
 * surface is exactly two operations, both scoped by a `where('recipientId','==',uid)`
 * clause derived from the verified token — never from the body.
 *
 * That is also why the notification content is absent here: `services/dispatch/notify.ts`
 * (Phase 7) and `services/notifications/dispatch.ts` (Phase 13) are the only writers,
 * and both resolve recipients server-side.
 */

/** Marking a specific notification. The id is the caller's own; ownership is enforced below. */
const markOneBodySchema = z.object({
  notificationId: z.string().min(1).max(200),
});

/** `brief §6` — a per-user write ceiling, since this is the cheapest write in the app. */
const markAllBodySchema = z.object({}).strict();

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `brief §2` — mark one read, or mark every read. A PATCH because it is a partial update. */
export const PATCH = withRequest(
  {
    body: z.union([markOneBodySchema, markAllBodySchema]),
    auth: 'required',
    /**
     * `docs/10 §17.1`. Marking read is one document write, and it is the action a
     * client performs most often — the bell polls, and a user clicking through a list
     * marks several. 120/min is well above any human rate and low enough that the
     * endpoint cannot be used to burn the write budget.
     */
    rateLimit: 'notifications.read',
  },
  async (ctx) => {
    const { body, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // Read state is not a privileged capability — a responder and a citizen both mark
    // their own notifications. The authorisation that matters here is OWNERSHIP, and
    // it is enforced as a query predicate rather than a capability check.
    requireCapability(user, 'r01_createIncident', { requestId: ctx.requestId });

    // The uid comes from the VERIFIED TOKEN. Never from the body — the body schema has
    // no such field, so there is nothing for a caller to tamper with.
    const uid = user.uid;

    if ('notificationId' in body) {
      const { markedRead } = await markRead(body.notificationId, uid);
      // A request for somebody else's notification updates ZERO rows and reports zero.
      // It does not 403, because a 403 would confirm that the notification exists.
      return { data: { markedRead } };
    }

    const { markedRead } = await markAllRead(uid);
    return { data: { markedRead } };
  },
);

/**
 * `brief §6`: report how much notification traffic this user may generate.
 *
 * Read-only, and it returns the CHANNEL availability rather than any notification
 * content — so a client can render an accurate preferences screen without being able
 * to read a single other person's message.
 */
export const GET = withRequest(
  {
    auth: 'required',
    rateLimit: 'notifications.read',
  },
  async (ctx) => {
    const { user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    const { channelReport } = await import('@/services/notifications');
    return { data: { channels: channelReport() } };
  },
);
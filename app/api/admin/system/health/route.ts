/**
 * GET /api/admin/system/health
 *
 * The operator view: which integrations are configured, and whether the
 * deployment has a configuration fault that must be fixed. docs/08 route 52.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD, AND WHY IT IS A CAPABILITY AND NOT A ROLE
 * ---------------------------------------------------------------------------
 * `requireCapability(user, 'r52_listUsers')` — matrix row 52, which is `admin`
 * only. Not `requireRole(user, ['admin'])`:
 *
 *   - Row 52 is the documented permission for inspecting the user base, and this
 *     endpoint is the operator's window onto the system that list describes. A
 *     hand-written `['admin']` array is a SECOND list that can disagree with the
 *     matrix, and when it does, nothing checks.
 *   - A capability name is a COMPILE error if the row is ever removed. An array
 *     literal is not.
 *   - The two hard denials (rows 59 and 61) are enforced inside
 *     `requireCapability` before the matrix lookup, so a transcription bug in
 *     the matrix cannot open them.
 *
 * The consequence a citizen sees is `403 FORBIDDEN` and an `auditLogs` row. That
 * is the whole point of the endpoint existing as a security test: it is the one
 * route in this build a citizen can attempt and be refused, which makes it the
 * place the role boundary is demonstrated rather than asserted.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT RETURNS, AND WHAT IT MUST NEVER RETURN
 * ---------------------------------------------------------------------------
 * Variable NAMES, booleans, and sentences. NEVER a value. A health page that
 * echoes a secret is how a credential ends up in a screenshot pasted into an
 * issue, and a Firestore private key is 2 KB of base64 that reads as harmless
 * (docs/10 §16.3, control 7).
 */

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { systemHealth } from '@/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRequest(
  {
    auth: 'required',
    // docs/10 §17.2: 30 per minute per uid.
    rateLimit: 'admin.systemHealth',
  },
  async (ctx) => {
    const { user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // Gate 1: the role, expressed as a matrix row. Throws 403.
    requireCapability(user, 'r52_listUsers', { requestId: ctx.requestId });

    // Gate 2 would be `assertResourceAccess` for a single record. This endpoint
    // has no `:id` and no caller-specific record, so there is nothing to be
    // opaque about — the role gate is the whole decision, and it is the only
    // place in the API where that is true.
    return { data: systemHealth() };
  },
);

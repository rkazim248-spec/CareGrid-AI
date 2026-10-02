/**
 * ============================================================================
 * GET/POST /api/incidents
 * ============================================================================
 *
 * `docs/08 §3.1`, FR-001 / FR-002 / FR-003. Matrix row `r01_createIncident`,
 * which is `full` for every role including `citizen`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE CANNOT FAIL BECAUSE THE AI IS DOWN
 * ---------------------------------------------------------------------------
 * This is the only entry point to the whole system. A 500 here means a person
 * with a blocked road and a working phone cannot report it, so the two
 * fallible steps inside `createIncident` — AI triage and the duplicate check —
 * are written to return a degraded result rather than throw. See the module
 * header in `services/incidents/create.ts`.
 *
 * The route itself adds no failure modes: it validates, authorises, calls the
 * service, and returns. In particular it does NOT catch a service error and
 * retry without triage, because a second code path that can also persist an
 * incident is a second way for the document invariants to drift.
 *
 * ---------------------------------------------------------------------------
 * WHY `auth: 'required'` AND NOT A PERMISSION CHECK ON THE BODY
 * ---------------------------------------------------------------------------
 * The reporter identity comes from the verified token and is never read from the
 * body, which has no `reporterUid` field for a client to put one in. That is what
 * makes `GET /track` able to show a citizen their own reports: the uid stored on
 * the incident is the uid Firebase verified, not a claim.
 *
 * ---------------------------------------------------------------------------
 * GET IS A SEPARATE EXPORT, NOT A BRANCH INSIDE POST
 * ---------------------------------------------------------------------------
 * They share a path and share almost nothing else: POST writes one document for one
 * reporter, GET returns a scoped page for a whole role. They have different rate
 * limits (a report is expensive; a page is a read), different failure modes, and
 * different query validation. Folding them into one handler would mean one
 * `rateLimit` key applied to both, so a responder refreshing a queue would eat the
 * citizen's report budget — or vice versa.
 */

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { createIncident, listIncidents } from '@/services/incidents';
import {
  incidentCreateBodySchema,
  incidentCreateResponseSchema,
  incidentListQuerySchema,
  incidentListResponseSchema,
} from '@/validators';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRequest(
  {
    body: incidentCreateBodySchema,
    auth: 'required',
    rateLimit: 'incidents.create',
  },
  async (ctx) => {
    const { body, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // Matrix row 1. A suspended or pending account fails earlier, in
    // `withRequest`'s account-state gate.
    requireCapability(user, 'r01_createIncident', { requestId: ctx.requestId });

    const result = await createIncident({
      // From the verified token. NEVER from the body.
      reporterUid: user.uid,
      reporterRole: user.role,
      text: body.text,
      language: body.language,
      location: body.location,
      peopleAffected: body.peopleAffected,
      // STAGING paths the server minted at sign time. Ownership is re-checked
      // against `user.uid` and the bytes are re-sniffed during the attach, so a
      // client cannot attach someone else's upload or claim a file it never sent.
      media: body.media,
      context: {
        requestId: ctx.requestId,
        ipHash: ctx.ipHash,
        userAgent: ctx.request?.headers.get('user-agent') ?? null,
        nowMs: Date.now(),
        // FR-135: a brand-new account is an advisory signal to the triage engine,
        // derived from the token's auth time so a client cannot declare itself
        // "not new".
        authTimeSec: user.authTimeSec,
      },
    });

    return { data: incidentCreateResponseSchema.parse(result) };
  },
);

/**
 * One page of incidents, scoped to the caller.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO PERMISSION CHECK HERE, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * Every role may read SOMETHING — `r05` at minimum — so `requireCapability` on this
 * route could only ever be a check every role passes, which would be theatre. The
 * real authorisation is the scope predicate inside `listIncidents`, derived from the
 * matrix, and it runs as part of the QUERY rather than as a guard in front of it.
 *
 * That ordering matters: the filter is part of what Firestore reads, so a citizen's
 * query cannot even be expressed against another citizen's documents. A guard that
 * said "citizens may call this endpoint" would leave the scoping to a `where` clause
 * somebody could forget to add.
 */
export const GET = withRequest(
  {
    query: incidentListQuerySchema,
    auth: 'required',
    /**
     * A read, but a paged collection read. The citizen budget from
     * `incidents.create` is deliberately not reused: someone tracking a report
     * should never be throttled for it by the limit that stops someone spamming
     * reports, and vice versa.
     */
    rateLimit: 'incidents.read',
  },
  async (ctx) => {
    const { query, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    const result = await listIncidents(user, query);
    return { data: incidentListResponseSchema.parse(result) };
  },
);
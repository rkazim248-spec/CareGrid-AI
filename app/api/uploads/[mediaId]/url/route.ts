/**
 * GET /api/uploads/[mediaId]/url
 *
 * docs/15 §8.1 step 7. Mints a short-lived signed read URL for one evidence item.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE EXISTS AT ALL, RATHER THAN `getDownloadURL()`
 * ---------------------------------------------------------------------------
 * `storage.rules` makes `incidents/**` `if false` for EVERYONE — Phase 2 wrote
 * that deliberately, so a client cannot read evidence by guessing a path. But a
 * dispatcher has to SEE the photos.
 *
 * The rules cannot express the §13 access matrix, because that matrix depends on
 * a RESPONDER'S ASSIGNMENT to an incident, which lives in Firestore, and a
 * Storage rule cannot read Firestore. So the decision is made here, where Firestore
 * is reachable, and the rules' job reduces to what they are good at: making the
 * object unreachable except through a URL this route minted.
 *
 * That is the right division. The rules are the control; this route is the
 * authorisation that the rules cannot express.
 *
 * ---------------------------------------------------------------------------
 * THE CAPABILITY DECISION IS MADE BY THE CALLER, NOT REINTERPRETED HERE
 * ---------------------------------------------------------------------------
 * `resolveEvidenceRead` takes a `canReadEvidence` boolean, not a role. The
 * role -> capability mapping lives in exactly one place (`lib/auth/permissions.ts`,
 * the 61-row matrix) and a storage service that re-read a role string to answer
 * "may this person see this photo" is a second implementation of a security
 * decision. This route asks the matrix and passes the answer down.
 *
 * Two capabilities are consulted, in the documented order, because they answer
 * different questions:
 *
 *   1. `r05_readOwnIncidents` — is this the caller's OWN report?
 *   2. `r06_readAssignedIncidents` — has this responder been assigned to it?
 *
 * Dispatcher and admin hold `r08_readAllIncidents`, which is why the first two are
 * not the whole story; `canReadEvidence` is true if ANY of the three hold.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTE DOES NOT KNOW THE INCIDENT
 * ---------------------------------------------------------------------------
 * There is no `:incidentId` in the path, and that is deliberate rather than an
 * omission. The route resolves the `mediaId` to its incident THROUGH Firestore,
 * so it cannot be used to probe an incident the caller has no access to — the
 * lookup happens after authentication and returns the same refusal either way.
 * Adding the incident to the URL would create a second, earlier place where that
 * knowledge leaked.
 */

import { withRequest } from '@/lib/server/route';
import { hasCapability, type RoleHolder } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { z } from 'zod';

import { MEDIA_ID_RE } from '@/validators/upload';
import { resolveEvidenceRead } from '@/services/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The `mediaId` param, validated by `withRequest` before the handler runs.
 *
 * A malformed id is a `400`, which is the convention every param route in this
 * project follows ("A bad `:id` is a 400, not a 404"), and it is the right answer
 * here for a reason worth stating: **a malformed id is malformed whether or not
 * it exists**, so a 400 discloses nothing about the evidence.
 *
 * The temptation was to return `404` here instead, to match the refusal
 * `resolveEvidenceRead` produces for a well-formed id the caller may not have.
 * That would be a mistake, and a specific one: a route that 404s on garbage and a
 * route that 400s on garbage are distinguishable, so the deviation would tell an
 * enumerator which routes parse what. The uniform refusal belongs on the
 * *authorization* outcome, where existence and permission really are
 * indistinguishable — not on the syntax check, where they are not.
 */
const uploadMediaIdParamsSchema = z.object({
  mediaId: z.string().regex(MEDIA_ID_RE, 'A mediaId looks like med_XXXXXXXXXXXX.'),
});

export const GET = withRequest(
  {
    auth: 'required',
    params: uploadMediaIdParamsSchema,
    // A READ that a responder uses constantly. 120/min, from docs/15 §16.4.
    rateLimit: 'uploads.url',
  },
  async (ctx) => {
    const { user, params } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    const { mediaId } = params;

    // --- the access decision, from the 61-row matrix ---------------------
    const canReadEvidence = canReadEvidenceFor(user);

    const resolved = await resolveEvidenceRead({
      uid: user.uid,
      mediaId,
      canReadEvidence,
    });

    return {
      data: {
        mediaId,
        url: resolved.url,
        expiresAt: resolved.expiresAt,
        contentType: resolved.contentType,
        displayName: resolved.displayName,
      },
    };
  },
);

/**
 * The access decision, in one place.
 *
 * Declared as a named function rather than inlined at the call site because the
 * three capabilities are one policy — "own, assigned, or all" — and a policy that
 * lives in a `||` chain at one call site is a policy the next route will write
 * differently. Swapping the three for four is a change here and nowhere else.
 *
 * `hasCapability` rather than `requireCapability` is load-bearing, and the reason
 * is at the call site: this is a DECISION, not a guard. See the comment there.
 */
function canReadEvidenceFor(user: RoleHolder): boolean {
  return (
    hasCapability(user, 'r05_readOwnIncidents') ||
    hasCapability(user, 'r06_readAssignedIncidents') ||
    hasCapability(user, 'r08_readAllIncidents')
  );
}

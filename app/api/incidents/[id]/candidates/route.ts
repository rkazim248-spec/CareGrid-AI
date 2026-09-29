/**
 * ============================================================================
 * GET /api/incidents/:id/candidates — suitable responders
 * ============================================================================
 *
 * `docs/08 §3.6` (the read half), `lib/auth/permissions.ts` matrix row
 * `r28_seeCandidateResponders`.
 *
 * ---------------------------------------------------------------------------
 * THIS ROUTE RANKS. IT DOES NOT DISPATCH.
 * ---------------------------------------------------------------------------
 * brief §3: the system "may recommend, prioritize, filter, rank operationally
 * relevant responders" but must not "automatically dispatch, automatically contact
 * emergency services, automatically assign a responder".
 *
 * So the response is a ranked, explained list and nothing else. There is no
 * `POST`-shaped affordance here, no "assign the top result" shortcut, and the
 * `rank` field is an ordinal (1st, 2nd) rather than a score — so a UI cannot
 * render "97% best responder" even by accident, which brief §12 forbids.
 *
 * ---------------------------------------------------------------------------
 * PRECISE RESPONDER LOCATIONS ARE DISPATCHER-ONLY, AND THIS IS THAT CHECK
 * ---------------------------------------------------------------------------
 * brief §10: "Only authorized operational users should see precise responder
 * locations." `r28_seeCandidateResponders` is `denied` for `citizen` and
 * `responder`, and this route requires it — so a responder calling it is refused
 * before any read happens. `r43_readResponderLiveLocations` guards the map; this
 * guards the list. They are separate capabilities because they disclose the same
 * data in different shapes, and a role that may see "1.2 km away" should be
 * decided separately from one that may see a moving dot.
 *
 * The refusal happens BEFORE the query, so a denied caller cannot use the response
 * timing to infer whether responders exist.
 */

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { findAvailableResponders } from '@/services/dispatch';
import { criticalIncidentHeading, formatDistance, NO_RESPONDER_AVAILABLE_COPY } from '@/lib/dispatch/candidates';
import { candidatesQuerySchema, candidatesResponseSchema, incidentIdParamSchema } from '@/validators/dispatch';
import { getAdminDb, adminConfigurationReason } from '@/lib/server/firebase-admin';
import { COLLECTIONS } from '@/config/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRequest(
  {
    params: incidentIdParamSchema,
    query: candidatesQuerySchema,
    auth: 'required',
    rateLimit: 'dispatch.candidates',
  },
  async (ctx) => {
    const { params, query, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // Matrix row 28. `denied` for citizen AND responder — this is the check that
    // implements brief §10's location privacy.
    requireCapability(user, 'r28_seeCandidateResponders', { requestId: ctx.requestId });

    if (adminConfigurationReason() !== null) {
      throw new AppError({ code: 'DB_UNAVAILABLE', message: 'Responder information is temporarily unavailable.' });
    }

    /* ---------------------------------------------------------------------- *
     * The incident's own requirements, read once.
     * ---------------------------------------------------------------------- *
     * `requiredResources` is the incident's, never the caller's: a client that
     * could name the capabilities it wants to be matched against would turn this
     * into a directory search for "who can do X", which is `r35` and is denied for
     * responders.
     */
    const db = getAdminDb();
    const incidentSnap = await db.collection(COLLECTIONS.incidents).doc(params.id).get();
    if (!incidentSnap.exists) {
      throw new AppError({ code: 'INCIDENT_NOT_FOUND', message: 'We could not find that incident.' });
    }

    const incident = incidentSnap.data() as {
      geo?: { latitude: number; longitude: number } | null;
      requiredResources?: unknown;
      urgency?: string | null;
      deletedAt?: unknown;
    };

    if (incident.deletedAt != null) {
      throw new AppError({ code: 'INCIDENT_NOT_FOUND', message: 'We could not find that incident.' });
    }

    const requiredResources = Array.isArray(incident.requiredResources)
      ? incident.requiredResources.filter(
          (item): item is string => typeof item === 'string' && item.length > 0,
        )
      : [];

    const result = await findAvailableResponders(
      {
        point:
          incident.geo != null &&
          typeof incident.geo.latitude === 'number' &&
          typeof incident.geo.longitude === 'number'
            ? { lat: incident.geo.latitude, lng: incident.geo.longitude }
            : null,
        requiredResources,
        urgency: typeof incident.urgency === 'string' ? incident.urgency : null,
      },
      { nowMs: Date.now(), ...(query.limit === undefined ? {} : { limit: query.limit }) },
    );

    /* --- the heading, computed once so every surface agrees -------------- */
    // brief §13: "For critical incidents, the dispatcher UI should visually
    // prioritize the incident." The TEXT comes first and the colour reinforces it,
    // because a red badge alone is invisible to a screen reader and ambiguous to a
    // red-green colourblind reader — the same requirement `docs/12` places on map
    // markers.
    const assignable = result.candidates.filter((candidate) => candidate.isAssignable).length;
    const heading =
      result.candidates.length === 0
        ? NO_RESPONDER_AVAILABLE_COPY.heading
        : criticalIncidentHeading(assignable);

    return {
      data: candidatesResponseSchema.parse({
        incidentId: params.id,
        truncated: result.truncated,
        emptyReason: result.emptyReason,
        heading,
        candidates: result.candidates.map((candidate) => ({
          rank: candidate.rank,
          responderUid: candidate.responder.uid,
          displayName: candidate.responder.displayName,
          status: candidate.responder.status,
          capabilities: [...candidate.responder.capabilities],
          // `null`, never `0`: a responder with no known position has an UNKNOWN
          // distance, and `0` would read as "standing on the incident".
          distanceM: candidate.distanceM === Number.MAX_SAFE_INTEGER ? null : candidate.distanceM,
          // brief §30: "Display: 1.2 km away. Do not claim travel time."
          distanceLabel:
            candidate.distanceM === Number.MAX_SAFE_INTEGER ? null : formatDistance(candidate.distanceM),
          capabilityMatch: candidate.capabilityMatch,
          missingResources: [...candidate.missingResources],
          isAssignable: candidate.isAssignable,
          outOfServiceArea: candidate.outOfServiceArea,
          staleLocation: candidate.responder.staleLocation,
          accuracyGrade: candidate.responder.locationAccuracyGrade,
          // The explainability requirement, as data. A UI renders these; it cannot
          // invent its own explanation and it cannot show a number not in here.
          factors: candidate.factors.map((factor) => ({ ...factor })),
        })),
      }),
    };
  },
);

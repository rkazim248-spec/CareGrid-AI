import { describe, expect, it } from 'vitest';

import {
  acceptDispatchBodySchema,
  assignResponderBodySchema,
  candidatesQuerySchema,
  incidentStatusBodySchema,
  rejectDispatchBodySchema,
  withdrawDispatchBodySchema,
} from '@/validators/dispatch';
import { INCIDENT_STATUSES, RESOLUTION_CODES } from '@/types';

/* ========================================================================== */
/* The single most important property of these schemas                         */
/* ========================================================================== */

describe('a client CANNOT supply a role, a status, or a derived fact', () => {
  // brief §36: "Never trust: client role, client userId, client responderId,
  // client incidentId, client status."
  //
  // Asserted as REJECTED RATHER THAN IGNORED. A `.strict()` schema turns "the
  // client sent a field we do not accept" into a 400, which is the honest answer;
  // a schema that dropped it would let a caller believe a field they sent was
  // honoured, and would let `role: 'admin'` look like it might work.

  const forbiddenInputs: readonly [string, Record<string, unknown>][] = [
    ['role', { responderUid: 'u_x', role: 'admin' }],
    ['uid', { responderUid: 'u_x', uid: 'u_attacker' }],
    ['actorUid', { responderUid: 'u_x', actorUid: 'u_attacker' }],
    ['status', { responderUid: 'u_x', status: 'resolved' }],
    ['isLiveAssignee', { responderUid: 'u_x', isLiveAssignee: true }],
    ['verification', { responderUid: 'u_x', verification: 'verified' }],
    ['capabilityMatch', { responderUid: 'u_x', capabilityMatch: true }],
    ['distanceM', { responderUid: 'u_x', distanceM: 0 }],
    ['etaSec', { responderUid: 'u_x', etaSec: 30 }],
    ['activeIncidentCount', { responderUid: 'u_x', activeIncidentCount: 0 }],
    ['mode', { responderUid: 'u_x', mode: 'auto_suggest' }],
  ];

  it.each(forbiddenInputs)('assign refuses a body carrying %s', (_name, body) => {
    expect(assignResponderBodySchema.safeParse(body).success).toBe(false);
  });

  it('the status route refuses a client-chosen status transition result', () => {
    for (const extra of [
      { from: 'new' },
      { incidentStatus: 'resolved' },
      { completedDispatchId: 'd_forged' },
      { historyEventId: 'forged' },
      { allowedNext: ['resolved'] },
    ]) {
      expect(incidentStatusBodySchema.safeParse({ to: 'en_route', ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });
});

/* ========================================================================== */
/* POST /dispatch                                                              */
/* ========================================================================== */

describe('the assignment body', () => {
  it('accepts a responder and nothing else', () => {
    const parsed = assignResponderBodySchema.parse({ responderUid: 'u_4Kd8sTn' });
    expect(parsed).toEqual({ responderUid: 'u_4Kd8sTn' });
  });

  it('requires a responder', () => {
    expect(assignResponderBodySchema.safeParse({}).success).toBe(false);
    expect(assignResponderBodySchema.safeParse({ note: 'nearest paramedic' }).success).toBe(false);
  });

  it('requires a NON-EMPTY uid', () => {
    expect(assignResponderBodySchema.safeParse({ responderUid: '' }).success).toBe(false);
    expect(assignResponderBodySchema.safeParse({ responderUid: '   ' }).success).toBe(false);
  });

  it('refuses a uid containing a slash, which would address a nested path', () => {
    expect(assignResponderBodySchema.safeParse({ responderUid: 'a/b' }).success).toBe(false);
  });

  it('trims a note, and refuses a whitespace-only one', () => {
    expect(assignResponderBodySchema.parse({ responderUid: 'u_x', note: '  nearest  ' }).note).toBe('nearest');
    // An empty "instruction" would reach a responder as if a dispatcher had said
    // something, which is the same failure as a missing one.
    expect(assignResponderBodySchema.safeParse({ responderUid: 'u_x', note: '   ' }).success).toBe(false);
  });

  it('caps the note at the documented 280 characters', () => {
    // docs/07 §8: "note | dispatcher instruction, <= 280 chars".
    expect(assignResponderBodySchema.safeParse({ responderUid: 'u_x', note: 'x'.repeat(280) }).success).toBe(true);
    expect(assignResponderBodySchema.safeParse({ responderUid: 'u_x', note: 'x'.repeat(281) }).success).toBe(false);
  });
});

/* ========================================================================== */
/* Accept and decline                                                          */
/* ========================================================================== */

describe('the accept body is empty, and that is the whole contract', () => {
  it('accepts {}', () => {
    expect(acceptDispatchBodySchema.safeParse({}).success).toBe(true);
  });

  it('refuses ANY parameter, so a client cannot send one that is silently dropped', () => {
    // A schema with optional fields would let a client send a `note` believing it
    // reached the responder, and it would vanish.
    for (const extra of [{ note: 'on my way' }, { reason: 'accepted' }, { status: 'accepted' }]) {
      expect(acceptDispatchBodySchema.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
    }
  });
});

describe('a decline reason is ALLOWED, not required', () => {
  // brief §16: "If rejected, require or allow a reason where appropriate."
  // The brief's own list ends with "Other", which is only reachable if free text
  // is accepted. A mandatory enumerated field would force a responder to record a
  // reason that is not true in order to decline an incident they may decline.
  it('accepts a body with no reason', () => {
    expect(rejectDispatchBodySchema.safeParse({}).success).toBe(true);
  });

  it('accepts a free-text reason, which is how "Other" is reachable', () => {
    expect(rejectDispatchBodySchema.parse({ reason: 'My vehicle is on fire.' })).toEqual({
      reason: 'My vehicle is on fire.',
    });
  });

  it('refuses a whitespace-only reason', () => {
    expect(rejectDispatchBodySchema.safeParse({ reason: '  ' }).success).toBe(false);
  });

  it('caps the reason at the documented audit 200 characters', () => {
    expect(rejectDispatchBodySchema.safeParse({ reason: 'x'.repeat(200) }).success).toBe(true);
    expect(rejectDispatchBodySchema.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('a CANCELLATION requires a reason, unlike a decline', () => {
  // brief §33: "Require confirmation." A dispatcher cancelling a live assignment
  // may be removing a responder who is already driving, so the reason is a
  // precondition of the API rather than a convention the UI follows.
  it('refuses a body with no reason', () => {
    expect(withdrawDispatchBodySchema.safeParse({}).success).toBe(false);
  });

  it('refuses a blank reason', () => {
    expect(withdrawDispatchBodySchema.safeParse({ reason: '   ' }).success).toBe(false);
  });

  it('accepts a real one', () => {
    expect(withdrawDispatchBodySchema.safeParse({ reason: 'Wrong unit for this incident.' }).success).toBe(true);
  });
});

/* ========================================================================== */
/* PATCH /status                                                               */
/* ========================================================================== */

describe('the status body', () => {
  it('accepts every status in the enum', () => {
    for (const to of INCIDENT_STATUSES) {
      // `resolved` additionally needs a code; the rest do not.
      const body = to === 'resolved' ? { to, resolutionCode: 'resolved_safe' } : { to };
      expect(incidentStatusBodySchema.safeParse(body).success, to).toBe(true);
    }
  });

  it('refuses a status that is not in the enum', () => {
    expect(incidentStatusBodySchema.safeParse({ to: 'dispatched' }).success).toBe(false);
    expect(incidentStatusBodySchema.safeParse({ to: 'EN_ROUTE' }).success).toBe(false);
    expect(incidentStatusBodySchema.safeParse({ to: '' }).success).toBe(false);
  });

  // FR-054. Checked here as well as in `checkTransitionPrerequisites`: here it is a
  // 400 NAMING THE FIELD, which is more use to a client than a 409 saying only
  // "unresolved prerequisite".
  it('`resolved` without a resolutionCode is refused, naming the field', () => {
    const result = incidentStatusBodySchema.safeParse({ to: 'resolved' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('resolutionCode'))).toBe(true);
    }
  });

  it('`resolved` WITH a documented code passes', () => {
    // `docs/01` FR-054 and `docs/17 §163`'s six: `resolved_safe`, `false_positive`,
    // `transferred_to_authority`, `no_assistance_needed`, `duplicate`,
    // `withdrawn_by_reporter`. The enum is Phase 3's, from `types/enums.ts` — this
    // schema does not carry a second copy.
    expect(incidentStatusBodySchema.safeParse({ to: 'resolved', resolutionCode: 'resolved_safe' }).success).toBe(true);
  });

  it('accepts every code in the documented list', () => {
    for (const code of RESOLUTION_CODES) {
      expect(incidentStatusBodySchema.safeParse({ to: 'resolved', resolutionCode: code }).success, code).toBe(true);
    }
  });

  it('refuses a resolutionCode that is not in the documented vocabulary', () => {
    // `docs/17 §1092` names this case: "`resolutionCode: 'fixed'` |
    // `invalid_enum_value` → `INVALID_RESOLUTION_CODE`, 400".
    for (const code of ['assisted', 'fixed', 'because_i_said_so', 'Resolved_Safe']) {
      expect(incidentStatusBodySchema.safeParse({ to: 'resolved', resolutionCode: code }).success, code).toBe(false);
    }
  });

  // `docs/17 §212` rule 8: "A resolution code only with `resolved`".
  it('refuses a resolutionCode on a NON-resolved transition', () => {
    // A code on an `en_route` request is a caller who believes they have finished,
    // or a UI sending a stale field. Ignoring it is the failure mode: the incident
    // would reach `resolved` later with no code and be unresolvable.
    for (const to of ['en_route', 'on_scene', 'triaged', 'cancelled'] as const) {
      expect(
        incidentStatusBodySchema.safeParse({ to, resolutionCode: 'resolved_safe' }).success,
        to,
      ).toBe(false);
    }
  });

  it('a non-resolved transition may carry no code at all', () => {
    expect(incidentStatusBodySchema.safeParse({ to: 'on_scene' }).success).toBe(true);
  });

  it('`merged` parses, because the ENUM permits it — the TABLE refuses it', () => {
    // The distinction matters: the enum check is a 400 for a typo, and the
    // transition table is a 409 for an illegal move. Conflating them would tell a
    // dispatcher their request was malformed when the truth is that no path
    // reaches `merged`.
    expect(incidentStatusBodySchema.safeParse({ to: 'merged' }).success).toBe(true);
  });
});

describe('the resolution record is entirely OPTIONAL and nullable', () => {
  // brief §34: "Optionally capture: resolution note, resources used, people
  // assisted, additional follow-up required. Do not invent these values. Allow
  // unknown/empty values where appropriate."
  it('accepts an empty resolution object', () => {
    expect(incidentStatusBodySchema.safeParse({ to: 'resolved', resolutionCode: 'resolved_safe', resolution: {} }).success).toBe(
      true,
    );
  });

  it('accepts explicit nulls, which mean "not recorded"', () => {
    expect(
      incidentStatusBodySchema.safeParse({
        to: 'resolved',
        resolutionCode: 'resolved_safe',
        resolution: { peopleAssisted: null, followUpRequired: null },
      }).success,
    ).toBe(true);
  });

  it('accepts a real count', () => {
    expect(
      incidentStatusBodySchema.safeParse({
        to: 'resolved',
        resolutionCode: 'resolved_safe',
        resolution: { peopleAssisted: 3, followUpRequired: true },
      }).success,
    ).toBe(true);
  });

  it('refuses a negative count, because -1 is not a fact about a rescue', () => {
    expect(
      incidentStatusBodySchema.safeParse({
        to: 'resolved',
        resolutionCode: 'resolved_safe',
        resolution: { peopleAssisted: -1 },
      }).success,
    ).toBe(false);
  });

  it('refuses a non-integer count', () => {
    expect(
      incidentStatusBodySchema.safeParse({
        to: 'resolved',
        resolutionCode: 'resolved_safe',
        resolution: { peopleAssisted: 2.5 },
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown field inside the resolution object', () => {
    expect(
      incidentStatusBodySchema.safeParse({
        to: 'resolved',
        resolutionCode: 'resolved_safe',
        resolution: { peopleRescued: 3 },
      }).success,
    ).toBe(false);
  });

  it('caps the resources list', () => {
    const many = Array.from({ length: 13 }, (_, i) => `res_${i}`);
    expect(
      incidentStatusBodySchema.safeParse({
        to: 'resolved',
        resolutionCode: 'resolved_safe',
        resolution: { resourcesUsed: many },
      }).success,
    ).toBe(false);
  });
});

/* ========================================================================== */
/* GET /candidates                                                             */
/* ========================================================================== */

describe('the candidates query', () => {
  it('accepts no limit', () => {
    expect(candidatesQuerySchema.safeParse({}).success).toBe(true);
  });

  it('coerces a string limit, because a query string is always strings', () => {
    expect(candidatesQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('refuses a limit below 1 and above 200', () => {
    expect(candidatesQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(candidatesQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('refuses an unknown query parameter', () => {
    // `.strict()` on the query string is what stops a caller smuggling a filter
    // that changes who appears in a dispatcher's panel.
    expect(candidatesQuerySchema.safeParse({ limit: '10', status: 'available' }).success).toBe(false);
    expect(candidatesQuerySchema.safeParse({ includePhone: 'true' }).success).toBe(false);
  });
});

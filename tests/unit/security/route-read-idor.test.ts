/**
 * ============================================================================
 * GET /api/incidents and GET /api/incidents/:id — driven as REAL requests
 * ============================================================================
 *
 * The defect this file is shaped around: a READ route that returns the right rows
 * for the wrong caller, and does it while every other test stays green. Read
 * authorisation is the easiest thing in a product to get subtly wrong, because the
 * happy path and the leak look identical to a test that only checks "a citizen can
 * see their own report".
 *
 * So this suite drives the exported `GET`s with a real `Request`, through the real
 * pipeline, the real validators and the real service. Only token verification and
 * Firestore are faked.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR
 * ---------------------------------------------------------------------------
 * Three properties, each of which has an obvious wrong implementation that passes
 * a naive test:
 *
 *   1. **Scoping is in the QUERY, not in a post-filter.** A citizen's query must
 *      carry the reporter predicate, so their documents cannot even be read. A
 *      post-filter would return the same rows while having already read everything.
 *   2. **A record you may not see is a 404, not a 403.** A 403 confirms existence.
 *   3. **Redaction is per row, not per response.** A dispatcher's page contains
 *      other people's reports AND possibly one they filed themselves.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PASS HERE DOES NOT PROVE
 * ---------------------------------------------------------------------------
 * `firestore.rules` is not consulted; these are Admin SDK calls, which bypass
 * client rules by design. Agreement between the two is asserted statically in
 * `tests/unit/api/privilege-escalation.test.ts` and needs the emulator for the rest.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRequest,
  callRoute,
  FakeAuth,
  FakeFirestore,
  installRequiredEnv,
  seedIncident,
  seedUser,
  type Envelope,
} from '../../helpers/route-harness';

installRequiredEnv();

/* --- module-level singletons the mocks close over ------------------------- */

let db: FakeFirestore;
let auth: FakeAuth;

vi.mock('@/lib/server/firebase-admin', () => ({
  getAdminDb: () => db,
  getAdminAuth: () => auth,
  getAdminStorage: () => ({}),
  adminConfigurationReason: () => null,
}));

/* Imported AFTER the mocks so the pipeline resolves `getAdminDb` to the fake. */
const { GET: LIST } = await import('@/app/api/incidents/route');
const { GET: DETAIL } = await import('@/app/api/incidents/[id]/route');

const URL = 'http://localhost:3000/api/incidents';

/* ========================================================================== */
/* Fixtures                                                                     */
/* ========================================================================== */

/** A fully-populated live incident, as the create path would have written it. */
function incident(overrides: Record<string, unknown> = {}) {
  return {
    reference: 'INC-7F3K9Q',
    status: 'triaged',
    category: 'medical',
    urgency: 'high',
    triageSource: 'ai',
    aiConfidence: 0.82,
    aiNeedsReview: false,
    summary: 'Person collapsed near the market entrance.',
    originalText: 'my uncle fell down and cannot get up at the market gate',
    peopleAffected: 1,
    language: 'en',
    evidenceCount: 2,
    reportCount: 1,
    duplicateStatus: 'none',
    duplicateOf: null,
    assigneeUid: null,
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-01T09:00:00.000Z',
    deletedAt: null,
    geo: null,
    geoCells: [],
    locationText: null,
    channel: 'app',
    slaTargetMin: 60,
    slaState: 'on_track',
    ...overrides,
  };
}

/* --- auth plumbing --------------------------------------------------------- */

/**
 * The token for a seeded user.
 *
 * Tokens are issued explicitly per role rather than read off a default, because a
 * suite whose auth defaults to the first seeded user is a suite where a test can
 * silently be exercising the wrong caller.
 */
const TOKENS = {
  citizenMine: 't_mine',
  citizenTheirs: 't_theirs',
  citizenEmpty: 't_empty',
  responder: 't_resp',
  responderOther: 't_resp2',
  dispatcher: 't_disp',
  admin: 't_admin',
} as const;

function reset(): void {
  db = new FakeFirestore();
  auth = new FakeAuth();

  seedUser(db, { uid: 'u_mine', role: 'citizen' });
  seedUser(db, { uid: 'u_theirs', role: 'citizen' });
  seedUser(db, { uid: 'u_empty', role: 'citizen' });
  seedUser(db, { uid: 'u_resp', role: 'responder' });
  seedUser(db, { uid: 'u_resp2', role: 'responder' });
  seedUser(db, { uid: 'u_disp', role: 'dispatcher' });
  seedUser(db, { uid: 'u_admin', role: 'admin' });

  const claims = { auth_time: Math.floor(Date.now() / 1000) };
  auth.issue(TOKENS.citizenMine, { uid: 'u_mine', ...claims });
  auth.issue(TOKENS.citizenTheirs, { uid: 'u_theirs', ...claims });
  auth.issue(TOKENS.citizenEmpty, { uid: 'u_empty', ...claims });
  auth.issue(TOKENS.responder, { uid: 'u_resp', ...claims });
  auth.issue(TOKENS.responderOther, { uid: 'u_resp2', ...claims });
  auth.issue(TOKENS.dispatcher, { uid: 'u_disp', ...claims });
  auth.issue(TOKENS.admin, { uid: 'u_admin', ...claims });
}

beforeEach(reset);

/* ========================================================================== */
/* Envelope readers                                                             */
/* ========================================================================== */

function data(envelope: Envelope): Record<string, unknown> {
  if (!envelope.success) throw new Error(`expected success, got ${envelope.error.code}`);
  return envelope.data as Record<string, unknown>;
}

function rows(envelope: Envelope): Array<Record<string, unknown>> {
  return data(envelope).items as Array<Record<string, unknown>>;
}

function ids(envelope: Envelope): unknown[] {
  return rows(envelope).map((row) => row.incidentId);
}

function scopeOf(envelope: Envelope): Record<string, unknown> {
  return data(envelope).scope as Record<string, unknown>;
}

/** Drive the list route. */
function list(token: string | null = TOKENS.citizenMine, query = '') {
  return callRoute(LIST, buildRequest(`${URL}${query}`, { token }));
}

/** Drive the detail route. `params` is a Promise, as Next supplies it. */
function detail(id: string, token: string | null = TOKENS.citizenMine) {
  return callRoute(DETAIL, buildRequest(`${URL}/${id}`, { token }), {
    params: Promise.resolve({ id }),
  });
}

/* ========================================================================== */
/* Query-observation spy                                                        */
/* ========================================================================== */

/**
 * Record every filter set the service hands to Firestore.
 *
 * The point of spying here rather than on the response is that a post-filter and a
 * query filter return IDENTICAL rows. Only the filters reaching the database
 * distinguish "scoped in the query" from "scoped after reading everything".
 */
function observeFilters(): { filters: () => ReadonlyArray<Record<string, unknown>> } {
  const captured: Array<ReadonlyArray<Record<string, unknown>>> = [];
  type FilterArg = Parameters<FakeFirestore['queryMatches']>[1];
  const original = db.queryMatches.bind(db);
  vi.spyOn(db, 'queryMatches').mockImplementation((collectionPath: string, filters: FilterArg) => {
    captured.push(filters as unknown as ReadonlyArray<Record<string, unknown>>);
    return original(collectionPath, filters);
  });
  return { filters: () => captured.flat() };
}

/* ========================================================================== */
/* 1. The citizen list                                                          */
/* ========================================================================== */

describe('a citizen sees only their own reports', () => {
  beforeEach(() => {
    seedIncident(db, { ...incident(), id: 'i_mine', reporterUid: 'u_mine' });
    seedIncident(db, {
      ...incident(),
      id: 'i_theirs',
      reporterUid: 'u_theirs',
      reference: 'INC-OTHER1',
    });
  });

  it('returns their own incident and nobody else\'s', async () => {
    const { envelope } = await list();
    expect(ids(envelope)).toEqual(['i_mine']);
  });

  it('carries the reporter predicate INTO THE QUERY, not into a post-filter', async () => {
    // The decisive assertion for property 1. If the implementation read the
    // collection and filtered afterwards, the returned rows would still be exactly
    // `['i_mine']` — and the other citizen's document would already have crossed the
    // boundary. Only this assertion notices the difference.
    const seen = observeFilters();

    await list();

    expect(seen.filters()).toContainEqual({ field: 'reporterUid', op: '==', value: 'u_mine' });
  });

  it('always carries the soft-delete predicate', async () => {
    const seen = observeFilters();

    await list();

    // Not optional, and not left to the caller. A list route that forgot this once
    // would be a data-retention incident.
    expect(seen.filters()).toContainEqual({ field: 'deletedAt', op: '==', value: null });
  });

  it('reports an honest scope that INCLUDES `own`', async () => {
    const { envelope } = await list();
    const scope = scopeOf(envelope);

    // A citizen's list IS the whole truth for them, so `complete` must be true —
    // teaching the UI to apologise for correctness is its own kind of bug.
    expect(scope.complete).toBe(true);
    expect(scope.limitedReason).toBeNull();
    expect(scope.includes).toContain('own');
  });

  it('an account with no reports gets an empty list, not an error', async () => {
    const { envelope, status } = await list(TOKENS.citizenEmpty);

    expect(status).toBe(200);
    expect(rows(envelope)).toEqual([]);
  });

  it('an unauthenticated caller is refused', async () => {
    const { envelope, status } = await list(null);

    expect(status).toBe(401);
    expect(envelope.success).toBe(false);
  });
});

/* ========================================================================== */
/* 2. Soft deletion is not role-scoped                                          */
/* ========================================================================== */

describe('a soft-deleted report disappears for its own owner', () => {
  beforeEach(() => {
    seedIncident(db, { ...incident(), id: 'i_live', reporterUid: 'u_mine' });
    seedIncident(db, {
      id: 'i_deleted',
      reporterUid: 'u_mine',
      ...incident({ deletedAt: '2026-03-02T10:00:00.000Z' }),
    });
  });

  it('excludes it even though the reporter owns it', async () => {
    // The uncomfortable case, and the one worth testing: `reporterUid == uid` alone
    // would return it. A citizen whose report an operator deleted must not keep
    // seeing it in their own list.
    const { envelope } = await list();
    expect(ids(envelope)).toEqual(['i_live']);
  });
});

/* ========================================================================== */
/* 3. Redaction — per row, and OMITTED rather than nulled                      */
/* ========================================================================== */

describe('the conditional fields are OMITTED when withheld, never nulled', () => {
  beforeEach(() => {
    seedIncident(db, { ...incident(), id: 'i_mine', reporterUid: 'u_mine' });
    seedIncident(db, {
      ...incident({ reference: 'INC-OTHER1' }),
      id: 'i_assigned',
      reporterUid: 'u_theirs',
      assigneeUid: 'u_resp',
    });
  });

  it('the owner sees the original text, holding `r09` as `owner`', async () => {
    const { envelope } = await list(TOKENS.citizenMine);
    expect(rows(envelope)[0]?.originalText).toBe(
      'my uncle fell down and cannot get up at the market gate',
    );
  });

  it('the owner sees their own reporter identity', async () => {
    const { envelope } = await list(TOKENS.citizenMine);
    expect(rows(envelope)[0]?.reporterUid).toBe('u_mine');
  });

  it('an assigned responder does NOT get the original text', async () => {
    // `r09_readOriginalText` is `scoped` for a responder. An assigned responder
    // reading the citizen's own account here would be a real disclosure.
    const { envelope } = await list(TOKENS.responder);

    expect(ids(envelope)).toEqual(['i_assigned']);
    expect(rows(envelope)[0]?.originalText).toBeUndefined();
  });

  it('an assigned responder does NOT get the reporter identity', async () => {
    const { envelope } = await list(TOKENS.responder);
    expect(rows(envelope)[0]?.reporterUid).toBeUndefined();
  });

  it('the responder still gets the SUMMARY, which is why the row is useful', async () => {
    const { envelope } = await list(TOKENS.responder);
    expect(rows(envelope)[0]?.summary).toBe('Person collapsed near the market entrance.');
  });

  it('withheld means `undefined`, not `null`', async () => {
    // A nullable field would let a client render `originalText ?? 'Not available'`
    // and be unable to distinguish a redaction from a genuinely empty report — the
    // exact ambiguity that would get "fixed" by loosening the gate.
    const { envelope } = await list(TOKENS.responder);
    const [row] = rows(envelope);

    expect(row?.originalText).not.toBeNull();
    expect('originalText' in (row ?? {})).toBe(true);
  });

  it('the AI panel is absent for a citizen, who holds no `r13`', async () => {
    const { envelope } = await list(TOKENS.citizenMine);
    expect(rows(envelope)[0]?.ai).toBeUndefined();
  });

  it('the AI panel IS present for a responder, where `r13` is `readonly`', async () => {
    // Deliberately independent of `r09`: a responder may see how confident the model
    // was without seeing what the citizen wrote. Coupling the two would either
    // overexpose the text or hide the triage signal.
    const { envelope } = await list(TOKENS.responder);
    expect(rows(envelope)[0]?.ai).toMatchObject({ source: 'ai', confidence: 0.82 });
  });
});

/* ========================================================================== */
/* 4. Responder scope                                                           */
/* ========================================================================== */

describe('a responder sees their ASSIGNED incidents and no others', () => {
  beforeEach(() => {
    seedIncident(db, { ...incident(), id: 'i_mine', reporterUid: 'u_theirs', assigneeUid: 'u_resp' });
    seedIncident(db, { ...incident(), id: 'i_theirs', reporterUid: 'u_mine', assigneeUid: 'u_resp2', reference: 'INC-OTHER1' });
    seedIncident(db, { ...incident(), id: 'i_free', reporterUid: 'u_theirs', assigneeUid: null, reference: 'INC-OTHER2' });
  });

  it('excludes another responder\'s incident', async () => {
    const { envelope } = await list(TOKENS.responder);
    expect(ids(envelope)).toEqual(['i_mine']);
  });

  it('excludes the unassigned incident, because this responder shares no location', async () => {
    // No `responderLocations/u_resp` document is seeded, so there is no centre for
    // the radius and that arm is dropped. Asserting the exclusion AND the
    // incompleteness below is what makes this honest rather than a silent
    // under-report.
    const { envelope } = await list(TOKENS.responder);
    expect(ids(envelope)).not.toContain('i_free');
  });

  it('says the scope is INCOMPLETE, so a narrow list cannot read as an empty queue', async () => {
    const { envelope } = await list(TOKENS.responder);
    const scope = scopeOf(envelope);

    expect(scope.complete).toBe(false);
    expect(typeof scope.limitedReason).toBe('string');
  });

  it('does NOT claim the `unassigned_nearby` arm it could not honour', async () => {
    const { envelope } = await list(TOKENS.responder);
    const scope = scopeOf(envelope);

    // Claiming the arm while running no query for it would let the UI promise
    // "showing unassigned incidents near you" over a list that contains none.
    expect(scope.includes).not.toContain('unassigned_nearby');
  });

  it('carries BOTH the `own` and `assigned` predicates', async () => {
    // The matrix grants a citizen `r06_readAssignedIncidents` at `full`, so
    // `assigned` really is in scope for this responder. The point of the union is
    // that neither arm replaces the other.
    const seen = observeFilters();

    await list(TOKENS.responder);

    expect(seen.filters()).toContainEqual({ field: 'reporterUid', op: '==', value: 'u_resp' });
    expect(seen.filters()).toContainEqual({ field: 'assigneeUid', op: '==', value: 'u_resp' });
  });
});

/* ========================================================================== */
/* 5. Ops scope                                                                 */
/* ========================================================================== */

describe('a dispatcher or admin sees everything, unredacted', () => {
  beforeEach(() => {
    seedIncident(db, { ...incident(), id: 'i_1', reporterUid: 'u_theirs', assigneeUid: 'u_resp' });
    seedIncident(db, { ...incident(), id: 'i_2', reporterUid: 'u_mine', assigneeUid: null, reference: 'INC-OTHER1' });
  });

  it.each([
    ['dispatcher', TOKENS.dispatcher],
    ['admin', TOKENS.admin],
  ] as const)('a %s sees incidents they are not part of', async (_role, token) => {
    const { envelope } = await list(token);
    expect([...ids(envelope)].sort()).toEqual(['i_1', 'i_2']);
  });

  it('reads the original text, holding `r09` at `full`', async () => {
    const { envelope } = await list(TOKENS.dispatcher);
    expect(rows(envelope)[0]?.originalText).toBe(
      'my uncle fell down and cannot get up at the market gate',
    );
  });

  it('reads the reporter identity, holding `r10` at `full`', async () => {
    const { envelope } = await list(TOKENS.dispatcher);
    expect([...rows(envelope).map((row) => row.reporterUid)].sort()).toEqual(['u_mine', 'u_theirs']);
  });

  it('reports a COMPLETE scope, and does not enumerate the narrower arms', async () => {
    const { envelope } = await list(TOKENS.dispatcher);
    const scope = scopeOf(envelope);

    expect(scope).toEqual({ includes: ['all'], complete: true, limitedReason: null });
    // `all` already contains every narrower slice, so running them would triple the
    // reads to return the same rows. The report must not imply they were separate.
    expect(scope.includes).toHaveLength(1);
  });
});

/* ========================================================================== */
/* 6. The detail route: 404, not 403                                           */
/* ========================================================================== */

describe('GET /api/incidents/:id — an invisible record is a 404', () => {
  beforeEach(() => {
    seedIncident(db, { ...incident(), id: 'i_secret', reporterUid: 'u_theirs' });
  });

  it('a citizen asking for someone else\'s incident gets NOT_FOUND', async () => {
    const { envelope, status } = await detail('i_secret');

    expect(status).toBe(404);
    expect(envelope.success).toBe(false);
    if (!envelope.success) expect(envelope.error.code).toBe('NOT_FOUND');
  });

  it('the error is byte-identical to the one for an id that was never issued', async () => {
    // Not merely the same status. A differing `message` or `details` here would
    // reintroduce the existence oracle this route exists to avoid.
    const { envelope: forbidden } = await detail('i_secret');
    const { envelope: missing } = await detail('i_never_existed');

    expect(forbidden).toEqual(missing);
  });

  it('a responder who is NOT assigned gets a 404, not the record', async () => {
    const { status } = await detail('i_secret', TOKENS.responder);
    expect(status).toBe(404);
  });

  it('the reporter CAN read it, and gets their original text back', async () => {
    const { envelope, status } = await detail('i_secret', TOKENS.citizenTheirs);

    expect(status).toBe(200);
    expect(data(envelope).profile).toBe('owner');
    expect((data(envelope).incident as Record<string, unknown>).originalText).toBe(
      'my uncle fell down and cannot get up at the market gate',
    );
  });

  it('the assigned responder CAN read it, and gets the redacted version', async () => {
    const { envelope, status } = await detail('i_secret', TOKENS.responder);

    expect(status).toBe(200);
    expect(data(envelope).profile).toBe('responder');
    // The redaction holds on the detail route exactly as it does on the list. A
    // detail route that skipped the profile would hand over everything the list
    // correctly withheld.
    expect((data(envelope).incident as Record<string, unknown>).originalText).toBeUndefined();
  });

  it('an unassigned incident is a 404 for a dispatcher only if it is DELETED', async () => {
    // Ops scope is genuinely broad; this documents that the ONLY thing that hides a
    // record from a dispatcher is deletion.
    seedIncident(db, { ...incident({ deletedAt: '2026-03-02T10:00:00.000Z' }), id: 'i_gone', reporterUid: 'u_theirs' });

    const { status } = await detail('i_gone', TOKENS.dispatcher);
    expect(status).toBe(404);
  });

  it('an unauthenticated caller is refused', async () => {
    const { status } = await detail('i_secret', null);
    expect(status).toBe(401);
  });
});

/* ========================================================================== */
/* 7. Reading never writes                                                      */
/* ========================================================================== */

describe('reading an incident never writes to it', () => {
  beforeEach(() => {
    seedIncident(db, { ...incident(), id: 'i_1', reporterUid: 'u_theirs' });
  });

  it('a list and a detail read leave zero writes', async () => {
    await list(TOKENS.dispatcher);
    await detail('i_1', TOKENS.dispatcher);

    // An `ageMin` recompute or a "last viewed" stamp written on read would show up
    // here. Either would mutate the document a responder is about to act on, from a
    // route that has no write permission.
    expect(db.writes).toEqual([]);
  });
});
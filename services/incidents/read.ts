/**
 * ============================================================================
 * CareGrid AI — reading incidents (FR-010 / FR-011, docs/08 §3.2)
 * ============================================================================
 *
 * `services/incidents` - the READ side of the same collection the create path
 * writes. This is the module that lets a citizen track their own report, a
 * responder work their queue, and a dispatcher see the whole picture.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SERVICE AND NOT A FIRESTORE LISTENER
 * ---------------------------------------------------------------------------
 * `features/incidents/use-realtime-incidents.ts` deliberately does NOT exist for
 * citizens, and `docs/11 §11.1` SEC-2 says why: a client that forms the
 * dispatcher's query is a client that is one rules bug away from reading the
 * dispatcher's queue. Firestore rules are the real boundary, so the safe shape is
 * to let the SERVER decide what a caller may see and hand back a redacted page.
 *
 * That inverts the usual trade: we lose realtime. A responder's list is a snapshot
 * taken when they asked. For an emergency product that is a real cost, and it is
 * the cost of not shipping a data leak. It is called out here rather than buried so
 * the trade can be revisited deliberately.
 *
 * ---------------------------------------------------------------------------
 * THE SCOPE IS DERIVED FROM THE MATRIX, NEVER FROM A ROLE SWITCH
 * ---------------------------------------------------------------------------
 * Every read scope below is decided by asking the permission matrix what the
 * caller holds. A `switch (user.role)` would be shorter, would be one refactor away
 * from disagreeing with `lib/auth/permissions.ts`, and would make the matrix a
 * document rather than the mechanism. brief §19 asks for a centralized decision;
 * this is that decision.
 *
 * Adding a role then does NOT require touching this file. That is the property
 * worth the extra indirection.
 */

import 'server-only';

import type { DocumentData, QueryDocumentSnapshot } from 'firebase-admin/firestore';

import { COLLECTIONS } from '@/config/collections';
import { buildGeoCells } from '@/lib/geo/geohash';
import { can, levelOf } from '@/lib/auth/permissions';
import type { AuthedUser } from '@/lib/server/auth-guard';
import { AppError } from '@/lib/server/errors';
import { getAdminDb } from '@/lib/server/firebase-admin';
import {
  mayReadLocationText,
  mayReadOriginalText,
  mayReadReporterIdentity,
  readBoolean,
  readNumber,
  readString,
  redactionProfile,
  toGeoPoint,
  toIso,
} from '@/lib/server/serialize';
import {
  DOC_ID_TIEBREAK,
  deletedFilter,
  inFilter,
  runPagedQuery,
  type AdminFilter,
  type AdminPage,
} from '@/services/admin/query';
import { MEDIA_ID_RE, MEDIA_LIMITS } from '@/validators/upload';

import type { IncidentCategory, IncidentStatus, Urgency } from '@/types';

/* ========================================================================== */
/* Scope                                                                       */
/* ========================================================================== */

/**
 * One slice of the world a caller may look at.
 *
 * Named for the PREDICATE it produces, not for the role that happens to hold it, so
 * a change in the matrix moves the scope without renaming anything.
 */
export type IncidentScopeComponent =
  /** `reporterUid == me`. `r05_readOwnIncidents`. */
  | 'own'
  /** `assigneeUid == me`. `r06_readAssignedIncidents`. */
  | 'assigned'
  /** Unassigned and inside my radius. `r07_readUnassignedInRadius`. */
  | 'unassigned_nearby'
  /** Everything not deleted. `r08_readAllIncidents`. */
  | 'all';

/**
 * What the caller was shown, and — critically — whether that was the whole truth.
 *
 * This is a SET rather than a single widest-wins value, and that is not cosmetic.
 *
 * ---------------------------------------------------------------------------
 * WHY "WIDEST GRANT WINS" IS WRONG HERE
 * ---------------------------------------------------------------------------
 * The matrix grants `r06_readAssignedIncidents` at `full` to `citizen` as well as
 * to every other role. That is what the 61-row table says and this module does not
 * get to change it. So a "pick the widest capability the caller holds" derivation
 * hands a CITIZEN the `assigned` scope — and a citizen is never assigned to an
 * incident, so the citizen's list comes back empty. The one screen a person uses
 * this product for, tracking their own report, silently returns nothing, and every
 * test that only checks "a citizen can reach the endpoint" stays green.
 *
 * The matrix rows are ADDITIVE permissions: each grants a slice, and a caller may
 * see the union of the slices they hold. `r05_readOwnIncidents` is `full` for every
 * role, so `own` is always present, and the wider rows add to it rather than
 * replacing it.
 *
 * `complete` is what stops a narrowed list from reading as an empty queue. A
 * responder without location sharing sees a partial world, and a list that showed
 * them three of four nearby incidents with no caveat would read as "there are only
 * three". Returning the reason lets the client say what it is showing.
 */
export type IncidentScopeReport = {
  readonly includes: readonly IncidentScopeComponent[];
  /** `false` when a granted slice was dropped because a server fact was missing. */
  readonly complete: boolean;
  /** A sentence for a person. `null` when nothing was withheld. */
  readonly limitedReason: string | null;
};

/**
 * The scope for this caller.
 *
 * `hasPosition` is the one server-side fact that changes the answer, and it is
 * passed in rather than looked up here so the caller controls the single read that
 * `nearbyCellsFor` performs.
 *
 * `all` short-circuits because it already contains every other slice — running the
 * narrower queries alongside it would triple the reads to return the same rows.
 */
export function scopeFor(user: AuthedUser, hasPosition: boolean): IncidentScopeReport {
  if (can(user.role, 'r08_readAllIncidents')) {
    return { includes: ['all'], complete: true, limitedReason: null };
  }

  // `r05_readOwnIncidents` is `full` for every role, so `own` is unconditional. It
  // is checked through the matrix anyway rather than hard-coded, so that if the
  // table ever stops granting it to a role, that role stops seeing other people's
  // reports automatically.
  const includes: IncidentScopeComponent[] = [];
  if (can(user.role, 'r05_readOwnIncidents')) includes.push('own');
  if (can(user.role, 'r06_readAssignedIncidents')) includes.push('assigned');

  let limitedReason: string | null = null;
  if (can(user.role, 'r07_readUnassignedInRadius')) {
    if (hasPosition) {
      includes.push('unassigned_nearby');
    } else {
      // The right exists; the CENTRE of the radius does not. A radius with no centre
      // is not a radius, so the slice is dropped and the drop is declared.
      limitedReason = 'Share your location to see unassigned incidents near you.';
    }
  }

  return { includes, complete: limitedReason === null, limitedReason };
}

/**
 * The scope without doing the location read.
 *
 * Exposed for the provider panel and for tests. It reports the responder case as
 * INCOMPLETE, because that is the honest answer before the position is known.
 */
export function readScopeFor(user: AuthedUser): IncidentScopeReport {
  return scopeFor(user, false);
}

/* ========================================================================== */
/* Response shapes                                                             */
/* ========================================================================== */

/**
 * One incident, as a caller is allowed to see it.
 *
 * Every field is either present or OMITTED. There are no `null`s standing in for
 * "you may not see this", because a null and a hidden field are different claims:
 * one says the value is unknown, the other says it is not yours. A client that
 * renders `originalText ?? 'Not available'` cannot tell those apart, so the field
 * is absent and the type is optional.
 */
export type IncidentRow = {
  readonly incidentId: string;
  /** The human reference, e.g. `INC-7F3K9Q`. Safe in every scope. */
  readonly reference: string;
  readonly status: IncidentStatus;
  readonly category: IncidentCategory | null;
  readonly urgency: Urgency;
  /** Triage's one-line read of the report. Every scope may have this. */
  readonly summary: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly evidenceCount: number;
  readonly reportCount: number;
  readonly peopleAffected: number | null;
  readonly isDuplicate: boolean;
  readonly language: string;
  /** The coarse label, safe for every scope. */
  readonly placeName: string | null;
  /** `null` when the incident has no position. Never a substitute fix. */
  readonly geo: { readonly lat: number; readonly lng: number; readonly accuracyM: number | null } | null;
  /** `r11_readLocationText` — the citizen's typed address. Absent when denied. */
  readonly locationText?: string | null;
  /** `r10_readReporterIdentity`. Absent when denied. */
  readonly reporterUid?: string;
  /** `r09_readOriginalText`. Absent when denied; `summary` carries the meaning. */
  readonly originalText?: string;
  /** The `readonly` AI panel. Absent unless `r13_readAiTriagePanel`. */
  readonly ai?: {
    readonly source: string;
    readonly confidence: number | null;
    readonly needsReview: boolean;
  };
  /** Only present for a scope that is deliberately narrowed. */
  readonly assigneeUid?: string | null;
};

export type ListIncidentsQuery = {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: readonly IncidentStatus[];
  readonly category?: readonly IncidentCategory[];
  readonly urgency?: readonly Urgency[];
};

export type ListIncidentsResult = {
  readonly items: readonly IncidentRow[];
  readonly page: AdminPage;
  readonly scope: IncidentScopeReport;
};

export type GetIncidentResult = {
  readonly incident: IncidentRow;
  readonly profile: 'full' | 'privileged' | 'responder' | 'owner' | 'none';
  readonly evidenceIds: readonly string[];
  readonly aiAnalysis: {
    readonly confidence: number | null;
    readonly needsReview: boolean;
    readonly category: IncidentCategory | null;
    readonly urgency: Urgency;
    readonly summary: string;
    readonly safetyFlags: readonly string[];
    readonly requiredResources: readonly string[];
  } | null;
};

/* ========================================================================== */
/* Serialization — the redaction boundary                                       */
/* ========================================================================== */

/**
 * The single place an incident becomes a response row.
 *
 * ---------------------------------------------------------------------------
 * THE REDACTION PROFILE IS COMPUTED PER ROW, NOT PER RESPONSE
 * ---------------------------------------------------------------------------
 * A list page mixes records: a dispatcher's page is full of other people's reports,
 * but one of them may be one they personally filed. Computing the profile once per
 * response would either over-redact that row (a dispatcher cannot read their own
 * report) or under-redact the rest. `redactionProfile` takes ownership into account
 * first, so per-row is the only correct granularity.
 *
 * `assigned` is passed through explicitly rather than being inferred, because the
 * caller already knows it from the query predicate it just ran.
 */
function toRow(
  doc: QueryDocumentSnapshot<DocumentData>,
  viewer: AuthedUser,
  assigned: boolean,
): IncidentRow {
  const data = doc.data();
  const reporterUid = readString(data, 'reporterUid', '');
  const profile = redactionProfile({ viewer, ownerUid: reporterUid || null, assigned });

  const geo = toGeoPoint(data.geo) ?? toGeoPoint({ lat: data.geo?.lat, lng: data.geo?.lng });

  const row: Record<string, unknown> = {
    incidentId: doc.id,
    reference: readString(data, 'reference'),
    status: readString(data, 'status') as IncidentStatus,
    category: (readString(data, 'category', '') || null) as IncidentCategory | null,
    urgency: readString(data, 'urgency') as Urgency,
    summary: readString(data, 'summary'),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    // `?? 0` is the honest default here in a way it is not for `peopleAffected`:
    // "no evidence" is a true statement about a report, whereas "nobody affected"
    // is an assertion about a rescue that we were never told.
    evidenceCount: readNumber(data, 'evidenceCount') ?? 0,
    reportCount: readNumber(data, 'reportCount') ?? 0,
    // `?? null`, NOT `?? 0` and not left as `undefined`. A nullable field that
    // arrives as `undefined` fails the response schema and turns a perfectly good
    // list into a 400, which is the worst possible failure for a read route: the
    // user sees an error instead of their own reports. `null` is also the honest
    // value — "nobody affected" is an assertion about a rescue we were never told.
    peopleAffected: readNumber(data, 'peopleAffected') ?? null,
    isDuplicate: readString(data, 'duplicateStatus', 'none') === 'possible',
    language: readString(data, 'language', 'en'),
    placeName: typeof data.geo?.placeName === 'string' ? data.geo.placeName : null,
    geo:
      geo === null
        ? null
        : { lat: geo.lat, lng: geo.lng, accuracyM: readNumber(data.geo ?? {}, 'accuracyM') },
  };

  // -------------------------------------------------------------------------
  // The three conditional fields. Each is gated, and each is OMITTED rather than
  // nulled so the client cannot mistake "withheld" for "empty".
  // -------------------------------------------------------------------------
  if (mayReadReporterIdentity(profile)) row.reporterUid = reporterUid;

  if (mayReadOriginalText(profile)) row.originalText = readString(data, 'originalText', '');

  if (mayReadLocationText(profile)) {
    const typed = readString(data, 'locationText', '') || readString(data, 'addressText', '');
    row.locationText = typed || null;
  }

  // The AI panel is a separate matrix row (`r13`), separate from the original-text
  // row. A responder may see the model's confidence without seeing the citizen's
  // words, so these two gates are independent by design.
  if (levelOf(viewer.role, 'r13_readAiTriagePanel') !== 'denied') {
    row.ai = {
      source: readString(data, 'triageSource', 'unknown'),
      // `?? null` for the same reason as `peopleAffected`: triage that never ran has
      // no confidence score, and `undefined` here fails the schema rather than
      // meaning "not scored".
      confidence: readNumber(data, 'aiConfidence') ?? null,
      needsReview: readBoolean(data, 'aiNeedsReview'),
    };
  }

  // The assignee is operational data, not personal data about the reporter, and
  // every scope that can see an incident has a legitimate reason to know who holds
  // it — including a citizen tracking their own report.
  if (profile !== 'none') row.assigneeUid = readString(data, 'assigneeUid', '') || null;

  return row as unknown as IncidentRow;
}

/* ========================================================================== */
/* Filters                                                                     */
/* ========================================================================== */

/**
 * The shared filter set, applied on top of whichever scope predicate is chosen.
 *
 * `deletedAt == null` is not optional and is not left to the caller: a soft-deleted
 * incident is one an operator has asked to disappear, and a list route that forgot
 * the filter once would be a data-retention incident.
 */
function baseFilters(
  query: ListIncidentsQuery,
  extra: readonly AdminFilter[],
): AdminFilter[] {
  return [
    ...(deletedFilter(undefined) ? [deletedFilter(undefined) as AdminFilter] : []),
    ...extra,
    ...(inFilter('status', query.status) ? [inFilter('status', query.status) as AdminFilter] : []),
    ...(inFilter('category', query.category) ? [inFilter('category', query.category) as AdminFilter] : []),
    ...(inFilter('urgency', query.urgency) ? [inFilter('urgency', query.urgency) as AdminFilter] : []),
  ];
}

/** The same fingerprint parts for every arm, so one cursor resumes them all. */
function fingerprintParts(
  query: ListIncidentsQuery,
  includes: readonly IncidentScopeComponent[],
): Record<string, unknown> {
  return {
    kind: 'incident-list',
    // The arms are in the fingerprint because a cursor from a differently-scoped
    // query must not be accepted here — otherwise a page boundary from a citizen's
    // list could be replayed into a dispatcher's.
    includes: [...includes],
    status: query.status ?? null,
    category: query.category ?? null,
    urgency: query.urgency ?? null,
  };
}

/* ========================================================================== */
/* List                                                                        */
/* ========================================================================== */

/**
 * One page of incidents, scoped to the caller.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE SCOPE SLICE IS ONE QUERY, MERGED
 * ---------------------------------------------------------------------------
 * Each slice is a disjunction arm, and Firestore has no `or`. The alternative was
 * to fold the arms into one query:
 *
 *   `assigneeUid in [me, null]` PLUS `geoCells array-contains-any [...]`
 *
 * which is WRONG, and wrong in the way that matters. That conjunction means
 * "assigned to me AND nearby" — so the incident I am personally assigned to, from
 * across town, vanishes from the panel that exists to tell me what is mine. A
 * responder would conclude they had no work while actively holding it.
 *
 * So each arm is its own query, all paging from the SAME cursor, merged and
 * re-sorted here. That over-fetches by at most one page per arm and is correct.
 * The re-sort is what makes it correct: every arm resumes past the shared boundary,
 * so the union is exactly the set after that boundary, and the first `limit` of the
 * merged order is the right page.
 */
export async function listIncidents(
  user: AuthedUser,
  query: ListIncidentsQuery,
): Promise<ListIncidentsResult> {
  // The one server-side fact that changes the scope. Read once, before the scope is
  // built, so the report and the predicates cannot disagree about whether the
  // responder had a position.
  const cells = can(user.role, 'r07_readUnassignedInRadius') ? await nearbyCellsFor(user) : null;
  const scope = scopeFor(user, cells !== null);
  const collection = getAdminDb().collection(COLLECTIONS.incidents);

  /** Run one arm of the union. */
  const run = async (extra: readonly AdminFilter[], assigned: boolean) =>
    runPagedQuery<IncidentRow>({
      collection,
      filters: baseFilters(query, extra),
      sort: ['createdAt', DOC_ID_TIEBREAK],
      limit: query.limit,
      cursor: query.cursor,
      fingerprintParts: fingerprintParts(query, scope.includes),
      serialize: (doc) =>
        toRow(
          doc,
          user,
          assigned || readString(doc.data(), 'assigneeUid', '') === user.uid,
        ),
    });

  // Ops: one query, no predicate. `all` already contains every other slice.
  if (scope.includes.includes('all')) {
    const page = await runPagedQuery<IncidentRow>({
      collection,
      filters: baseFilters(query, []),
      sort: ['createdAt', DOC_ID_TIEBREAK],
      limit: query.limit,
      cursor: query.cursor,
      fingerprintParts: fingerprintParts(query, scope.includes),
      serialize: (doc) =>
        toRow(doc, user, readString(doc.data(), 'assigneeUid', '') === user.uid),
    });
    return { items: page.items, page: page.page, scope };
  }

  const arms: Array<Promise<Awaited<ReturnType<typeof run>>>> = [];
  if (scope.includes.includes('own')) arms.push(run([{ field: 'reporterUid', op: '==', value: user.uid }], false));
  if (scope.includes.includes('assigned')) arms.push(run([{ field: 'assigneeUid', op: '==', value: user.uid }], true));
  if (scope.includes.includes('unassigned_nearby') && cells !== null) {
    arms.push(
      run(
        [
          { field: 'assigneeUid', op: '==', value: null },
          // All nine cells, not just the centre one. `buildGeoCells` returns the
          // 3x3 neighbourhood precisely so a responder at the edge of a cell still
          // matches incidents just over the boundary; querying only the centre
          // would drop them.
          { field: 'geoCells', op: 'array-contains-any', value: [...cells] },
        ],
        false,
      ),
    );
  }

  // No arm is possible only if the matrix granted nothing, which no role does — but
  // an empty array is the honest answer if it ever happened, not a query without
  // filters, which would return EVERY incident to a caller entitled to none.
  if (arms.length === 0) return { items: [], page: { limit: 0, hasMore: false, nextCursor: null }, scope };

  const pages = await Promise.all(arms);
  const merged = mergePaged(pages, query.limit);

  return { items: merged.items, page: merged.page, scope };
}

/**
 * Merge the arms, newest first, de-duplicated by id.
 *
 * The de-dupe keeps the FIRST occurrence, and `own` is pushed before `assigned`, so
 * a record that is both mine and assigned to me is rendered with the `assigned`
 * redaction profile. That is deliberate: `assigned` is the narrower profile, and
 * where two arms disagree the more restrictive rendering wins.
 */
function mergePaged(
  pages: ReadonlyArray<{ items: readonly IncidentRow[]; page: AdminPage }>,
  requestedLimit: number | undefined,
): { items: IncidentRow[]; page: AdminPage } {
  const seen = new Map<string, IncidentRow>();
  for (const page of pages) {
    for (const row of page.items) {
      if (!seen.has(row.incidentId)) seen.set(row.incidentId, row);
    }
  }

  const sorted = [...seen.values()].sort(byCreatedAtDesc);
  const limit = Math.min(requestedLimit ?? 25, 100);
  const items = sorted.slice(0, limit);

  // `hasMore` is the OR of the arms. AND-ing it would hide a second page that
  // exists in only one arm; OR-ing it errs toward offering an empty next page,
  // which is a worse mistake than offering a full one.
  const hasMore = pages.some((page) => page.page.hasMore) || sorted.length > limit;
  const nextCursor =
    hasMore ? (pages.map((page) => page.page.nextCursor).find((cursor) => cursor !== null) ?? null) : null;

  return { items, page: { limit, hasMore, nextCursor } };
}

/** Newest first. `null` sorts last, because an undated record is the least useful. */
function byCreatedAtDesc(a: IncidentRow, b: IncidentRow): number {
  if (a.createdAt === b.createdAt) return a.incidentId < b.incidentId ? 1 : -1;
  if (a.createdAt === null) return 1;
  if (b.createdAt === null) return -1;
  return a.createdAt < b.createdAt ? 1 : -1;
}

/**
 * The geocells around this responder, or `null` when they have no usable position.
 *
 * ---------------------------------------------------------------------------
 * STALENESS IS CHECKED, AND AN ABSENT POSITION IS NOT TREATED AS (0,0)
 * ---------------------------------------------------------------------------
 * A missing or stale location must produce `null`. Treating it as a coordinate —
 * especially the origin — would put the responder in the Gulf of Guinea, where
 * "incidents near you" is a confident, wrong, and quietly harmful answer: it hides
 * every real incident near them. `null` produces a narrower list and a sentence
 * explaining why, which is the correct failure.
 */
async function nearbyCellsFor(user: AuthedUser): Promise<string[] | null> {
  try {
    const snap = await getAdminDb().collection(COLLECTIONS.responderLocations).doc(user.uid).get();
    if (!snap.exists) return null;

    const data = snap.data() ?? {};
    // `stale` is written by the ingest path, which owns the staleness clock. We
    // read the flag rather than re-deriving it from a device timestamp we do not
    // trust — see the note on `receivedAt` in `services/dispatch/candidates.ts`.
    if (readBoolean(data, 'stale')) return null;

    const point = toGeoPoint(data.geo);
    if (point === null) return null;

    return buildGeoCells(point.lat, point.lng);
  } catch {
    // A failed location read must not fail the incident list. Same reasoning as
    // `services/dispatch/candidates.ts`: an incomplete distance beats no panel.
    return null;
  }
}

/* ========================================================================== */
/* Single record                                                               */
/* ========================================================================== */

/**
 * Is this document soft-deleted?
 *
 * `deletedAt` is written as an explicit `null` on live rows (invariant 1 in
 * `services/incidents/create.ts`), so the live case is `null` — not absent, not an
 * empty string. All three are tolerated here because this is a RETENTION decision
 * and the conservative answer for an unrecognised value is "treat as deleted". A
 * document with a `deletedAt` we cannot parse is one an operator asked to remove,
 * and showing it because we misread the format would defeat the deletion.
 */
function isSoftDeleted(data: Record<string, unknown>): boolean {
  const value = data.deletedAt;
  return value !== undefined && value !== null && value !== '';
}

/**
 * One incident, by id.
 *
 * ---------------------------------------------------------------------------
 * A RECORD YOU MAY NOT SEE IS A 404, NOT A 403
 * ---------------------------------------------------------------------------
 * A 403 on `/api/incidents/:id` confirms the incident exists. An attacker with a
 * list of candidate ids learns which ones are real, which is most of what they
 * wanted. So the scope predicate runs first and a non-matching document is
 * reported as `NOT_FOUND` — indistinguishable from an id that was never issued.
 *
 * The trade is that a genuine owner typo produces "not found" rather than "forbidden".
 * For a consumer tracking a report they hold the reference in their hand, so the
 * ambiguity costs a support ticket and the disclosure costs a privacy incident.
 */
export async function getIncident(user: AuthedUser, incidentId: string): Promise<GetIncidentResult> {
  const snap = await getAdminDb().collection(COLLECTIONS.incidents).doc(incidentId).get();
  if (!snap.exists) throw new AppError({ code: 'NOT_FOUND' });

  // `data()` is typed `DocumentData | undefined` even after an `exists` check, so
  // the empty object is a narrowing aid rather than a real "missing document" case:
  // the `exists` guard above already threw for that.
  const data = snap.data() ?? {};
  if (isSoftDeleted(data)) throw new AppError({ code: 'NOT_FOUND' });

  const reporterUid = readString(data, 'reporterUid', '');
  const assigneeUid = readString(data, 'assigneeUid', '');
  const assigned = assigneeUid !== '' && assigneeUid === user.uid;

  if (!maySeeIncident(user, reporterUid, assigned)) throw new AppError({ code: 'NOT_FOUND' });

  const profile = redactionProfile({ viewer: user, ownerUid: reporterUid || null, assigned });
  const evidenceIds = Array.isArray(data.evidenceIds)
    ? data.evidenceIds
        .filter((value): value is string => typeof value === 'string' && MEDIA_ID_RE.test(value))
        .slice(0, MEDIA_LIMITS.maxTotalPerReport)
    : [];
  const triageSource = readString(data, 'triageSource', 'unknown');
  const aiAnalysis =
    profile === 'owner' || levelOf(user.role, 'r13_readAiTriagePanel') !== 'denied'
      ? triageSource === 'ai'
        ? {
            confidence: readNumber(data, 'aiConfidence') ?? null,
            needsReview: readBoolean(data, 'aiNeedsReview'),
            category: (readString(data, 'category', '') || null) as IncidentCategory | null,
            urgency: readString(data, 'urgency') as Urgency,
            summary: readString(data, 'summary'),
            safetyFlags: readStringArray(data.safetyFlags, 20, 60),
            requiredResources: readStringArray(data.requiredResources, 20, 60),
          }
        : null
      : null;

  return {
    incident: toRow(snap as QueryDocumentSnapshot<DocumentData>, user, assigned),
    profile,
    evidenceIds,
    aiAnalysis,
  };
}

function readStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.slice(0, maxLength))
    .slice(0, maxItems);
}

/** The single-record scope test, mirroring `listIncidents`' scope derivation. */
function maySeeIncident(user: AuthedUser, reporterUid: string, assigned: boolean): boolean {
  if (can(user.role, 'r08_readAllIncidents')) return true;
  if (assigned) return true;
  // A reporter always sees their own record, whatever else the matrix says.
  if (reporterUid !== '' && reporterUid === user.uid) return true;
  // The `r07` in-radius case is intentionally NOT honoured here without the
  // position check that `listIncidents` performs. A single-record read has no
  // filter to narrow it, so honouring the capability here would be an
  // unfiltered read — the capability is about a RADIUS, and this is one record.
  return false;
}
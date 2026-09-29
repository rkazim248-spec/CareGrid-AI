/**
 * ============================================================================
 * CareGrid AI — scoped listener query builders
 * ============================================================================
 *
 * `docs/11 §2.1` **Rule R-2** and `docs/11 §6` QD-1 … QD-11. **CLIENT-SIDE.**
 *
 * ---------------------------------------------------------------------------
 * RULE R-2: A LISTENER QUERY IS BUILT HERE, NEVER INLINE
 * ---------------------------------------------------------------------------
 * > Listener queries are built by the scoped query helpers in
 * > `lib/firestore/queries.ts` (`queueQuery`, `incidentQuery`,
 * > `mapViewportQuery`, `notificationQuery`, …)
 *
 * A chained `.where().orderBy().limit()` inside an `onSnapshot` call is how a
 * listener ends up with no `limit`, no soft-delete filter, or an `orderBy` that
 * does not match a composite index. Each of those is a runtime failure on a
 * dispatcher's screen, not a build failure. Concentrating them here means the
 * invariants are checked once, by a test, against every query in the app.
 *
 * ---------------------------------------------------------------------------
 * THE `in`-SET WINDOWS COME FROM `lib/collections/enums.ts`
 * ---------------------------------------------------------------------------
 * So the status window a query filters on and the status window a test asserts
 * are the same array. Two copies would drift, and the drift would show up as a
 * resolved incident disappearing from a map.
 *
 * ---------------------------------------------------------------------------
 * FREE-TEXT SEARCH IS SERVER-SIDE, NOT `array-contains`
 * ---------------------------------------------------------------------------
 * `docs/11 §6` QD-10: "Free-text search uses `searchTokens`, never
 * `array-contains` on `originalText`."
 *
 * The reason is arithmetic, and it is why search is a `GET` rather than a
 * listener: `searchTokens` is ≤ 30 tokens, and Firestore's `array-contains-any`
 * accepts ≤ 30 values. A query with 30 tokens in the array and 30 requested
 * values is within the limit only by exactly zero, and a 31st token fails the
 * whole query. So the queue's search is a debounced parameter that produces a
 * **server** query, and the listener covers only the filterable window.
 *
 * ---------------------------------------------------------------------------
 * `deletedAt == null` IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * `docs/11 §6` QD-2: "the single most commonly forgotten filter". A soft-deleted
 * incident is retained for audit (`docs/07 §1.1`), so omitting this filter does
 * not look like a bug — it looks like an incident that has been open for two
 * years. `deletedAt` is written as `null`, not omitted, precisely so this
 * equality is possible.
 */

import {
  collection as fsCollection,
  doc as fsDoc,
  limit as fsLimit,
  orderBy as fsOrderBy,
  query as fsQuery,
  where as fsWhere,
  type DocumentReference,
  type Firestore,
  type Query,
  type QueryConstraint,
} from 'firebase/firestore';

import { COLLECTIONS, SUB_COLLECTIONS } from '@/config/collections';
import {
  LIVE_DISPATCH_STATUSES,
  OPEN_STATUSES,
  QUEUE_STATUS_WINDOW,
  SLA_TRACKED_STATUSES,
} from '@/lib/collections/enums';
import type { IncidentCategory, IncidentStatus, Urgency } from '@/types';

/* ========================================================================== */
/* The filter shapes                                                           */
/* ========================================================================== */

/**
 * The queue's filter set, already parsed and already clamped.
 *
 * A parsed shape rather than a raw query string, so a listener is never re-created
 * because the URL changed and rebuilt the same values. `features/incidents/
 * incident-filters.ts` owns the parsing; this owns the consumption.
 */
export type QueueFilters = {
  readonly urgency: readonly Urgency[];
  readonly category: readonly IncidentCategory[];
  readonly status: readonly IncidentStatus[];
  /** `true` / `false` / `null` for "any". `docs/11 §2.2` L1's assigned filter. */
  readonly assigned: boolean | null;
  /** Descending `updatedAt` or `createdAt`. L1 orders by last change. */
  readonly orderBy: 'updatedAt' | 'createdAt';
  /** The window size. Clamped by the caller to the registry's ceiling. */
  readonly limit: number;
};

/**
 * The default filter set.
 *
 * `status: QUEUE_STATUS_WINDOW` rather than `OPEN_STATUSES`: the queue is the
 * dispatcher's WORK, and a resolved incident is not work. The map uses the wider
 * set. This is the difference between the two listeners, and it is one line.
 */
export const DEFAULT_QUEUE_FILTERS: QueueFilters = {
  urgency: [],
  category: [],
  status: QUEUE_STATUS_WINDOW,
  assigned: null,
  orderBy: 'updatedAt',
  limit: 50,
};

/* ========================================================================== */
/* L1 — queue                                                                  */
/* ========================================================================== */

/**
 * `docs/11 §2.2` **L1**: `incidents` | `deletedAt == null`, `status in
 * ACTIVE_STATUSES`, plus the URL filter set | `updatedAt DESC` | 50.
 *
 * **Role-scoped (QD-4).** `role` is a required parameter, and the function
 * REFUSES for a non-ops role rather than building a query that would fail with
 * `permission-denied` on the first snapshot. `docs/11 §11.1` SEC-2: L1 is only
 * ever built for `dispatcher`/`admin`, because a citizen's client must not even
 * be *capable* of forming the dispatcher's query (SEC-6).
 */
export function queueQuery(
  db: FirestoreLike,
  input: { readonly role: 'dispatcher' | 'admin'; readonly filters: QueueFilters },
): Query {
  assertOpsRole(input.role, 'queueQuery');

  const ref = fsCollection(db, COLLECTIONS.incidents);
  const constraints: QueryConstraint[] = [
    // QD-2. Not optional, not "added later".
    fsWhere('deletedAt', '==', null),
  ];

  // The status window. `status` from the filters when set, else the live set. An
  // empty `status` array is replaced by the default rather than producing
  // `in []`, which Firestore rejects.
  const statuses = input.filters.status.length > 0 ? input.filters.status : QUEUE_STATUS_WINDOW;
  constraints.push(fsWhere('status', 'in', [...statuses]));

  if (input.filters.urgency.length > 0) {
    constraints.push(fsWhere('urgency', 'in', [...input.filters.urgency]));
  }
  if (input.filters.category.length > 0) {
    constraints.push(fsWhere('category', 'in', [...input.filters.category]));
  }
  if (input.filters.assigned !== null) {
    // Two different queries, because Firestore has no `!= null` on a nested path
    // that means "has an assignee". `null` is the explicit unassigned value.
    constraints.push(
      input.filters.assigned
        ? fsWhere('assigneeUid', '!=', null)
        : fsWhere('assigneeUid', '==', null),
    );
  }

  // QD-7: ONE range/order field. The filters above are all equalities or `in`, so
  // this is the only inequality and the query is legal.
  constraints.push(fsOrderBy(input.filters.orderBy, 'desc'));
  // QD-1: ALWAYS a limit.
  constraints.push(fsLimit(input.filters.limit));

  return fsQuery(ref, ...constraints);
}

/* ========================================================================== */
/* L2a / L2b — one incident and its history                                    */
/* ========================================================================== */

/**
 * `docs/11 §2.2` **L2a**: `incidents/{id}`, no `where` needed (the rules gate it),
 * `limit` 1. **Any role** — a citizen tracking their own report and a dispatcher
 * reading the same document take the same query, and the rules are what
 * distinguish them. That is deliberate: a client-side role filter here would be a
 * second, weaker copy of `canRead()`.
 */
/**
 * `docs/11 §2.2` **L2a** returns a `DocumentReference`, not a `Query`.
 *
 * That is the correct Firestore idiom rather than a shortcut: `onSnapshot` accepts
 * a `DocumentReference` directly, and a single-document listener cannot be
 * unbounded or over-limited — it matches exactly one document or none. QD-1's
 * "always a `limit()`" is therefore satisfied trivially here, which is worth
 * stating because a reader checking every builder for a `limit()` will not find
 * one in this function.
 *
 * The registry still declares `limit: 1` for L2a, so the budget accounting and the
 * cost estimator treat it consistently with the other ten.
 */
export function incidentQuery(db: FirestoreLike, incidentId: string): DocumentReference {
  return fsDoc(db, COLLECTIONS.incidents, incidentId);
}

/**
 * `docs/11 §2.2` **L2b**: `incidents/{id}/statusHistory`, `createdAt DESC`, limit
 * 50.
 *
 * **The only subcollection listener** permitted by QD-9, on the detail page only.
 * The limit is 50 rather than unbounded because an incident with 400 status events
 * is a data problem, and a listener that delivers 400 documents to render a
 * timeline is a cost problem. The oldest events are reachable by the paginated
 * API.
 *
 * `createdAt DESC` matches `docs/07 §6`'s `collectionGroup("statusHistory")`
 * timeline order and needs no composite index beyond the implicit single field.
 */
export function incidentHistoryQuery(db: FirestoreLike, incidentId: string): Query {
  return fsQuery(
    fsCollection(db, COLLECTIONS.incidents, incidentId, SUB_COLLECTIONS.statusHistory),
    fsOrderBy('createdAt', 'desc'),
    fsLimit(50),
  );
}

/* ========================================================================== */
/* L3 / L4 — the map                                                           */
/* ========================================================================== */

/**
 * `docs/11 §2.2` **L3**: `geoCells array-contains <cell>`, `deletedAt == null`,
 * `status in OPEN_STATUSES` | `updatedAt DESC` | 150.
 *
 * **The 3x3 block is resolved by the CALLER, not here.** `lib/geo/geohash.ts`'s
 * `buildGeoCells` already returns the 9 cells around a point, and Phase 6 built it
 * precisely so this query is one `array-contains` rather than nine. Passing nine
 * cells in and doing nine queries here would undo that.
 *
 * The viewport is a **single cell**, not nine, and that is the honest limit: a
 * listener cannot watch nine cells without nine indexes and nine channels. The
 * caller picks the cell containing the viewport centre, and the map's
 * `viewportCells` / 25 km span check decide when a cell is too coarse to use —
 * which is Phase 6's already-tested logic, reused rather than reimplemented.
 */
export function mapViewportQuery(
  db: FirestoreLike,
  input: { readonly cell: string; readonly limit: number },
): Query {
  return fsQuery(
    fsCollection(db, COLLECTIONS.incidents),
    fsWhere('geoCells', 'array-contains', input.cell),
    fsWhere('deletedAt', '==', null),
    fsWhere('status', 'in', [...OPEN_STATUSES]),
    fsOrderBy('updatedAt', 'desc'),
    fsLimit(input.limit),
  );
}

/**
 * `docs/11 §2.2` **L4**: `responderLocations` | `status != offline` |
 * `capturedAt DESC` | 150. **dispatcher/admin only.**
 *
 * **`!=` rather than `not-in`**, and that is a correctness decision rather than a
 * style one: Firestore's `!=` excludes documents **missing** the field, and a
 * `responderLocations` document written before `status` was denormalised onto it
 * would silently vanish from the dispatcher's map. A dispatcher who cannot see a
 * responder is worse than one who sees them with an unknown status.
 *
 * The security consequence is checked in the hook, not here: a responder calling
 * this gets a thrown `ListenerRoleError` before any query is built, because
 * `docs/11 §11.1` puts `responderLocations` at "own doc" for a responder and
 * precise location is the one field brief §10 protects.
 */
export function responderLocationQuery(
  db: FirestoreLike,
  input: { readonly role: 'dispatcher' | 'admin'; readonly limit: number },
): Query {
  assertOpsRole(input.role, 'responderLocationQuery');
  return fsQuery(
    fsCollection(db, COLLECTIONS.responderLocations),
    // The value is a LITERAL, not `NON_OFFLINE_STATUSES`, and that is deliberate:
    // Firestore's `!=` takes a single value, so an `in`-set cannot be expressed.
    // `lib/collections/enums.ts` documents the two-value complement
    // (`available | busy`) and a security check asserts this literal is exactly
    // the complement of `RESPONDER_STATUS_SET` — so the duplication is pinned
    // rather than free.
    fsWhere('status', '!=', 'offline'),
    fsOrderBy('capturedAt', 'desc'),
    fsLimit(input.limit),
  );
}

/* ========================================================================== */
/* L5 / L6 / L7 / L10 — the per-user listeners                                 */
/* ========================================================================== */

/**
 * `docs/11 §2.2` **L5**: `notifications` | `recipientUid == uid` (only, never
 * widened) | `createdAt DESC` | 50.
 *
 * **SEC-4: there is no parameter to widen it.** Not a default that could be
 * overridden, not an option that defaults to own — no parameter exists. A
 * `?recipientUid=` in the client path would be a `permission-denied` waiting to
 * happen, and a rule change that accidentally permitted it would be invisible.
 * The only argument is the caller's own uid.
 */
export function notificationQuery(db: FirestoreLike, uid: string): Query {
  return fsQuery(
    fsCollection(db, COLLECTIONS.notifications),
    fsWhere('recipientUid', '==', uid),
    fsOrderBy('createdAt', 'desc'),
    fsLimit(50),
  );
}

/**
 * `docs/11 §2.2` **L6**: `dispatches` | `responderUid == uid`, `status in
 * ['active','accepted']` | `dispatchedAt DESC` | 20.
 *
 * The two-value status set is `LIVE_DISPATCH_STATUSES`, so a responder's
 * dashboard does not hold a live channel on a dispatch withdrawn an hour ago.
 */
export function responderDispatchQuery(db: FirestoreLike, uid: string): Query {
  return fsQuery(
    fsCollection(db, COLLECTIONS.dispatches),
    fsWhere('responderUid', '==', uid),
    fsWhere('status', 'in', [...LIVE_DISPATCH_STATUSES]),
    fsOrderBy('dispatchedAt', 'desc'),
    fsLimit(20),
  );
}

/**
 * `docs/11 §2.2` **L7**: `users/{uid}`, limit 1, on the `(app)` shell.
 *
 * The role MIRROR for the nav and the route guards. `docs/11 §11.3` SEC-3 calls it
 * a mirror deliberately: the authoritative role is the server's claim, and this
 * document exists so the shell does not have to re-fetch it on every navigation.
 * It is never trusted for an authorisation decision — the Firestore rules are
 * server-side and re-read the real claim.
 */
export function sessionUserQuery(db: FirestoreLike, uid: string): DocumentReference {
  return fsDoc(db, COLLECTIONS.users, uid);
}

/**
 * `docs/11 §2.2` **L10**: `responderLocations/{uid}`, limit 1 — the heartbeat
 * CONFIRMATION indicator.
 *
 * This is the only listener with `includeMetadataChanges: true` on the responder
 * side, because it is the one place a client writes its own location and the UI
 * must distinguish "written, not yet received" from "received"
 * (`docs/11 §3.3`).
 */
export function ownLocationQuery(db: FirestoreLike, uid: string): DocumentReference {
  return fsDoc(db, COLLECTIONS.responderLocations, uid);
}

/* ========================================================================== */
/* L8 / L9 — the ops aggregates                                                */
/* ========================================================================== */

/**
 * `docs/11 §2.2` **L8**: `incidents` | `deletedAt == null`, `status in
 * ACTIVE_STATUSES` | `updatedAt DESC` | 20. **dispatcher/admin only.**
 *
 * **The 20-document window is the honest limit, and `docs/11` §14 RT-DR-3 says so
 * directly**: "the risk of presenting a window-derived count as a platform count
 * (finding F2)". So the returned tile carries `isWindowDerived: true` and a
 * label saying so. A dispatcher who sees "23 active" and a dispatcher who sees
 * "23 active, from the 20 most recently updated" are being told different things,
 * and only the second is true when there are 400 active incidents.
 *
 * 20 rather than 50 because L1 already holds 50 of the same set: a larger L8 would
 * be paying twice for documents L1 has. The 20 most-recently-updated are the ones
 * whose change is most likely to matter.
 */
export function kpiQuery(db: FirestoreLike, input: { readonly role: 'dispatcher' | 'admin' }): Query {
  assertOpsRole(input.role, 'kpiQuery');
  return fsQuery(
    fsCollection(db, COLLECTIONS.incidents),
    fsWhere('deletedAt', '==', null),
    fsWhere('status', 'in', [...QUEUE_STATUS_WINDOW]),
    fsOrderBy('updatedAt', 'desc'),
    fsLimit(20),
  );
}

/**
 * `docs/11 §2.2` **L9**: `incidents` | `deletedAt == null`, `slaBreachedAt == null`,
 * `status in […]` | limit 20. **dispatcher/admin only.**
 *
 * `slaBreachedAt == null` is the "not yet breached" filter, and
 * `SLA_TRACKED_STATUSES` excludes `new`/`triaged` because an unverified incident
 * has no SLA clock running (`docs/07 §4` sets `slaTargetMin` at verification).
 *
 * `includeMetadataChanges` is **OFF** here (`docs/11 §3.3`) and that is
 * load-bearing: a pending breach must never render, because the SLA clock is the
 * server's and a locally-optimistic breach would put a false deadline in front of
 * a dispatcher.
 */
export function slaSweepQuery(db: FirestoreLike, input: { readonly role: 'dispatcher' | 'admin' }): Query {
  assertOpsRole(input.role, 'slaSweepQuery');
  return fsQuery(
    fsCollection(db, COLLECTIONS.incidents),
    fsWhere('deletedAt', '==', null),
    fsWhere('slaBreachedAt', '==', null),
    fsWhere('status', 'in', [...SLA_TRACKED_STATUSES]),
    fsOrderBy('verifiedAt', 'desc'),
    fsLimit(20),
  );
}

/* ========================================================================== */
/* The role guard                                                              */
/* ========================================================================== */

export class ListenerRoleError extends Error {
  constructor(
    readonly listener: string,
    readonly role: string,
  ) {
    super(
      `Listener "${listener}" is dispatcher/admin only; the current role is "${role}". ` +
        `Refused before the query was built (docs/11 §6 QD-4, §11.1 SEC-2).`,
    );
    this.name = 'ListenerRoleError';
  }
}

/**
 * The client-side role guard for the ops-only queries.
 *
 * **This is UX protection, not a security boundary, and the distinction is the
 * point.** `docs/11 §11.1` SEC-2 and brief §18 both require that a citizen's
 * client is not even *capable* of forming a dispatcher's query — which is about
 * not shipping the ability to ask, not about preventing the request. The real
 * boundary is `firestore.rules`, which re-evaluates the ID token's claim on the
 * server and would deny this query whether or not this function existed.
 *
 * So the guard exists to turn a `permission-denied` on the first snapshot (an
 * error the user sees) into a refusal at build time (a clear bug in the console),
 * and the message says so rather than implying it is protecting anything.
 */
function assertOpsRole(role: string, listener: string): asserts role is 'dispatcher' | 'admin' {
  if (role !== 'dispatcher' && role !== 'admin') {
    throw new ListenerRoleError(listener, role);
  }
}

/* ========================================================================== */
/* The narrow db type                                                          */
/* ========================================================================== */

/**
 * The builders take the real `Firestore`, not a structural subset.
 *
 * The first draft declared a `FirestoreLike` with `collection` and `doc` methods
 * so a test could pass a fake. That does not work in firebase 11, where the public
 * `Firestore` class exposes NO instance methods in its type — the API is the free
 * functions `collection(db, path, …)` and `doc(db, path, …)` — so a structural
 * subset could never be satisfied by the real client.
 *
 * Using the real type is also more honest about what is being tested. A fake that
 * implements `collection()` proves the *call sequence*; it does not prove the
 * query is constructible. `docs/11 §12` wants listener assertions against the
 * Firestore Emulator Suite, and that suite hands these builders a real `Firestore`
 * anyway.
 */
export type FirestoreLike = Firestore;

/** Re-exported so a test can assert the produced constraints' types. */
export type { Query, QueryConstraint, DocumentReference };

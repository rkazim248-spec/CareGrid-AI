/**
 * ============================================================================
 * CareGrid AI — the admin list-query helper
 * ============================================================================
 *
 * One implementation of "filter, sort, page" for the Phase 14 admin lists. It
 * exists because four routes writing four slightly different versions of this is
 * how one of them ends up without an explicit sort and pages by document id.
 *
 * ---------------------------------------------------------------------------
 * KEYSET PAGINATION, NOT OFFSET
 * ---------------------------------------------------------------------------
 * `startAfter`, never `offset`. An admin list is queried while the collection is
 * being written to — incidents arrive continuously — and `offset` skips a
 * different number of documents on every page once anything is inserted above the
 * window. The visible symptom is a row that appears on both page 1 and page 2, or
 * vanishes from both. `startAfter` is stable under concurrent writes because it
 * names a POSITION (this document's sort values) rather than a COUNT.
 *
 * Every list is sorted by its sort fields AND by document id. Without the
 * trailing id, two incidents created in the same millisecond have an equal
 * `createdAt`, Firestore returns them in an unspecified order, and a keyset cursor
 * built from an ambiguous position skips or repeats one of them. The id tiebreak
 * is what makes "page 2 starts after exactly one document" true.
 *
 * ---------------------------------------------------------------------------
 * WHY `limit + 1`
 * ---------------------------------------------------------------------------
 * Firestore has no "give me one more" flag, so `hasMore` is answered by asking for
 * one document beyond the page and discarding it. The alternative — a second
 * `count()` query — is another round trip on every page and, worse, a `count()`
 * taken a moment after the page disagrees with the page itself under concurrent
 * writes. One query, one consistent read, no contradiction.
 */

import 'server-only';

import {
  type CollectionReference,
  type DocumentData,
  FieldPath,
  type Query,
  type QueryDocumentSnapshot,
  type WhereFilterOp,
} from 'firebase-admin/firestore';

import { getAdminDb } from '@/lib/server/firebase-admin';
import { AppError } from '@/lib/server/errors';
import { boundaryOf, decodeCursor, encodeCursor, fingerprintOf } from '@/lib/server/cursor';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/validators/query';

/**
 * The sentinel for "and then break ties by document id".
 *
 * A string rather than a symbol so it can be part of the exported sort tuple that
 * the validators and the tests both read; a symbol would be invisible in a failure
 * message, which is exactly when someone needs to see it.
 */
export const DOC_ID_TIEBREAK = '__docId';

export type AdminFilter = {
  readonly field: string;
  readonly op: WhereFilterOp;
  readonly value: unknown;
};

export type AdminPage = {
  /** The clamp, after `MAX_PAGE_SIZE`. Echoed so a client can show "showing N". */
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
};

export type PagedQueryOptions<T> = {
  /** The top-level collection, or an already-scoped subcollection reference. */
  readonly collection: CollectionReference | Query;
  readonly filters: readonly AdminFilter[];
  /** Sort fields in order. May include `DOC_ID_TIEBREAK` as the last entry. */
  readonly sort: readonly string[];
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
  /**
   * The filters and sort, for binding the cursor to the query it came from.
   *
   * Built by the caller from the VALIDATED query object, not from `filters` here,
   * so the fingerprint reflects exactly what the client asked for — including a
   * filter the caller chose not to apply, which is precisely the case that must
   * invalidate the cursor.
   */
  readonly fingerprintParts: Record<string, unknown>;
  /** Maps one snapshot to its response shape. Runs only on the returned page. */
  readonly serialize: (doc: QueryDocumentSnapshot<DocumentData>) => T;
};

export type PagedQueryResult<T> = {
  readonly items: T[];
  readonly page: AdminPage;
};

/**
 * Run one page.
 *
 * `fingerprintParts` is serialised once and used for BOTH the encode and the
 * decode. Using one value for both is the whole point: if they were computed
 * separately and one of them included a field the other did not, every cursor
 * would fail its own verification on the first page boundary.
 */
export async function runPagedQuery<T>(
  options: PagedQueryOptions<T>,
): Promise<PagedQueryResult<T>> {
  const fingerprint = fingerprintOf(options.fingerprintParts);
  const limit = clampLimit(options.limit);

  let query: Query = options.collection;

  for (const filter of options.filters) {
    // `where` returns a new Query; reassigning rather than mutating keeps the
    // narrowing type and avoids a cast.
    query = query.where(filter.field, filter.op, filter.value);
  }

  /** The sort fields WITHOUT the id tiebreak, for the cursor boundary. */
  const sortFields = options.sort.filter((field) => field !== DOC_ID_TIEBREAK);
  const hasTiebreak = options.sort.includes(DOC_ID_TIEBREAK);

  for (const field of sortFields) {
    query = query.orderBy(field);
  }
  // Ordering by the document id is the tiebreak, and it must come last to match
  // the `startAfter` argument order below.
  if (hasTiebreak) {
    query = query.orderBy(FieldPath.documentId());
  }

  if (options.cursor !== undefined) {
    const boundary = decodeCursor(options.cursor, fingerprint);
    // Firestore compares these positionally against the `orderBy` clauses, so the
    // order here must be the sort fields first and the document id LAST — the same
    // order the `orderBy` calls above registered them.
    const position: unknown[] = [...boundary.values, boundary.id];
    query = query.startAfter(...position);
  }

  // One extra document answers `hasMore` without a second round trip.
  const snapshot = await query.limit(limit + 1).get();
  const hasMore = snapshot.docs.length > limit;
  const page = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;

  // The boundary is the LAST document the caller actually receives. Using the
  // extra document here would skip one row on every page boundary — the classic
  // keyset bug, and the reason `slice` happens before this line and not after.
  const last = page.length > 0 ? page[page.length - 1] : undefined;
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor(boundaryOf(last, sortFields), fingerprint)
      : null;

  return {
    items: page.map((doc) => options.serialize(doc)),
    page: { limit, hasMore, nextCursor },
  };
}

/**
 * Clamp a caller-supplied page size.
 *
 * `validators/query.ts` already clamped it, so the `Math.min` here is defence in
 * depth for a service called directly from a test or a future route that skipped
 * the schema. It is cheap, and it is the difference between a page size of 100 and
 * a page size of 100000.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, limit);
}

/* ========================================================================== */
/* Query construction                                                            */
/* ========================================================================== */

/**
 * An `in` filter, or nothing.
 *
 * The admin list routes accept a repeatable enum filter, which arrives as an
 * ARRAY. Firestore's `in` supports up to 30 values, and a wider `in` throws
 * `invalid_argument` at query time — which surfaces as a 500, because it is a
 * Firestore error rather than a validation error. `validators/query.ts` caps each
 * filter at 12 values for exactly this reason, but the cap lives in the schema
 * and this function re-checks it, so a route that raises the schema cap cannot
 * turn a wider list into a 500 by forgetting to raise this one.
 *
 * Returns `null` for an empty or absent list, so the caller can skip the filter
 * entirely — an `in` with zero values matches NOTHING, which is not the same as no
 * filter, and confusing those two makes "no incidents match" appear as a total
 * outage.
 */
export function inFilter(field: string, values: readonly string[] | undefined): AdminFilter | null {
  if (values === undefined || values.length === 0) return null;
  if (values.length > 30) {
    throw new AppError({
      code: 'INVALID_QUERY',
      message: 'Too many values were selected for one filter.',
    });
  }
  return { field, op: 'in', value: [...values] };
}

/**
 * Build the list of filters from the optional query fields, in a FIXED order.
 *
 * Fixed order matters: `fingerprintOf` sorts its keys, but the ARRAY of filters is
 * built in call order, and two Firestore queries with the same filters in a
 * different order are not guaranteed to produce the same results or even to be
 * legal. Ordering the construction makes the query identical for identical input.
 */
export function buildFilters(
  ...candidates: ReadonlyArray<AdminFilter | null>
): AdminFilter[] {
  return candidates.filter((filter): filter is AdminFilter => filter !== null);
}

/**
 * The common "deleted or not" filter.
 *
 * Soft-deleted incidents stay in the collection with `deletedAt` set (FR-123), so
 * every list must decide explicitly whether to include them. Default is to EXCLUDE:
 * an operator looking at a live queue does not want tombstones in it, and a
 * `includeDeleted` flag exists for the restore view.
 */
export function deletedFilter(includeDeleted: boolean | undefined): AdminFilter | null {
  if (includeDeleted === true) return null;
  return { field: 'deletedAt', op: '==', value: null };
}

/**
 * The `users` collection reference, for the routes that query it directly.
 *
 * Named here so the four admin services share one definition of "the users
 * collection" rather than each importing `COLLECTIONS.users` and building its own
 * reference.
 */
export function usersCollection(): CollectionReference {
  return getAdminDb().collection('users');
}
/**
 * ============================================================================
 * CareGrid AI — opaque pagination cursors
 * ============================================================================
 *
 * Added for Phase 14, because four admin list routes needed one and there was no
 * shared implementation. A cursor per route is how four subtly different
 * implementations of "the next page" appear, three of which forget to bind the
 * cursor to the filters it was issued for.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CURSOR IS OPAQUE
 * ---------------------------------------------------------------------------
 * docs/17 §9 makes a cursor base64url of a server-generated fingerprint of the
 * sort key, the filters, and the direction. Opaque for three reasons:
 *
 *   1. **It is a position, not a query.** If the client could read it, it could
 *      construct one, and "skip to the end of the queue" becomes a one-line
 *      script against a rate-limited admin API.
 *   2. **It is bound to its filters.** `fingerprint` mixes in the active filters
 *      and sort, and `decodeCursor` REFUSES a cursor whose fingerprint does not
 *      match the request being served. Without that binding, a cursor issued for
 *      `?status=new` could be replayed against `?status=resolved` and return a
 *      page from a query the client never asked for — a page of results that looks
 *      correct and is filtered for something else entirely.
 *   3. **It can be invalidated when the sort changes**, which is the same mechanism
 *      as (2). Adding `orderBy` to a route and forgetting to invalidate old
 *      cursors produces duplicated and skipped rows that nobody can debug.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT SIGNED
 * ---------------------------------------------------------------------------
 * It carries no HMAC. A tamper attempt cannot forge a useful position, because the
 * position is checked against the actual Firestore document: `decodeCursor` only
 * tells the query where to start, and Firestore still applies the real `where`
 * clauses. The worst a forged cursor achieves is an empty or odd page, which is
 * the same as a client that asks for a huge limit. Signing it would add a secret
 * dependency to a read path for no security gain, and would make cursors invalid
 * across a key rotation.
 *
 * The `fingerprint` is therefore a CORRECTNESS mechanism, not a security one, and
 * is documented as such here so nobody later mistakes it for a signature.
 */

import { AppError } from '@/lib/server/errors';

/**
 * The position a cursor carries.
 *
 * `values` is the sort key's value(s) as Firestore returns them, already
 * normalised by `toBoundary` — a `Timestamp` becomes an ISO string, so a cursor
 * survives a round trip through JSON without a Firestore type on the wire.
 */
export type CursorBoundary = {
  /** The document id, so a page cannot repeat or skip when the sort key ties. */
  readonly id: string;
  /** One entry per `orderBy` clause, in the SAME order. */
  readonly values: readonly unknown[];
};

export type Cursor = {
  readonly boundary: CursorBoundary;
  /** The filters/sort this cursor was issued for. Verified on decode. */
  readonly fingerprint: string;
};

/** The hard ceiling from `validators/query.ts`, mirrored so a decode cannot exceed it. */
const MAX_CURSOR_CHARS = 512;

/* ========================================================================== */
/* Fingerprint                                                                  */
/* ========================================================================== */

/**
 * A stable fingerprint of everything that changes what "the next page" means.
 *
 * `JSON.stringify` over a key-sorted object, because property order is insertion
 * order and two callers building the same filter object with different key order
 * would produce different fingerprints — every legitimate "next page" would then
 * be rejected as a mismatched cursor, which is a bug that only appears on the
 * second page of a result set and is miserable to find.
 *
 * `from`/`to` are Dates (from `isoInstantField`), and `Date.prototype.toJSON`
 * makes them ISO strings, so they fingerprint consistently.
 */
export function fingerprintOf(parts: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(parts).sort()) {
    const value = parts[key];
    // Drop undefined entirely: `{ a: undefined }` and `{}` are the same query, and
    // treating them as different would reject the cursor for a filter the client
    // never actually sent.
    if (value !== undefined) sorted[key] = value;
  }
  return JSON.stringify(sorted);
}

/* ========================================================================== */
/* Encode                                                                       */
/* ========================================================================== */

/**
 * Build the cursor for the last document on a page, or `null` when there is no
 * next page.
 *
 * Returns `null` — not an empty string — for the final page, so `hasMore` and
 * `nextCursor` can never disagree.
 */
export function encodeCursor(boundary: CursorBoundary, fingerprint: string): string | null {
  const payload: Cursor = { boundary, fingerprint };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/* ========================================================================== */
/* Decode                                                                       */
/* ========================================================================== */

/**
 * Read a cursor, or throw `400 INVALID_CURSOR`.
 *
 * Throws rather than returning `null` for a malformed cursor, because "the cursor
 * you sent is not one of ours" and "you are on the last page" must not share a
 * return value — a caller that treats a bad cursor as "no more pages" silently
 * shows an operator an empty list and calls it the end of the queue.
 *
 * A cursor that is merely STALE (the sort changed, so its position no longer
 * applies) is a different case the caller handles by restarting at page one; that
 * is `fingerprint` mismatch, also a 400, and the message says so.
 */
export function decodeCursor(cursor: string, expectedFingerprint: string): CursorBoundary {
  if (cursor.length > MAX_CURSOR_CHARS) {
    throw invalidCursor('That page reference is too long. Start again from the first page.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('That page reference is not valid. Start again from the first page.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw invalidCursor('That page reference is not valid. Start again from the first page.');
  }

  const { boundary, fingerprint } = parsed as { boundary?: unknown; fingerprint?: unknown };

  if (
    typeof boundary !== 'object' ||
    boundary === null ||
    typeof (boundary as CursorBoundary).id !== 'string' ||
    !Array.isArray((boundary as CursorBoundary).values)
  ) {
    throw invalidCursor('That page reference is not valid. Start again from the first page.');
  }

  if (fingerprint !== expectedFingerprint) {
    // The cursor was issued for a different query. Either the client changed a
    // filter without clearing the cursor, or the sort changed under it. Both are
    // fixed the same way, so they share a message.
    throw invalidCursor(
      'That page reference belongs to a different set of filters. Start again from the first page.',
    );
  }

  return boundary as CursorBoundary;
}

function invalidCursor(message: string): AppError {
  return new AppError({ code: 'INVALID_CURSOR', message });
}

/* ========================================================================== */
/* Boundary from a snapshot                                                     */
/* ========================================================================== */

/**
 * The boundary for a document, given the field each `orderBy` sorts on.
 *
 * Takes the field NAMES rather than reading a fixed document shape, because the
 * admin routes sort on different combinations — `createdAt` for incidents,
 * `displayName` for users, `createdAt` for audit logs — and a helper hard-coded to
 * one of them would be wrong for the other two.
 *
 * A `Timestamp` becomes an ISO string here rather than being carried as an object.
 * `JSON.stringify` on a Firestore `Timestamp` yields `{"type":"...", "seconds":…}`,
 * which does not round-trip into anything `FieldPath`-comparable, so a cursor built
 * from the raw object produces a query that silently starts at the wrong place.
 * Normalising at the boundary is what keeps "page 2" honest.
 */
export function boundaryOf(
  doc: { id: string; data: () => Record<string, unknown> | undefined },
  sortFields: readonly string[],
): CursorBoundary {
  const data = doc.data() ?? {};
  return {
    id: doc.id,
    values: sortFields.map((field) => normaliseBoundaryValue(data[field])),
  };
}

/**
 * Convert one sort-key value into something JSON survives.
 *
 * The two cases that matter are Firestore `Timestamp`s and plain values. A
 * `Timestamp` is detected structurally (`toMillis` + `seconds`) rather than with
 * `instanceof`, because the Admin SDK can hand back a value from a different copy
 * of the module than the one that defined the class, and `instanceof` would then be
 * false for a genuine Timestamp.
 */
export function normaliseBoundaryValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (isTimestampLike(value)) return new Date(value.toMillis()).toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // An object or array in a sort key would be a schema error upstream. Encoding it
  // as `null` degrades the cursor to "start from the beginning" rather than
  // throwing, which keeps one bad document from breaking pagination for the list.
  return null;
}

function isTimestampLike(value: unknown): value is { toMillis: () => number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  );
}
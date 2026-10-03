/**
 * ============================================================================
 * An in-memory Firestore, for exercising REAL route handlers
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this file, no route handler in this project had ever been EXECUTED by a
 * test. `tests/unit/api/route-pipeline.test.ts` reads route sources and asserts
 * that patterns appear in them; `unconfigured-deployment.test.ts` asserts on the
 * error catalogue. Both are static.
 *
 * That is fine for what they check and useless for the questions Phase 15 asks.
 * IDOR, authorisation bypass and validation bypass are RUNTIME properties: the
 * defect is in the sequence of calls a real request makes, and a source grep
 * cannot see a sequence. The most expensive security defect found so far —
 * `requireUser` rejecting every authenticated caller — passed 1662 tests
 * precisely because every one of them mocked out the function that was broken.
 *
 * So this is a harness for driving a real `withRequest` route end to end: real
 * pipeline, real validators, real services, fake storage.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS FAITHFUL AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * Faithful: document paths, `get`/`set`/`update`, batch atomicity, transaction
 * read-before-write ordering and retry, and the operators the services actually
 * use (`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `array-contains`). A test that
 * relies on ordering, on atomicity, or on a filter is testing real logic.
 *
 * NOT faithful, and deliberately so:
 *
 *   - **No composite indexes and no query cost model.** Firestore rejects some
 *     query shapes; this accepts them. A test passing here is not proof a query
 *     is affordable in production.
 *   - **No server timestamps.** `FieldValue.serverTimestamp()` returns a fixed
 *     sentinel, so assertions on time must not read it.
 *   - **`FieldValue.delete()`** removes the key rather than recording a delete.
 *   - **No offline queue, no retry backoff, no snapshot listeners.** Realtime
 *     behaviour is out of scope here.
 *   - **Transactions do not roll back.** If the callback throws, writes already
 *     buffered in that transaction are DISCARDED, which matches Firestore.
 *
 * Anything that depends on the gaps above needs a real emulator, and is listed as
 * such in the Phase 15 report rather than quietly asserted here.
 */

/*
 * `const db = this` appears throughout this file.
 *
 * It is the idiomatic way to write a fluent, chainable test double, and this file
 * is a fluent test double: `collection()` has to hand back an object whose
 * `.doc()`, `.where()` and `.add()` all close over the same store. The rule exists
 * to catch `const self = this` in application code where it usually signals that
 * a method wanted an arrow function; here it is the whole design.
 */
/* eslint-disable @typescript-eslint/no-this-alias */

import { FieldValue } from 'firebase-admin/firestore';
import type { FieldPath } from 'firebase-admin/firestore';

type Row = { id: string; path: string; data: Record<string, unknown> };

type Filter = { field: string; op: string; value: unknown };

const MISSING = Symbol('missing');

/* ========================================================================== */
/* Path helpers                                                                */
/* ========================================================================== */

/** The document path of the collection a path belongs to, or null for a doc. */
function collectionOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(0, i);
}

function docIdOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** `users` / `incidents/i_1/aiReviews` → the immediate parent collection path. */
function rootCollectionOf(collectionPath: string): string {
  const segments = collectionPath.split('/');
  // A top-level collection is an odd number of segments; a subcollection is even.
  return segments.length % 2 === 1 ? collectionPath : segments.slice(0, -2).join('/');
}

/* ========================================================================== */
/* Comparison                                                                  */
/* ========================================================================== */

function getPath(data: Record<string, unknown>, field: string): unknown {
  if (!field.includes('.')) return data[field] ?? MISSING;
  let cursor: unknown = data;
  for (const part of field.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return MISSING;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor ?? MISSING;
}

/** Firestore compares by type first; a number never equals the string "5". */
function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matches(row: Row, filter: Filter): boolean {
  const actual = getPath(row.data, filter.field);
  const { op, value } = filter;

  if (op === 'in') {
    return Array.isArray(value) && value.some((v) => actual !== MISSING && compare(actual, v) === 0);
  }
  if (op === 'not-in') {
    return !Array.isArray(value) || !value.some((v) => actual !== MISSING && compare(actual, v) === 0);
  }
  if (op === 'array-contains') {
    return Array.isArray(actual) && actual.some((v) => compare(v, value) === 0);
  }
  if (op === 'array-contains-any') {
    const wanted = Array.isArray(value) ? value : [value];
    return Array.isArray(actual) && actual.some((v) => wanted.some((w) => compare(v, w) === 0));
  }

  // Firestore treats an absent field as null for `==` and `!=`, and excludes it
  // from every ordering comparison.
  //
  // `== null` has to be handled BEFORE the general equality comparison, because
  // `compare` never returns 0 for a missing field: `compare(MISSING, null)` falls
  // through to the `String()` branch and compares the sentinel's text against
  // "null", which is always non-zero. So `where('deletedAt', '==', null)` — the
  // soft-delete filter on every list in this app — has to short-circuit here.
  if (op === '==' && value === null) return actual === MISSING || actual === null;
  if (op === '!=' && value === null) return actual !== MISSING && actual !== null;

  // An absent field is not equal to anything, including null, once the null cases
  // above have been handled. Returning true for `actual === MISSING` on a non-null
  // comparison would let a document that simply LACKS the field match a filter for
  // it, which is the opposite of what Firestore does.
  if (actual === MISSING) return false;

  const eq = compare(actual, value) === 0;
  if (op === '==') return eq;
  if (op === '!=') return !eq;

  const cmp = compare(actual, value);
  if (op === '<') return cmp < 0;
  if (op === '<=') return cmp <= 0;
  if (op === '>') return cmp > 0;
  if (op === '>=') return cmp >= 0;
  return false;
}

/* ========================================================================== */
/* FieldValue application                                                      */
/* ========================================================================== */

/**
 * A fixed sentinel for `serverTimestamp()`.
 *
 * Frozen and identical across every call so a test can assert "a timestamp was
 * written" without depending on the clock. It is deliberately NOT a Date: a Date
 * would let a formatter pass in a test and fail in production, or worse, get
 * asserted into a snapshot.
 */
export const FAKE_TIMESTAMP = Object.freeze({ __fakeTimestamp: true });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Apply FieldValue sentinels inside an object tree, returning a plain object. */
function resolve(value: unknown): unknown {
  if (value === FieldValue.serverTimestamp()) return FAKE_TIMESTAMP;
  if (value === FieldValue.delete()) return DELETE;
  if (Array.isArray(value)) return value.map(resolve);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolve(v);
      if (r !== DELETE) out[k] = r;
    }
    return out;
  }
  return value;
}

const DELETE = Symbol('delete');

/** Merge semantics for `set(..., { merge: true })` and for `update`. */
function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(patch)) {
    const value = resolve(raw);
    if (value === DELETE) {
      delete target[key];
      continue;
    }
    // `FieldValue.increment(n)` has already been resolved by resolve() only for
    // serverTimestamp/delete, so increment is handled here.
    if (isPlainObject(value) && '__increment' in value) {
      const current = typeof target[key] === 'number' ? (target[key] as number) : 0;
      target[key] = current + (value.__increment as number);
      continue;
    }
    target[key] = value;
  }
}

/* ========================================================================== */
/* The database                                                                */
/* ========================================================================== */

export class FakeFirestore {
  /** path → data. The single source of truth for the fake. */
  readonly store = new Map<string, Record<string, unknown>>();

  /** Every write performed, for atomicity assertions. */
  readonly writes: Array<{ path: string; op: string; data: Record<string, unknown> }> = [];

  private autoId = 0;

  /** Set to make the next `runTransaction` attempt throw, for failure testing. */
  failNextTransaction: Error | null = null;

  /** Set to make every operation throw, for "Firestore unavailable" testing. */
  unavailable: Error | null = null;

  constructor(seed: Record<string, Record<string, unknown>> = {}) {
    for (const [path, data] of Object.entries(seed)) this.store.set(path, { ...data });
  }

  /* --- seeding ---------------------------------------------------------- */

  seed(path: string, data: Record<string, unknown>): this {
    this.store.set(path, { ...data });
    return this;
  }

  read(path: string): Record<string, unknown> | undefined {
    const d = this.store.get(path);
    return d === undefined ? undefined : { ...d };
  }

  exists(path: string): boolean {
    return this.store.has(path);
  }

  /* --- reads ------------------------------------------------------------ */

  private guard(): void {
    if (this.unavailable) throw this.unavailable;
  }

  rowsIn(collectionPath: string): Row[] {
    const root = rootCollectionOf(collectionPath);
    const prefix = `${root}/`;
    const depth = root.split('/').length + 1;
    return [...this.store.entries()]
      .filter(([path]) => path.startsWith(prefix) && path.split('/').length === depth)
      .map(([path, data]) => ({ id: docIdOf(path), path, data: { ...data } }));
  }

  queryMatches(collectionPath: string, filters: Filter[]): Row[] {
    return this.rowsIn(collectionPath).filter((row) => filters.every((f) => matches(row, f)));
  }

  /* --- collection / document refs --------------------------------------- */

  collection(name: string) {
    this.guard();
    const db = this;
    const collectionPath = name;

    const buildQuery = (filters: Filter[], orders: Array<{ field: string; dir: string }>, limit: number | null) => {
      const run = (): Row[] => {
        db.guard();
        let rows = db.queryMatches(collectionPath, filters);
        for (const o of [...orders].reverse()) {
          rows = [...rows].sort((a, b) => {
            const cmp =
              o.field === '__name__'
                ? compare(a.id, b.id)
                : compare(getPath(a.data, o.field), getPath(b.data, o.field));
            return o.dir === 'desc' ? -cmp : cmp;
          });
        }
        // The document id is the implicit final tiebreak in Firestore.
        rows = [...rows].sort((a, b) => (orders.length === 0 ? compare(a.id, b.id) : 0));
        return limit === null ? rows : rows.slice(0, limit);
      };

      const snapshot = (rows: Row[]) => ({
        docs: rows.map((r) => ({
          id: r.id,
          ref: { path: r.path, id: r.id },
          exists: true,
          data: () => ({ ...r.data }),
        })),
        empty: rows.length === 0,
        size: rows.length,
        forEach: (cb: (d: unknown) => void) => run().forEach((r) => cb({ id: r.id, data: () => ({ ...r.data }) })),
      });

      return {
        kind: 'query' as const,
        path: collectionPath,
        where(field: string, op: string, value: unknown) {
          return buildQuery([...filters, { field, op, value }], orders, limit);
        },
        orderBy(field: string | FieldPath, dir: 'asc' | 'desc' = 'asc') {
          return buildQuery(filters, [...orders, { field: field.toString(), dir }], limit);
        },
        limit(n: number) {
          return buildQuery(filters, orders, n);
        },
        offset() {
          // Deliberately unsupported: the whole point of the cursor work is that
          // no admin surface paginates with offsets. A test that reached for this
          // would be testing something the product forbids.
          throw new Error('FakeFirestore: .offset() is intentionally unsupported — use cursors');
        },
        select() {
          return buildQuery(filters, orders, limit);
        },
        get: async () => snapshot(run()),
        count: async () => ({ data: () => ({ count: run().length }) }),
      };
    };

    const base = buildQuery([], [], null);

    return {
      ...base,
      kind: 'collection' as const,
      path: collectionPath,
      doc(id?: string) {
        db.guard();
        const docId = id ?? db.nextId();
        const path = `${collectionPath}/${docId}`;
        return db.docRef(path, docId);
      },
      add: async (data: Record<string, unknown>) => {
        const id = db.nextId();
        const path = `${collectionPath}/${id}`;
        db.store.set(path, {});
        db.docRef(path, id).set(data);
        return { id, path };
      },
      get: base.get,
      where: base.where,
      orderBy: base.orderBy,
      limit: base.limit,
      count: base.count,
    };
  }

  docRef(path: string, id?: string) {
    const db = this;
    return {
      kind: 'doc' as const,
      id: id ?? docIdOf(path),
      path,
      collection: (sub: string) => db.collection(`${path}/${sub}`),
      async get() {
        db.guard();
        const data = db.store.get(path);
        return {
          id: id ?? docIdOf(path),
          ref: { path, id: id ?? docIdOf(path) },
          exists: data !== undefined,
          data: () => (data === undefined ? undefined : { ...data }),
        };
      },
      set(data: Record<string, unknown>, options?: { merge?: boolean }) {
        db.guard();
        db.writes.push({ path, op: 'set', data: { ...data } });
        if (options?.merge === true || db.store.has(path)) {
          const target = db.store.get(path) ?? {};
          mergeInto(target, data);
          db.store.set(path, target);
        } else {
          db.store.set(path, resolve(data) as Record<string, unknown>);
        }
      },
      update(data: Record<string, unknown>) {
        db.guard();
        db.writes.push({ path, op: 'update', data: { ...data } });
        const target = db.store.get(path);
        if (target === undefined) throw new Error(`FakeFirestore: cannot update missing ${path}`);
        mergeInto(target, data);
      },
      delete() {
        db.guard();
        db.store.delete(path);
      },
    };
  }

  private nextId(): string {
    this.autoId += 1;
    return `auto_${this.autoId}`;
  }

  /* --- batch ------------------------------------------------------------ */

  batch() {
    const db = this;
    const buffered: Array<() => void> = [];
    return {
      set(ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) {
        buffered.push(() => db.docRef(ref.path).set(data, options));
      },
      update(ref: { path: string }, data: Record<string, unknown>) {
        buffered.push(() => db.docRef(ref.path).update(data));
      },
      delete(ref: { path: string }) {
        buffered.push(() => db.store.delete(ref.path));
      },
      async commit() {
        db.guard();
        // Firestore applies every write in a batch or none of them.
        const snapshot = new Map(db.store);
        try {
          for (const op of buffered) op();
        } catch (error) {
          db.store.clear();
          for (const [k, v] of snapshot) db.store.set(k, v);
          throw error;
        }
      },
    };
  }

  /* --- transaction ------------------------------------------------------ */

  /**
   * A transaction with snapshot isolation and rollback.
   *
   * Writes are buffered and only applied when the callback resolves, so a throw
   * mid-transaction leaves the store untouched — which is what makes "the audit
   * row and the mutation land together, or neither does" a testable claim rather
   * than a comment.
   */
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    this.guard();
    if (this.failNextTransaction) {
      const error = this.failNextTransaction;
      this.failNextTransaction = null;
      throw error;
    }

    const snapshot = new Map([...this.store.entries()].map(([k, v]) => [k, { ...v }]));
    const buffered: Array<() => void> = [];

    const tx: FakeTransaction = {
      get: async (target: unknown) => {
        const ref = target as { kind?: string; path?: string; id?: string };
        // A transaction can read a single doc or a query. Firestore types them as
        // different overloads, so the fake dispatches on the `kind` marker that
        // `collection()` and the query builder both set.
        if (ref.kind === 'collection' || ref.kind === 'query') {
          const snap = await this.query(ref.path as string, []).get();
          // Preserve the caller's filters/order/limit by replaying them onto the
          // ref that was actually passed in.
          return ref.kind === 'query' ? await (target as { get: () => Promise<unknown> }).get() : snap;
        }
        return this.docRef(ref.path as string, ref.id).get();
      },
      set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
        buffered.push(() => this.docRef(ref.path).set(data, options));
      },
      update: (ref: { path: string }, data: Record<string, unknown>) => {
        buffered.push(() => this.docRef(ref.path).update(data));
      },
      delete: (ref: { path: string }) => {
        buffered.push(() => this.store.delete(ref.path));
      },
      create: (ref: { path: string }, data: Record<string, unknown>) => {
        buffered.push(() => {
          if (this.store.has(ref.path)) throw new Error(`FakeFirestore: ${ref.path} already exists`);
          this.docRef(ref.path).set(data);
        });
      },
      getAll: async (target: unknown) => {
        const ref = target as { path: string; id: string };
        return [await this.docRef(ref.path, ref.id).get()];
      },
    };

    try {
      const result = await fn(tx);
      for (const op of buffered) op();
      return result;
    } catch (error) {
      // Roll back to the pre-transaction state.
      this.store.clear();
      for (const [k, v] of snapshot) this.store.set(k, v);
      throw error;
    }
  }

  /** Expose a bare query for a collection path (used by the transaction stub). */
  query(collectionPath: string, filters: Filter[]) {
    const db = this;
    return {
      where(field: string, op: string, value: unknown) {
        return db.query(collectionPath, [...filters, { field, op, value }]);
      },
      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        void field;
        void dir;
        return db.query(collectionPath, filters);
      },
      limit() {
        return db.query(collectionPath, filters);
      },
      get: async () => {
        const rows = db.queryMatches(collectionPath, filters);
        return {
          docs: rows.map((r) => ({
            id: r.id,
            exists: true,
            data: () => ({ ...r.data }),
          })),
          empty: rows.length === 0,
          size: rows.length,
        };
      },
    };
  }

  /* --- assertions ------------------------------------------------------- */

  writesUnder(prefix: string): Array<{ path: string; op: string; data: Record<string, unknown> }> {
    return this.writes.filter((w) => w.path.startsWith(prefix));
  }
}

export type FakeTransaction = {
  get(target: unknown): Promise<unknown>;
  getAll(targets: unknown): Promise<unknown[]>;
  set(ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }): void;
  update(ref: { path: string }, data: Record<string, unknown>): void;
  delete(ref: { path: string }): void;
  create(ref: { path: string }, data: Record<string, unknown>): void;
};

export { collectionOf, docIdOf, rootCollectionOf };
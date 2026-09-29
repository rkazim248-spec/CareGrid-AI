'use client';

/**
 * ============================================================================
 * CareGrid AI — the single realtime attach primitive
 * ============================================================================
 *
 * `docs/11 §2.1` **Rule R-1**:
 *
 * > Listeners are created only by `useRealtime*` hooks (`hooks/` or
 * > `features/…/hooks/`). A raw chained `.where()` inside an `onSnapshot` call in
 * > a component is a defect.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY LISTENER GOES THROUGH HERE
 * ---------------------------------------------------------------------------
 * `onSnapshot` is a WebSocket channel, a server-side watch, and a billing event
 * per document delivered. A component that opens its own listener gets none of the
 * guarantees in `docs/11`:
 *
 * | Guarantee | Where it comes from |
 * | --- | --- |
 * | a `limit()` exists | `docs/11 §6` QD-1, asserted at `register()` |
 * | a channel is torn down on unmount | the returned handle's `unsubscribe` |
 * | teardown on identity change | `docs/11 §3.5` `unsubscribeAll()` |
 * | the budget is enforced | `docs/11 §2.1`, `MAX_CONCURRENT_LISTENERS` |
 * | two components share one channel | refcounted `registerListener` |
 * | the query is memoised | the `queryKey` string below |
 * | errors are mapped, never thrown | `mapListenerError` |
 *
 * Making this the only entry point is what turns those from a review checklist
 * into properties of the system.
 *
 * ---------------------------------------------------------------------------
 * THE `queryKey` IS WHAT PREVENTS A RE-RENDER RESUBSCRIPTION
 * ---------------------------------------------------------------------------
 * `docs/11 §3.6`: a listener must not be re-created by a React re-render. A
 * Firestore `Query` object is a new identity on every call, so a `useEffect`
 * depending on one would re-subscribe on every render — each one closing and
 * reopening a channel, which is visible to the user as a queue that flickers and
 * expensive to the bill.
 *
 * The fix is a STRING key derived from the query's parameters. The effect depends
 * on the string, so two renders producing the same query produce the same key and
 * no re-subscription. The `Query` object is then rebuilt INSIDE the effect, from
 * the parameters, where its identity does not matter.
 *
 * ---------------------------------------------------------------------------
 * `includeMetadataChanges` IS OPT-IN PER LISTENER, NOT A GLOBAL DEFAULT
 * ---------------------------------------------------------------------------
 * `docs/11 §3.3` turns it on for exactly four of the ten, and each for a stated
 * reason. Making it the default would quadruple the snapshot rate of the other six
 * to serve a pending-state flag only one of them uses, so the option is
 * `false`-by-default and the four documented listeners opt in.
 */

import * as React from 'react';

import {
  onSnapshot,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import {
  openListenerCount,
  recordListenerDocuments,
  registerListener,
  type ListenerId,
} from '@/lib/realtime/listener-registry';
import { mapListenerError, shouldLogListenerError, type MappedListenerError } from '@/lib/realtime/listener-error';
import { mergeSnapshot, shallowEqual, type HasId } from '@/lib/realtime/merge-snapshot';
import { setAnyListenerAttached } from '@/hooks/use-online-status';

/* ========================================================================== */
/* The return shape                                                            */
/* ========================================================================== */

/**
 * What every realtime hook returns.
 *
 * **`isStale` and `isLoading` are separate and both required.** `isLoading` false
 * with an empty array is a claim that there is nothing; `isLoading` true with an
 * empty array is a claim that we do not know yet. `docs/11 §3.2` is explicit:
 * "An empty queue is a claim about reality; during that window we do not know it
 * yet." Conflating them is how a dispatcher sees "no active incidents" for two
 * seconds on every page load.
 */
export type RealtimeStateShape<T> = {
  readonly items: readonly T[];
  readonly isLoading: boolean;
  readonly error: MappedListenerError | null;
  /** `docs/11 §4.2`: the payload is older than the sync window. */
  readonly isStale: boolean;
  /** Ids with an unacknowledged local write. */
  readonly pendingIds: ReadonlySet<string>;
  /** Ids the server has just confirmed, for the live flash. */
  readonly changedIds: ReadonlySet<string>;
  /** Epoch ms of the last fully-applied snapshot, or `null`. */
  readonly lastSyncedAt: number | null;
};

export type UseRealtimeListenerOptions<T extends HasId> = {
  readonly id: ListenerId;
  /**
   * Stable string describing the query. `docs/11 §3.6`.
   *
   * Built by the CALLER from its parameters, so two components with the same
   * query share a channel and two components with different queries do not.
   */
  readonly queryKey: string;
  /**
   * Build the query. Called INSIDE the effect, so its new identity on every render
   * is irrelevant.
   *
   * Returned as a value rather than being called by this hook, because the query
   * builders in `lib/firestore/queries.ts` need the `Firestore` instance and the
   * role, and passing those in as arguments to a generic primitive would be a
   * wider API than the one function needs.
   */
  readonly buildQuery: (db: ReturnType<typeof getFirebaseClient>['db']) =>
    | Query<DocumentData>
    | DocumentReference<DocumentData>;
  /** The declared `limit()`. Asserted against the registry's ceiling. */
  readonly limit: number;
  /** Map one document to a row. */
  readonly map: (data: DocumentData, id: string) => T;
  /** `docs/11 §3.3`. Off by default; four of ten listeners opt in. */
  readonly includeMetadataChanges?: boolean;
  /** `false` before auth resolves, or for a role that must not build the query. */
  readonly enabled?: boolean;
  /**
   * Rows from a Server Component, shown until the first snapshot.
   * `docs/11 §3.2`'s seed.
   */
  readonly seed?: readonly T[];
  /**
   * A single-document listener (L2a, L7, L10) resolves to a `DocumentReference`.
   *
   * The distinction changes the snapshot shape — a `DocumentSnapshot` has no
   * `docChanges` — so it is declared rather than detected, and a wrong value here
   * fails loudly in the mapping step instead of silently producing an empty list.
   */
  readonly kind?: 'query' | 'document';
};

/* ========================================================================== */
/* The primitive                                                               */
/* ========================================================================== */

const EMPTY: MappedListenerError | null = null;

export function useRealtimeListener<T extends HasId>(
  options: UseRealtimeListenerOptions<T>,
): RealtimeStateShape<T> {
  const {
    id,
    queryKey,
    buildQuery,
    limit,
    map,
    includeMetadataChanges = false,
    enabled = true,
    seed,
    kind = 'query',
  } = options;

  const [items, setItems] = React.useState<readonly T[]>(seed ?? []);
  const [pendingIds, setPendingIds] = React.useState<ReadonlySet<string>>(new Set());
  const [changedIds, setChangedIds] = React.useState<ReadonlySet<string>>(new Set());
  const [error, setError] = React.useState<MappedListenerError | null>(EMPTY);
  const [lastSyncedAt, setLastSyncedAt] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState<boolean>(enabled);

  // The previous rows, for the seed and for the pending carry-forward. A ref, not
  // state: this is read inside a Firestore callback and must not itself cause a
  // render.
  const previousRef = React.useRef<readonly T[]>(seed ?? []);
  // The pending set as the callback last saw it, so a server confirmation can be
  // distinguished from someone else's change. See `docs/11 §3.4`.
  const pendingRef = React.useRef<ReadonlySet<string>>(new Set());

  // `map` is usually an inline arrow, so it changes identity every render. The
  // ref keeps the effect from depending on it — otherwise the listener would
  // re-subscribe on every render, which is the exact bug `docs/11 §3.6` exists to
  // prevent. The ref is the correct fix rather than `useCallback`-ing every
  // caller's mapper.
  const mapRef = React.useRef(map);
  mapRef.current = map;

  // `isStale` needs a clock that ticks even when no snapshot arrives, so the
  // coarse interval lives here rather than in each consumer. `docs/11 §4.2`.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  React.useEffect(() => {
    // A-4: "Auth must be resolved first … Attaching before `uid` is known produces
    // a `permission-denied` first snapshot that then disappears." The caller
    // passes `enabled: false` until auth resolves, and this is the guard.
    if (!enabled) {
      setIsLoading(seed === undefined);
      return;
    }

    let db: ReturnType<typeof getFirebaseClient>['db'];
    try {
      db = getFirebaseClient().db;
    } catch {
      // Unconfigured deployment. Not an error state — `isLoading` goes false with
      // the seed, so a public page renders its static content rather than a
      // spinner that never resolves.
      setIsLoading(false);
      return;
    }

    let disposed = false;
    // Tells the connection store that something is now being asked for, which is
    // what makes the stall detector meaningful. Without it, "nothing has arrived"
    // is indistinguishable from "no listener is attached", and the indicator
    // would never leave `connecting`.
    setAnyListenerAttached(true);

    const handle = registerListener({
      id,
      limit,
      queryKey,
      detach: () => {
        /* Replaced below with the real teardown. */
      },
    });

    const target = buildQuery(db);

    /** A-2: an error callback is not optional. */
    const onError = (raw: unknown): void => {
      const mapped = mapListenerError(raw);
      if (shouldLogListenerError(mapped)) {
        // The Firestore code only. The message can contain the query's field
        // names, which is a free schema for anyone reading the console of a
        // shared operations machine.
        // An unlogged listener defect is the failure SEC-1 is about. No lint
        // suppression: `no-console` is not enabled in this project, and a
        // directive for a rule that does not exist is itself an unused directive.
        console.warn(`realtime: listener "${id}" failed`, mapped.firestoreCode, mapped.code);
      }
      if (disposed) return;
      setError(mapped);
      setIsLoading(false);
    };

    const onQuerySnapshot = (snapshot: QuerySnapshot<DocumentData>): void => {
      if (disposed) return;
      const merged = mergeSnapshot(snapshot, {
        pendingIds: pendingRef.current,
        map: (data, docId) => mapRef.current(data, docId),
        previous: previousRef.current,
      });

      previousRef.current = merged.items;
      pendingRef.current = merged.pendingIds;

      setItems(merged.items);
      setPendingIds(merged.pendingIds);
      setChangedIds(merged.changedIds);
      setLastSyncedAt(Date.now());
      setIsLoading(false);
      // A snapshot after an error is a RECOVERY, not a silent success: the banner
      // has to go, and it only goes if something clears the error.
      setError(EMPTY);

      // `docs/11 §7.3`'s local estimator input.
      recordListenerDocuments(id, merged.items.length);
    };

    const onDocumentSnapshot = (snapshot: DocumentSnapshot<DocumentData>): void => {
      if (disposed) return;
      const nextPending = new Set<string>();
      let next: readonly T[] = [];

      if (snapshot.exists()) {
        const row = mapRef.current(snapshot.data() ?? {}, snapshot.id);
        next = [row];
        if (snapshot.metadata.hasPendingWrites) nextPending.add(snapshot.id);
      }

      const changed = new Set<string>();
      // A single-document listener's FIRST delivery is not a "change" — the row
      // appeared because the user navigated to it. Only a difference from a
      // previous delivery is a change, which is what stops the detail panel from
      // flashing on every visit.
      if (previousRef.current.length > 0 && next.length > 0) {
        if (!shallowEqual(previousRef.current[0] as unknown as Record<string, unknown>, next[0] as unknown as Record<string, unknown>)) {
          changed.add(snapshot.id);
        }
      }

      previousRef.current = next;
      pendingRef.current = nextPending;
      setItems(next);
      setPendingIds(nextPending);
      setChangedIds(changed);
      setLastSyncedAt(Date.now());
      setIsLoading(false);
      setError(EMPTY);
      recordListenerDocuments(id, next.length);
    };

    // Two branches rather than one call with a union, so TypeScript resolves the
    // correct `onSnapshot` OVERLOAD for each. A single call over
    // `Query | DocumentReference` needs a cast, and a cast here would hide exactly
    // the mistake that matters: passing a document reference to a listener that
    // expects a query list.
    const unsubscribe =
      kind === 'document'
        ? onSnapshot(
            target as DocumentReference<DocumentData>,
            { includeMetadataChanges },
            onDocumentSnapshot,
            onError,
          )
        : onSnapshot(
            target as Query<DocumentData>,
            { includeMetadataChanges },
            onQuerySnapshot,
            onError,
          );

    // A-3: the registry owns teardown as well as counting, so the handle's
    // `unsubscribe` is what the effect cleanup calls. The `detach` passed to
    // `registerListener` is replaced here rather than captured earlier, because
    // `unsubscribe` does not exist until after this line.
    handle.unsubscribe = () => {
      unsubscribe();
    };

    return () => {
      disposed = true;
      handle.unsubscribe();
      // The last listener leaving means "nothing is being asked for" again, so the
      // stall detector must stop. Otherwise a navigation away from the dashboard
      // would leave the indicator claiming a reconnect that is not happening.
      setAnyListenerAttached(openListenerCount() > 0);
    };
    // `queryKey` is the dependency that MATTERS (`docs/11 §3.6`). `id`, `limit`,
    // `kind` and `includeMetadataChanges` are all part of the key's identity by
    // construction — a caller that changes them without changing the key has
    // written a bug, and the registry's sharing would mask it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the note above.
  }, [enabled, queryKey, id, limit, kind, includeMetadataChanges]);

  return {
    items,
    isLoading,
    error,
    isStale:
      lastSyncedAt === null ? isLoading : nowMs - lastSyncedAt > STALE_THRESHOLD_MS,
    pendingIds,
    changedIds,
    lastSyncedAt,
  };
}

/**
 * Mirrors `lib/realtime/connection.ts`'s `STALE_AFTER_MS`, duplicated rather than
 * imported so this module has no dependency on the connection store.
 *
 * A security check asserts the two are equal, because a primitive that thought a
 * payload was fresh while the banner thought it was stale would be a contradiction
 * on the same screen.
 */
const STALE_THRESHOLD_MS = 30_000;

/**
 * The document id of each row in a query snapshot, for a caller that needs the
 * raw change list rather than the merged rows.
 *
 * `docs/11 §10.4` (R-4: "Two listeners deliver the same incident") is handled by
 * the caller de-duplicating on this, and this is the cheap way to get there
 * without re-reading the snapshot.
 */
export function snapshotIds(
  snapshot: Pick<QuerySnapshot<DocumentData>, 'docs'>,
): readonly string[] {
  return (snapshot.docs as readonly QueryDocumentSnapshot<DocumentData>[]).map((d) => d.id);
}

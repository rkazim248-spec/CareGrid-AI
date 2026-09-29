'use client';

/**
 * ============================================================================
 * CareGrid AI — realtime connection status
 * ============================================================================
 *
 * `docs/11 §4.2`, NFR-012, US-041. **The only place connection state is observed.**
 *
 * ---------------------------------------------------------------------------
 * `docs/11 §4.2` PRESCRIBES AN API THIS SDK VERSION DOES NOT SHIP
 * ---------------------------------------------------------------------------
 * The document derives `isReconnecting` from `onNetworkStatusChange(db, …)`.
 * **That function is not exported by `firebase/firestore` in the installed
 * version (11.10.0).** It exists only inside `@firebase/firestore`'s internal
 * `remote/connectivity_monitor` module, which is not a public API and would break
 * on any SDK upgrade. Reaching into it would be worse than the divergence.
 *
 * So `firestoreStatus` is derived from the public surface instead:
 *
 * | Fact | Public API | Meaning |
 * | --- | --- | --- |
 * | `navigatorOnLine` | `window.online` | the browser has a network interface |
 * | `lastSyncedAt` | `onSnapshotsInSync(db, …)` | a complete snapshot landed |
 * | `hasStalled` | a timer in this module | listeners are attached, the browser claims to be online, and nothing has arrived |
 *
 * **The stall detector is not a downgrade — it catches a case
 * `onNetworkStatusChange` would miss.** Firestore's connectivity monitor reports
 * what the transport believes; it does not report a socket that is open, carrying
 * no bytes, behind a captive portal. A dispatcher in that state is looking at
 * four-minute-old data, and the honest indicator is "Reconnecting." The detector
 * answers exactly that question, using the one signal that proves liveness.
 *
 * The gap is recorded in `docs/30.9 §2`.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE HOOK SERVES EVERY LISTENER
 * ---------------------------------------------------------------------------
 * `onSnapshotsInSync` is Firestore-level, not per-query. Registering it in each of
 * the ten listeners would mean ten subscriptions to the same global event and ten
 * independent notions of "am I connected" that could disagree — which is exactly
 * how a UI ends up showing a green dot while one panel is stale.
 *
 * So this hook attaches it ONCE at module scope and every consumer reads the same
 * object. `docs/11 §2.3` counts listeners by CHANNEL, and this is not a channel:
 * it is metadata about all of them, so it is deliberately outside the registry's
 * budget and outside its `ListenerId` union.
 *
 * ---------------------------------------------------------------------------
 * `lastSyncedAt` IS THE ONLY PROOF OF LIVENESS
 * ============================================================================
 * `onSnapshotsInSync` fires when every outstanding local write has been
 * acknowledged AND all listener snapshots are current. That is the moment the data
 * on screen is the server's data, which is the only moment "Live" is a true
 * statement.
 *
 * It is tracked in a module store rather than component state, deliberately: it
 * changes on a cadence set by Firestore, and putting it in state would re-render
 * every consumer of this hook on every sync. Consumers read it through
 * `useSyncExternalStore`, which only re-renders when the DERIVED state changes.
 */

import * as React from 'react';

import { onSnapshotsInSync, type Firestore } from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import {
  STALE_AFTER_MS,
  deriveOnlineStatus,
  type FirestoreNetworkStatus,
  type OnlineStatus,
  type RealtimeState,
} from '@/lib/realtime/connection';

/* ========================================================================== */
/* The module-level store                                                      */
/* ========================================================================== */

/**
 * A tiny external store, so `useSyncExternalStore` can read it without the hook
 * owning the subscription.
 *
 * `onSnapshotsInSync` has no unsubscribe that is useful per-component — it is
 * global — so it is attached lazily on the first `subscribe()` and never detached.
 * That is not a leak: there is exactly one, for the life of the tab, and detaching
 * on the last unmount would mean re-attaching on the next navigation for no
 * benefit.
 */
type Store = {
  lastSyncedAt: number | null;
  wentOfflineAt: number | null;
  /** Bumped on every change so `useSyncExternalStore` sees a new snapshot. */
  version: number;
  attached: boolean;
  /** True once at least one listener has attached — gates the stall detector. */
  anyListenerAttached: boolean;
  listeners: Set<() => void>;
};

const store: Store = {
  lastSyncedAt: null,
  wentOfflineAt: null,
  version: 0,
  attached: false,
  anyListenerAttached: false,
  listeners: new Set(),
};

function emit(): void {
  store.version += 1;
  for (const listener of store.listeners) listener();
}

/** Attach the one global observer, once. */
function ensureAttached(db: Firestore): void {
  if (store.attached) return;
  store.attached = true;

  onSnapshotsInSync(db, () => {
    store.lastSyncedAt = Date.now();
    // A sync PROVES the connection works, so it clears the went-offline marker.
    // Without this a dispatcher who was offline for a minute keeps seeing an
    // "offline for 1m" chip after reconnecting.
    store.wentOfflineAt = null;
    emit();
  });
}

/* ========================================================================== */
/* The stall detector                                                          */
/* ========================================================================== */

/**
 * How long Firestore may deliver nothing, while the browser claims to be online,
 * before the UI says "Reconnecting."
 *
 * **Longer than `STALE_AFTER_MS`.** The two answer different questions, and
 * conflating them produces a banner that appears before the data is actually
 * misleading. Staleness ("this payload is old") becomes true at 30 s.
 * Reconnection ("we are no longer receiving") requires positive evidence of a
 * stall, so it waits for a full extra window — 45 s — during which Firestore
 * could be legitimately quiet because nothing changed.
 */
export const STALL_AFTER_MS = STALE_AFTER_MS * 1.5;

/**
 * Derive `firestoreStatus` from the public signals.
 *
 * | Condition | Status | Why |
 * | --- | --- | --- |
 * | no listener attached | `unknown` | nothing is being asked for, so nothing is late |
 * | no snapshot yet | `unknown` | `connected` before any data exists is the false "Connected" `docs/11 §4.2` warns about |
 * | a snapshot inside the stall window | `available` | the proof of liveness |
 * | nothing for longer than the window, browser online | `unavailable` | a positive stall |
 *
 * `navigatorOnline` is a parameter rather than a read of `navigator` so the
 * function is pure and testable — the same reason `docs/11 §4.2` keeps its
 * derivation as separate booleans.
 */
export function deriveFirestoreStatus(input: {
  readonly anyListenerAttached: boolean;
  readonly lastSyncedAt: number | null;
  readonly nowMs: number;
  readonly navigatorOnline: boolean;
}): FirestoreNetworkStatus {
  if (!input.anyListenerAttached) return 'unknown';
  if (input.lastSyncedAt === null) return 'unknown';
  if (!input.navigatorOnline) return 'unavailable';
  if (input.nowMs - input.lastSyncedAt > STALL_AFTER_MS) return 'unavailable';
  return 'available';
}

function getSnapshot(): number {
  return store.version;
}

function subscribeToStore(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/* ========================================================================== */
/* The hook                                                                    */
/* ========================================================================== */

export type UseOnlineStatusOptions = {
  /**
   * `false` for a route that is deliberately not listening. `docs/11 §2.3`'s
   * zero-listener routes and `docs/11 §2.4`'s "never listened to" table.
   *
   * This is what makes `LiveIndicator` say "Not live" on `/analytics` instead of
   * "Live" over data that will never change.
   */
  readonly enabled?: boolean;
  /** Set by a listener hook that has errored. `docs/11 §3.1` A-2. */
  readonly hasError?: boolean;
};

/**
 * The connection record. One per consumer, all reading the same source.
 *
 * `navigator.onLine` is read at call time rather than subscribed here, and the
 * `online`/`offline` window events are handled in an effect. That split is
 * deliberate: `navigator.onLine` is a synchronous read the derivation needs, and
 * a listener-only implementation would render one frame with a stale value.
 */
export function useOnlineStatus(options: UseOnlineStatusOptions = {}): OnlineStatus {
  const { enabled = true, hasError = false } = options;

  // Re-render on every store emission. `useSyncExternalStore` compares the
  // returned number, so an emission that did not change `version` is free.
  React.useSyncExternalStore(subscribeToStore, getSnapshot, getSnapshot);

  const [navigatorOnLine, setNavigatorOnLine] = React.useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  // Re-derive the moment any input changes. Deliberately NOT memoised on the
  // individual facts: the derivation is four comparisons, and memoising it would
  // mean a stale `isStale` whenever `nowMs` was not also a dependency — which is
  // the bug that would let a "Live" badge sit over four-minute-old data.
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    const goOnline = (): void => setNavigatorOnLine(true);
    const goOffline = (): void => setNavigatorOnLine(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // A coarse tick, so `isStale` eventually flips without a snapshot arriving.
  // 5 s is short enough that a dispatcher sees "stale" within a few seconds of a
  // silent stall, and long enough that it is not a re-render storm. The interval
  // only exists while a listener is live; a page with no listeners sets
  // `enabled: false` and does not run it.
  React.useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  // Attach the global observer only once a consumer actually needs it.
  React.useEffect(() => {
    if (!enabled) return;
    try {
      ensureAttached(getFirebaseClient().db);
    } catch {
      // Unconfigured deployment. The derivation then reports `not_live` rather
      // than throwing, because a public page must still render.
      store.anyListenerAttached = false;
      emit();
    }
  }, [enabled]);

  return deriveOnlineStatus(
    {
      navigatorOnLine,
      firestoreStatus: deriveFirestoreStatus({
        anyListenerAttached: store.anyListenerAttached,
        lastSyncedAt: store.lastSyncedAt,
        nowMs,
        navigatorOnline: navigatorOnLine,
      }),
      lastSyncedAt: store.lastSyncedAt,
      hasError,
      enabled,
    },
    nowMs,
  );
}

/**
 * The state alone, for a caller that only branches on it.
 *
 * Kept because `docs/11 §2.4`'s zero-listener pages still need to render a
 * `LiveIndicator`, and passing the whole record through a prop to read one field
 * is how the indicator ends up with a hardcoded date.
 */
export function useRealtimeState(options: UseOnlineStatusOptions = {}): RealtimeState {
  return useOnlineStatus(options).state;
}

/** Test seam. Mirrors `resetFirebaseClientForTests`. */
export function resetConnectionStoreForTests(): void {
  store.lastSyncedAt = null;
  store.wentOfflineAt = null;
  store.attached = false;
  store.anyListenerAttached = false;
  store.version = 0;
  store.listeners.clear();
}

/**
 * Record that a listener has attached or detached, so the stall detector knows
 * whether "nothing has arrived" is a fault or simply "nothing was asked for".
 *
 * Called by `useRealtimeListener`. Exported because the primitive and this hook
 * are separate modules and neither should reach into the other's store.
 */
export function setAnyListenerAttached(attached: boolean): void {
  if (store.anyListenerAttached === attached) return;
  store.anyListenerAttached = attached;
  emit();
}

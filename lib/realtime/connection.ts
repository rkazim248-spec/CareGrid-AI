/**
 * ============================================================================
 * CareGrid AI — realtime connection state
 * ============================================================================
 *
 * `docs/11 §4.2`, NFR-012, US-041. **PURE.** No Firebase, no hooks.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR STATES ARE A DERIVATION, NOT A VARIABLE
 * ---------------------------------------------------------------------------
 * brief §4: "Never falsely display 'Connected' if the realtime connection is
 * unavailable."
 *
 * That single requirement is why this file exists as a pure function over three
 * facts. The failure it prevents is the most damaging kind of UI bug in an
 * operations tool: a green "Live" dot over data that stopped updating four
 * minutes ago. A dispatcher who trusts that dot while an incident changes is
 * worse off than one who is told the connection dropped.
 *
 * So the state is COMPUTED from evidence on every render:
 *
 * | Fact | Source | Meaning |
 * | --- | --- | --- |
 * | `navigatorOnLine` | `window.online` | the browser has a network interface |
 * | `firestoreStatus` | `onNetworkStatusChange` | Firestore can actually reach the backend |
 * | `lastSyncedAt` | `onSnapshotsInSync` | a snapshot has been fully applied |
 *
 * `connected` additionally requires a **non-null** `lastSyncedAt`. A client that
 * has attached listeners but has not yet received a complete snapshot is
 * `connecting`, not `connected` — reporting `connected` there would be claiming
 * live data before any exists.
 *
 * ---------------------------------------------------------------------------
 * WHY `isReconnecting` IS NOT `!isOnline`
 * ---------------------------------------------------------------------------
 * `docs/11 §4.2`: "online, but Firestore has not re-established listeners". These
 * are different failures with different fixes: `!isOnline` is a dead wifi icon and
 * the user must fix their network; `isReconnecting` is a transient backend hiccup
 * that Firestore is already retrying on its own, and telling the user to check
 * their router would be actively misleading.
 */

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

/**
 * Mirrors `components/layout/live-indicator.tsx`'s existing `LiveState` union
 * exactly, so the indicator and this module cannot disagree.
 *
 * `not_live` is the fifth state the indicator already supports and this phase
 * needs: it is what a page shows when it is *deliberately* not listening —
 * `/analytics` (FR-099 forbids listeners for historical data), `/audit-logs`, and
 * any route in `docs/11 §2.3` whose count is 0. Showing "Live" there would be a
 * claim about data the page is not live, and showing "Offline" would send someone
 * to check their network over it.
 */
export type RealtimeState = 'connected' | 'connecting' | 'reconnecting' | 'offline' | 'error' | 'not_live';

export type FirestoreNetworkStatus = 'available' | 'unavailable' | 'unknown';

/** The three facts the state is derived from. */
export type ConnectionFacts = {
  /** `window.navigator.onLine`. */
  readonly navigatorOnLine: boolean;
  readonly firestoreStatus: FirestoreNetworkStatus;
  /**
   * Epoch ms of the last fully-applied snapshot, or `null` if none has arrived.
   *
   * `null` is a distinct and important value: it is what makes `connecting`
   * distinguishable from `connected`.
   */
  readonly lastSyncedAt: number | null;
  /** Set when a listener has errored. `docs/11 §3.1` A-2. */
  readonly hasError: boolean;
  /**
   * `false` for a page that is deliberately not listening. `docs/11 §2.3`'s
   * zero-listener routes, and `docs/11 §2.4`'s "never listened to" table.
   */
  readonly enabled: boolean;
};

/* ========================================================================== */
/* The derivation                                                              */
/* ========================================================================== */

/**
 * The one function that decides what the connection indicator says.
 *
 * Order is the whole design, and each early return is a case where claiming
 * "Connected" would be false:
 *
 * 1. **Not enabled** — the page is not listening on purpose. Not a fault.
 * 2. **Error** — a listener failed. `docs/11 §11.3` SEC-1: a
 *    `permission-denied` here is a DEFECT (the query and the role disagree), so it
 *    is surfaced as its own state rather than being folded into "offline" where a
 *    user would go and check their wifi.
 * 3. **Offline** — no network interface. Nothing can be live.
 * 4. **Firestore unavailable** — online but the backend is unreachable. This is
 *    `reconnecting`, NOT `offline`: Firestore is retrying on its own.
 * 5. **No snapshot yet** — attached but nothing has landed. `connecting`.
 * 6. Otherwise — `connected`.
 */
export function deriveRealtimeState(facts: ConnectionFacts): RealtimeState {
  if (!facts.enabled) return 'not_live';
  if (facts.hasError) return 'error';
  if (!facts.navigatorOnLine) return 'offline';
  if (facts.firestoreStatus === 'unavailable') return 'reconnecting';
  if (facts.lastSyncedAt === null) return 'connecting';
  return 'connected';
}

/* ========================================================================== */
/* Copy — `docs/11 §4.2`'s banner table, verbatim                               */
/* ========================================================================== */

/**
 * The banner copy, per `docs/11 §4.2`'s table.
 *
 * **A persistent in-page banner, never a toast.** `docs/11 §4.2` states it
 * directly and `docs/16` agrees: "A toast storm during an outage is a defect."
 * During a real outage every listener in the app errors, and if each one produced
 * a toast a dispatcher would be shown twenty identical notices and the one that
 * mattered would be lost among them.
 */
export const CONNECTIVITY_COPY: Readonly<
  Record<RealtimeState, { readonly banner: string | null; readonly liveState: 'live' | 'reconnecting' | 'offline' | 'not_live' }>
> = {
  connected: {
    // No banner. The `LiveIndicator` in the top bar carries the state; a banner
    // that says "everything is fine" every time is noise.
    banner: null,
    liveState: 'live',
  },
  connecting: {
    banner: 'Connecting to live updates.',
    liveState: 'reconnecting',
  },
  reconnecting: {
    // `docs/11 §4.2` gives this string verbatim: "Reconnecting."
    banner: 'Reconnecting.',
    liveState: 'reconnecting',
  },
  offline: {
    // Verbatim. The second sentence is the load-bearing one: it tells the user
    // that anything they do will be SENT LATER rather than lost, which is the
    // difference between "the app is broken" and "I can keep working".
    banner: 'You are offline. Actions you take now will be sent when you reconnect.',
    liveState: 'offline',
  },
  error: {
    // A permission failure is a defect, and saying so is more useful to whoever
    // has to fix it than a generic message. The copy is deliberately not an
    // accusation about the user's network.
    banner: 'Live updates are unavailable for this view. Reload to try again.',
    liveState: 'not_live',
  },
  not_live: {
    banner: null,
    liveState: 'not_live',
  },
};

/* ========================================================================== */
/* Staleness                                                                   */
/* ========================================================================== */

/**
 * How long a payload may sit unsynced before the UI must call it stale.
 *
 * `docs/11 §4.2` uses 30 s for the "Pending sync" count, and NFR-012 requires the
 * payload be *marked* stale rather than silently trusted. 30 s is chosen to sit
 * above the listener's own `includeMetadataChanges` round trip (a local write is
 * acknowledged in well under a second) and below the point at which a dispatcher
 * would notice a responder's status change has not appeared.
 */
export const STALE_AFTER_MS = 30_000;

/**
 * Is the displayed payload stale?
 *
 * **A field on the hook's return shape**, not something a consumer infers from
 * timestamps — `docs/11 §4.2` requires it so a component can say "this is the
 * last data received" without knowing what the connection state's internals are.
 */
export function isPayloadStale(lastSyncedAt: number | null, nowMs: number): boolean {
  if (lastSyncedAt === null) return true;
  return nowMs - lastSyncedAt > STALE_AFTER_MS;
}

/* ========================================================================== */
/* The online-status record                                                    */
/* ========================================================================== */

export type OnlineStatus = {
  readonly isOnline: boolean;
  readonly isReconnecting: boolean;
  readonly lastUpdateAt: number | null;
  readonly wentOfflineAt: number | null;
  readonly state: RealtimeState;
  readonly isStale: boolean;
};

/**
 * Assemble the full record from the raw facts.
 *
 * `isOnline` is `navigatorOnLine && firestoreStatus !== 'unavailable'` — so a
 * browser with a working wifi icon and no Firestore connection reports
 * `isOnline: false`, which is the truth a user needs ("this is not updating")
 * even though the mechanism is Firestore's.
 */
export function deriveOnlineStatus(
  facts: ConnectionFacts,
  nowMs: number,
): OnlineStatus {
  const firestoreReachable = facts.firestoreStatus !== 'unavailable';
  const isOnline = facts.navigatorOnLine && firestoreReachable;
  const state = deriveRealtimeState(facts);

  return {
    isOnline,
    // `docs/11 §4.2`: online, but Firestore has not re-established listeners.
    isReconnecting: facts.navigatorOnLine && !firestoreReachable,
    lastUpdateAt: facts.lastSyncedAt,
    // Null rather than 0 — "never went offline" and "went offline at the epoch"
    // must not render the same.
    wentOfflineAt: facts.navigatorOnLine ? null : nowMs,
    state,
    isStale: isPayloadStale(facts.lastSyncedAt, nowMs),
  };
}

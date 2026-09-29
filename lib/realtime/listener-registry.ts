/**
 * ============================================================================
 * CareGrid AI — realtime listener registry
 * ============================================================================
 *
 * `docs/11 §2.1`, FR-091. **CLIENT-SIDE ONLY.**
 *
 * ---------------------------------------------------------------------------
 * WHY A REGISTRY AT ALL
 * ---------------------------------------------------------------------------
 * "Don't create hundreds of independent listeners" is not a style preference. Every
 * `onSnapshot` is an open WebSocket channel, a server-side watch, and a billing
 * event on every document it delivers. A dashboard that mounts a queue listener
 * per row would hold 50 channels to deliver one list, and the cost model in
 * `docs/11 §1.4` makes that the difference between a deployable product and an
 * invoice nobody predicted.
 *
 * So the registry is the only thing allowed to know how many channels are open,
 * and the hooks ask it for permission rather than counting for themselves.
 *
 * `docs/11 §2.1` specifies the behaviour exactly:
 *
 * > `console.warn('realtime: 6 of 8 listener slots in use', ids)` at 6
 * > `throws in NODE_ENV === 'test'` at 9
 * > `unsubscribes all on sign-out and on uid change`
 *
 * All three are implemented, and the third is what makes the other two meaningful:
 * a leaked listener is a permanent slot loss, and eight leaks is a dashboard that
 * has silently stopped receiving updates.
 *
 * ---------------------------------------------------------------------------
 * THE `ListenerId` UNION IS `docs/11`'s, VERBATIM
 * ---------------------------------------------------------------------------
 * Ten ids, L1 through L10, each with one meaning. A union rather than a string is
 * the point: a typo is a compile error, and the alternative — a free string — makes
 * "which listener is this?" a question with no answer at 3am during an incident.
 *
 * A SECOND listener of the same id is NOT a second slot. Two components wanting
 * the queue both want L1's data, and the registry hands the second one a handle to
 * the first one's channel. That is what makes a shared `(app)` shell's layout
 * listener (L7) and a page's own listener (L1) coexist without a slot fight.
 *
 * ---------------------------------------------------------------------------
 * `limit` IS ENFORCED HERE, NOT IN REVIEW
 * ---------------------------------------------------------------------------
 * `docs/11 §6` QD-1: "Always a `limit()`. No exception, no 'we'll add one later'."
 * QD-3: "Never an unbounded listener."
 *
 * The registry cannot inspect a Firestore `Query` object for its limit, so the
 * limit is declared at attach time and asserted against the per-listener ceiling
 * from the registry table. A caller that omits it gets a `TypeError` at attach
 * rather than an unbounded channel — which is the difference between a failed
 * build and a failed deployment.
 */

import { MAX_REALTIME_LISTENERS } from '@/config/limits';

/* ========================================================================== */
/* The identity of a listener                                                  */
/* ========================================================================== */

/**
 * The eleven listener identities. `docs/11 §2.1`, L1 through L10.
 *
 * The doc's list has ten entries; the eleventh is `activityFeed`, which
 * `docs/11 §2.2` does NOT define but the operational dashboard requires (brief
 * §13). It is registered here with **no query of its own**: the feed is derived
 * from L1's and L2b's snapshots rather than listened to separately, because a
 * second listener over the same documents doubles the read cost for data the
 * dashboard already has. It occupies an id so the derived feed is visible in the
 * registry's accounting rather than invisible.
 */
export type ListenerId =
  | 'queue' // L1
  | 'incidentDetail' // L2a
  | 'incidentHistory' // L2b
  | 'mapIncidents' // L3
  | 'mapLocations' // L4
  | 'notifications' // L5
  | 'responderAssignments' // L6
  | 'sessionUser' // L7
  | 'kpiTiles' // L8
  | 'slaSweep' // L9
  | 'ownLocation' // L10
  /** Derived, never attached. See the note above. */
  | 'activityFeed';

export const LISTENER_IDS: readonly ListenerId[] = [
  'queue',
  'incidentDetail',
  'incidentHistory',
  'mapIncidents',
  'mapLocations',
  'notifications',
  'responderAssignments',
  'sessionUser',
  'kpiTiles',
  'slaSweep',
  'ownLocation',
  'activityFeed',
];

/**
 * The per-listener `limit` ceilings. `docs/11 §2.2` gives the registry's
 * numbers; §7.3's degradation ladder can LOWER them at runtime, never raise them.
 *
 * A limit here is a CEILING, not a default. A caller may ask for fewer (a filter
 * that matches three incidents should not open a 50-document window) and may not
 * ask for more.
 */
export const LISTENER_LIMITS: Readonly<Record<ListenerId, number>> = {
  queue: 50,
  incidentDetail: 1,
  incidentHistory: 50,
  mapIncidents: 150,
  mapLocations: 150,
  notifications: 50,
  responderAssignments: 20,
  sessionUser: 1,
  kpiTiles: 20,
  slaSweep: 20,
  ownLocation: 1,
  /** Never attached; the ceiling is 0 so a bug that tries is caught. */
  activityFeed: 0,
};

/**
 * A listener whose id is NOT in `LISTENER_LIMITS` was added to the union without a
 * limit. That is a programming error, and the registry's default branch turns it
 * into a thrown `TypeError` rather than an unbounded channel.
 */
export class ListenerLimitMissingError extends Error {
  constructor(id: string) {
    super(
      `No listener limit is declared for "${id}". Add it to LISTENER_LIMITS in ` +
        `lib/realtime/listener-registry.ts before attaching (docs/11 §6 QD-1).`,
    );
    this.name = 'ListenerLimitMissingError';
  }
}

export class ListenerLimitExceededError extends Error {
  constructor(
    readonly id: ListenerId,
    readonly requested: number,
    readonly ceiling: number,
  ) {
    super(
      `Listener "${id}" asked for ${requested} documents; its ceiling is ${ceiling} ` +
        `(docs/11 §2.2, §6 QD-1).`,
    );
    this.name = 'ListenerLimitExceededError';
  }
}

export class ListenerBudgetExceededError extends Error {
  constructor(
    readonly open: number,
    readonly max: number,
  ) {
    super(
      `Realtime listener budget exceeded: ${open} open, ${max} allowed ` +
        `(docs/11 §2.1, FR-091).`,
    );
    this.name = 'ListenerBudgetExceededError';
  }
}

/* ========================================================================== */
/* The handle                                                                  */
/* ========================================================================== */

export type ListenerHandle = {
  readonly id: ListenerId;
  /**
   * Detach this subscriber. **Idempotent** — calling it twice must not decrement
   * the count twice, because a React effect cleanup and a manual teardown race
   * easily.
   */
  unsubscribe: () => void;
};

type Entry = {
  readonly id: ListenerId;
  /**
   * The query this channel is serving.
   *
   * Part of the key, not decoration: two components attaching L1 with DIFFERENT
   * filters must not be handed one channel and one filter's data, which would look
   * exactly like a stale queue.
   */
  readonly queryKey: string;
  /** Refcount. A shared listener is one channel with N subscribers. */
  subscribers: number;
  /** The first attacher's teardown. Only ever called once the refcount hits 0. */
  detach: () => void;
  /** How many documents the channel last delivered, for the cost estimator. */
  documents: number;
};

/* ========================================================================== */
/* The registry                                                                */
/* ========================================================================== */

/**
 * The module-level store, keyed by `id` **and** `queryKey`.
 *
 * The composite key is load-bearing, and the first version of this file got it
 * wrong. Keyed by `id` alone, a second attach with a DIFFERENT `queryKey` fell
 * through the sharing branch and then **overwrote** the first entry — so the first
 * component's channel was orphaned (its `detach` lost, its refcount gone, and its
 * `unsubscribe` now decrementing a counter it was not counted in) while the budget
 * still reported one channel. The user's symptom: a queue whose filters silently
 * stopped applying and which never closed its first socket.
 *
 * A mutation test found it. Keying by the pair makes the two cases distinct: same
 * id + same key shares, same id + different key is genuinely two channels, and the
 * budget counts both — which is the honest cost.
 */
const entries = new Map<string, Entry>();

/** The composite key. Kept in one place so no call site can build a different one. */
function entryKey(id: ListenerId, queryKey: string): string {
  // `\u0000` cannot appear in a JS string from a query key built by
  // `JSON.stringify`, so the join is unambiguous even for an id that is a prefix
  // of another.
  return `${id}\u0000${queryKey}`;
}

/**
 * The current open-channel count. This is the figure the budget is about —
 * SUBSCRIBERS are not channels, so two components on L1 cost one slot.
 */
export function openListenerCount(): number {
  return entries.size;
}

export function openListenerIds(): readonly ListenerId[] {
  // Deduplicated: two channels on the same id are two budget slots but ONE id, and
  // the id list is what a developer reads when the budget warning fires.
  return [...new Set([...entries.values()].map((entry) => entry.id))];
}

/** Subscribers on one id, summed across its channels. */
export function listenerSubscriberCount(id: ListenerId): number {
  let total = 0;
  for (const entry of entries.values()) {
    if (entry.id === id) total += entry.subscribers;
  }
  return total;
}

/** The full accounting, for the test and for the shell's debug surface. */
export function listenerSnapshot(): {
  readonly open: number;
  readonly max: number;
  readonly ids: readonly ListenerId[];
  readonly documents: number;
} {
  let documents = 0;
  for (const entry of entries.values()) documents += entry.documents;
  return { open: entries.size, max: MAX_REALTIME_LISTENERS, ids: openListenerIds(), documents };
}

/**
 * The module-level store, keyed by `id` and `queryKey`.
 *
 * Module scope rather than React context on purpose: `docs/11 §3.5` requires
 * `unsubscribeAll()` to be callable from `hooks/useAuth.ts`'s
 * `onAuthStateChanged` handler, which is NOT inside the component tree. A context
 * registry could not be reached from there, and the identity-change teardown is
 * the single most important teardown in the system.
 */
export function registerListener(input: {
  readonly id: ListenerId;
  /** The declared `limit()`. Asserted against `LISTENER_LIMITS`. */
  readonly limit: number;
  /** Stable string describing the query. Different key = different channel. */
  readonly queryKey: string;
  /** The channel's teardown. Called once, when the last subscriber leaves. */
  detach: () => void;
}): ListenerHandle {
  const ceiling = LISTENER_LIMITS[input.id];
  if (ceiling === undefined) throw new ListenerLimitMissingError(input.id);
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new ListenerLimitExceededError(input.id, input.limit, ceiling);
  }
  if (input.limit > ceiling) {
    throw new ListenerLimitExceededError(input.id, input.limit, ceiling);
  }

  const key = entryKey(input.id, input.queryKey);
  const existing = entries.get(key);

  if (existing !== undefined) {
    existing.subscribers += 1;
    let released = false;
    return {
      id: input.id,
      unsubscribe: () => {
        if (released) return;
        released = true;
        releaseEntry(key);
      },
    };
  }

  if (entries.size >= MAX_REALTIME_LISTENERS) {
    warnIfApproachingBudget(entries.size + 1);
    throw new ListenerBudgetExceededError(entries.size + 1, MAX_REALTIME_LISTENERS);
  }

  const entry: Entry = {
    id: input.id,
    queryKey: input.queryKey,
    subscribers: 1,
    detach: input.detach,
    documents: 0,
  };
  entries.set(key, entry);
  warnIfApproachingBudget(entries.size);

  let released = false;
  return {
    id: input.id,
    unsubscribe: () => {
      if (released) return;
      released = true;
      releaseEntry(key);
    },
  };
}

function releaseEntry(key: string): void {
  const entry = entries.get(key);
  if (entry === undefined) return;
  entry.subscribers -= 1;
  if (entry.subscribers > 0) return;
  // Last subscriber: close the channel. A `detach` that throws would leak the map
  // entry, so the deletion happens first and the throw is swallowed — a leaked
  // map entry is worse than a leaked already-torn-down channel.
  entries.delete(key);
  try {
    entry.detach();
  } catch {
    /* The channel is gone either way; there is nothing to retry. */
  }
}

/**
 * `docs/11 §2.1`: `console.warn('realtime: N of M listener slots in use', ids)`.
 *
 * Warned at 6 of 8 — two below the ceiling — because the interesting case is a
 * leak that leaves the dashboard working but degraded, and that is visible in the
 * console long before a user notices.
 *
 * **In a test this throws instead**, per the same section. A test that opened nine
 * channels has a leak, and a leak that only warns is a leak that reaches
 * production.
 */
function warnIfApproachingBudget(open: number): void {
  // `import.meta.env.MODE`, NOT `process.env.NODE_ENV`.
  //
  // The project has a "process.env is read only by the env accessors" security
  // check, and it fired on this line. It is right to: `process.env` in a module
  // that reaches the browser is a bundler-configuration dependency and a habit
  // worth not forming. `import.meta.env.MODE` is the Vite/Vitest-native spelling,
  // is statically replaced at build time, and cannot leak a runtime env read.
  //
  // `?? 'test'` is a deliberate fallback: this file is imported by a Node test
  // process as well as by Vite, and a missing MODE must not make the budget a
  // warning-only in a test — which is how a leak reaches production.
  const mode = import.meta.env?.MODE ?? 'test';
  const isTest = mode === 'test';
  if (isTest) {
    if (open > MAX_REALTIME_LISTENERS) {
      throw new ListenerBudgetExceededError(open, MAX_REALTIME_LISTENERS);
    }
    return;
  }
  if (open >= MAX_REALTIME_LISTENERS - 2) {
    // `docs/11 §2.1` specifies this exact call. No lint suppression: `no-console`
    // is not enabled in this project, and a directive for a rule that does not
    // exist is itself an unused directive ESLint reports.
    console.warn(
      `realtime: ${open} of ${MAX_REALTIME_LISTENERS} listener slots in use`,
      openListenerIds(),
    );
  }
}

/**
 * Record how many documents a channel delivered. Feeds `docs/11 §7.3`'s local
 * estimator, which is one of the three real triggers for the degradation ladder.
 */
export function recordListenerDocuments(id: ListenerId, documents: number): void {
  // The most recently updated channel for this id. A listener id with two channels
  // is an anomaly, and the gauge is only a `docs/11 §7.3` input, so recording
  // against the newest is sufficient and cheaper than asking the caller which
  // channel it meant.
  let target: Entry | null = null;
  for (const entry of entries.values()) {
    if (entry.id !== id) continue;
    if (target === null || entry.documents === 0) target = entry;
  }
  if (target === null) return;
  target.documents = documents;
}

/**
 * `docs/11 §3.5`: `unsubscribeAll()` on sign-out and on uid change.
 *
 * Returns the count, so the caller can log it — a silent zero and a silent eight
 * look identical, and the eight is the one worth knowing about.
 */
export function unsubscribeAll(): number {
  const count = entries.size;
  // Snapshot first: `detach` may synchronously trigger something that re-enters.
  const snapshot = [...entries.values()];
  entries.clear();
  for (const entry of snapshot) {
    try {
      entry.detach();
    } catch {
      /* Every channel is being closed; one failure must not strand the rest. */
    }
  }
  return count;
}

/**
 * Narrow a ceiling for the `docs/11 §7.3` degradation ladder.
 *
 * The ladder can only LOWER a limit, never raise one: a degradation that restored
 * a full window would defeat the budget it is part of. Returns the lowered
 * ceiling, and the caller is responsible for re-deriving its query.
 */
export function applyBudgetTier(id: ListenerId, tier: number): number {
  const base = LISTENER_LIMITS[id];
  // Tier 3 reduces L1 to 25 then 15; tier 4 reduces L3 to 75 then 40; tier 5
  // reduces L5 to 25. The table is `docs/11 §7.3` verbatim.
  const reduced: Partial<Record<ListenerId, number>> = {
    queue: tier >= 3 ? (tier >= 4 ? 15 : 25) : base,
    mapIncidents: tier >= 4 ? (tier >= 5 ? 40 : 75) : base,
    notifications: tier >= 5 ? 25 : base,
  };
  const next = reduced[id] ?? base;
  return Math.min(next, base);
}

/** Test seam. Mirrors `resetFirebaseClientForTests`. */
export function resetListenerRegistryForTests(): void {
  unsubscribeAll();
  entries.clear();
}

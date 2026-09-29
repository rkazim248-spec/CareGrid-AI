import { beforeEach, describe, expect, it } from 'vitest';

import {
  LISTENER_IDS,
  LISTENER_LIMITS,
  ListenerBudgetExceededError,
  ListenerLimitExceededError,
  ListenerLimitMissingError,
  applyBudgetTier,
  listenerSnapshot,
  listenerSubscriberCount,
  openListenerCount,
  recordListenerDocuments,
  registerListener,
  resetListenerRegistryForTests,
  unsubscribeAll,
} from '@/lib/realtime/listener-registry';
import { MAX_REALTIME_LISTENERS } from '@/config/limits';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

function attach(id: Parameters<typeof registerListener>[0]['id'], limit = 1, queryKey = 'k1') {
  let detached = 0;
  const handle = registerListener({
    id,
    limit,
    queryKey,
    detach: () => {
      detached += 1;
    },
  });
  return { handle, detachedCount: () => detached };
}

/**
 * `LISTENER_IDS[index]`, asserted to exist.
 *
 * `noUncheckedIndexedAccess` makes a bare index `ListenerId | undefined`, and the
 * budget tests walk the list positionally. Asserting once here keeps a typo'd
 * index a test failure naming the id, rather than a `TypeError` at `register()`.
 */
function idAt(index: number): Parameters<typeof registerListener>[0]['id'] {
  const id = LISTENER_IDS[index];
  if (id === undefined) throw new Error(`no listener id at index ${index}`);
  return id;
}

beforeEach(() => {
  resetListenerRegistryForTests();
});

/* ========================================================================== */
/* docs/11 §2.1 — the identity set                                             */
/* ========================================================================== */

describe('the ListenerId set is docs/11 §2.1 verbatim', () => {
  it('has all eleven ids, with L1-L10 named as the document names them', () => {
    // `docs/11 §2.1`'s union, plus the derived `activityFeed` this phase adds.
    expect(LISTENER_IDS).toEqual([
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
    ]);
  });

  it('gives every id a declared limit, so none can be attached unbounded', () => {
    // QD-1. An id without a limit is a programming error the registry must catch.
    for (const id of LISTENER_IDS) {
      expect(LISTENER_LIMITS[id], id).toBeTypeOf('number');
    }
  });

  it('gives the derived activityFeed a ceiling of ZERO, because it is never attached', () => {
    // The activity feed is derived from L1 and L2b rather than listened to
    // separately. A ceiling of 0 means a bug that tries to attach it is caught
    // rather than silently opening a channel.
    expect(LISTENER_LIMITS.activityFeed).toBe(0);
  });

  it('the budget is the documented 8', () => {
    expect(MAX_REALTIME_LISTENERS).toBe(8);
  });
});

/* ========================================================================== */
/* docs/11 §6 QD-1 — the limit is enforced, not reviewed                       */
/* ========================================================================== */

describe('a listener limit is ENFORCED at attach', () => {
  it('refuses a limit above the ceiling', () => {
    // `docs/11 §6` QD-1: "Always a `limit()`. No exception, no 'we'll add one
    // later'." The queue's ceiling is 50.
    expect(() => registerListener({ id: 'queue', limit: 51, queryKey: 'k', detach: () => {} })).toThrow(
      ListenerLimitExceededError,
    );
  });

  it('refuses a limit of zero, because that is an unbounded listener by another name', () => {
    // Firestore treats `limit(0)` as "no documents", not "unlimited" — but a
    // caller reaching for it is almost certainly trying to skip the argument, and
    // the registry should make the mistake loud.
    expect(() => registerListener({ id: 'queue', limit: 0, queryKey: 'k', detach: () => {} })).toThrow(
      ListenerLimitExceededError,
    );
  });

  it('refuses a negative or fractional limit', () => {
    expect(() => registerListener({ id: 'queue', limit: -1, queryKey: 'k', detach: () => {} })).toThrow();
    expect(() => registerListener({ id: 'queue', limit: 10.5, queryKey: 'k', detach: () => {} })).toThrow();
  });

  it('refuses an id with no declared limit, naming the file to fix', () => {
    // A new `ListenerId` added to the union without a limit must fail with an
    // actionable message, not open an unbounded channel.
    const forged = 'brandNewListener' as Parameters<typeof registerListener>[0]['id'];
    expect(() => registerListener({ id: forged, limit: 10, queryKey: 'k', detach: () => {} })).toThrow(
      ListenerLimitMissingError,
    );
    try {
      registerListener({ id: forged, limit: 10, queryKey: 'k', detach: () => {} });
    } catch (error) {
      // The message must point at the declaration site, not just complain.
      expect((error as Error).message).toMatch(/LISTENER_LIMITS/);
    }
  });

  it('accepts a limit AT the ceiling', () => {
    expect(() => registerListener({ id: 'queue', limit: 50, queryKey: 'k', detach: () => {} })).not.toThrow();
  });
});

/* ========================================================================== */
/* Sharing — one channel, N subscribers                                        */
/* ========================================================================== */

describe('two components wanting the same listener share ONE channel', () => {
  it('a second attach with the same queryKey does not consume a slot', () => {
    const first = attach('queue', 50);
    expect(openListenerCount()).toBe(1);

    const second = attach('queue', 50);
    // THE point of the refcount: a layout listener and a page listener for L1 are
    // one WebSocket, not two.
    expect(openListenerCount()).toBe(1);
    expect(listenerSubscriberCount('queue')).toBe(2);

    first.handle.unsubscribe();
    expect(openListenerCount()).toBe(1);
    // Still alive: one subscriber remains.
    expect(first.detachedCount()).toBe(0);

    second.handle.unsubscribe();
    expect(openListenerCount()).toBe(0);
    // Only now is the channel closed, and exactly once.
    expect(first.detachedCount()).toBe(1);
  });

  it('a DIFFERENT queryKey is a DIFFERENT channel, even for the same id', () => {
    // Two components attaching L1 with different filters must not be handed one
    // channel and one filter's data — that looks exactly like a stale queue.
    const narrow = attach('queue', 50, 'urgency=critical');
    const all = attach('queue', 50, 'urgency=critical,high,medium,low');
    expect(openListenerCount()).toBe(2);

    narrow.handle.unsubscribe();
    expect(openListenerCount()).toBe(1);
    all.handle.unsubscribe();
    expect(openListenerCount()).toBe(0);
  });

  it('unsubscribe is IDEMPOTENT — a double cleanup must not double-decrement', () => {
    // A React effect cleanup and a manual teardown race easily, and a
    // double-decrement would free a slot that is still in use.
    const a = attach('queue', 50);
    const b = attach('queue', 50);
    a.handle.unsubscribe();
    a.handle.unsubscribe();
    a.handle.unsubscribe();
    expect(listenerSubscriberCount('queue')).toBe(1);
    expect(openListenerCount()).toBe(1);
    b.handle.unsubscribe();
    expect(openListenerCount()).toBe(0);
    expect(a.detachedCount()).toBe(1);
  });
});

/* ========================================================================== */
/* The budget — docs/11 §2.1                                                   */
/* ========================================================================== */

describe('the budget is enforced', () => {
  it('the ninth channel is REFUSED', () => {
    // `docs/11 §2.1`: "throws in NODE_ENV === 'test' at 9". The registry treats
    // test and production the same way for the hard limit, because a test that
    // opened nine channels has a leak and the leak would reach production.
    const handles: { unsubscribe: () => void }[] = [];
    for (let i = 0; i < MAX_REALTIME_LISTENERS; i += 1) {
      handles.push(attach(idAt(i), 1, `k${i}`).handle);
    }
    expect(openListenerCount()).toBe(MAX_REALTIME_LISTENERS);

    expect(() => registerListener({ id: 'ownLocation', limit: 1, queryKey: 'k9', detach: () => {} })).toThrow(
      ListenerBudgetExceededError,
    );

    for (const handle of handles) handle.unsubscribe();
    expect(openListenerCount()).toBe(0);
  });

  it('the error names the count and the ceiling, so the leak is diagnosable', () => {
    try {
      for (let i = 0; i <= MAX_REALTIME_LISTENERS; i += 1) {
        registerListener({ id: idAt(i % 11), limit: 1, queryKey: `k${i}`, detach: () => {} });
      }
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ListenerBudgetExceededError);
      expect((error as ListenerBudgetExceededError).max).toBe(MAX_REALTIME_LISTENERS);
      expect((error as ListenerBudgetExceededError).open).toBeGreaterThan(MAX_REALTIME_LISTENERS);
    }
  });

  it('freeing a slot lets a new listener attach', () => {
    const handles = [];
    for (let i = 0; i < MAX_REATTACH_SLOTS; i += 1) {
      handles.push(attach(idAt(i), 1, `k${i}`).handle);
    }
    expect(() => registerListener({ id: 'ownLocation', limit: 1, queryKey: 'x', detach: () => {} })).toThrow();
    handles.pop()?.unsubscribe();
    expect(() => registerListener({ id: 'ownLocation', limit: 1, queryKey: 'x', detach: () => {} })).not.toThrow();
    resetListenerRegistryForTests();
  });
});

const MAX_REATTACH_SLOTS = 8;

/* ========================================================================== */
/* docs/11 §3.5 — teardown on identity change                                 */
/* ========================================================================== */

describe('unsubscribeAll is the sign-out and uid-change teardown', () => {
  it('closes every channel and reports the count', () => {
    // `docs/11 §3.5`: "returns the count, so the caller can log it — a silent zero
    // and a silent eight look identical, and the eight is the one worth knowing."
    const counts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      counts.push(0);
      registerListener({
        id: idAt(i),
        limit: 1,
        queryKey: `k${i}`,
        detach: () => {
          counts[i] = (counts[i] ?? 0) + 1;
        },
      });
    }
    expect(unsubscribeAll()).toBe(3);
    expect(counts).toEqual([1, 1, 1]);
    expect(openListenerCount()).toBe(0);
  });

  it('is safe to call twice, and safe when nothing is open', () => {
    expect(unsubscribeAll()).toBe(0);
    attach('queue', 50).handle.unsubscribe();
    expect(unsubscribeAll()).toBe(0);
  });

  it('a detach that THROWS does not strand the other channels', () => {
    // `docs/11 §3.5` is unconditional: a sign-out must close everything. One
    // channel whose teardown throws must not leave seven open on a user who just
    // signed out — that is a data leak across an identity change.
    let survivor = 0;
    registerListener({ id: 'queue', limit: 1, queryKey: 'a', detach: () => { throw new Error('boom'); } });
    registerListener({ id: 'kpiTiles', limit: 1, queryKey: 'b', detach: () => { survivor += 1; } });

    expect(unsubscribeAll()).toBe(2);
    expect(survivor).toBe(1);
    expect(openListenerCount()).toBe(0);
  });
});

/* ========================================================================== */
/* docs/11 §7.3 — the degradation ladder                                      */
/* ========================================================================== */

describe('the degradation ladder can only LOWER a limit', () => {
  // `docs/11 §7.3`: tier 3 reduces L1 50 -> 25 -> 15; tier 4 reduces L3 150 ->
  // 75 -> 40; tier 5 reduces L5 50 -> 25.
  it('tier 0 changes nothing', () => {
    expect(applyBudgetTier('queue', 0)).toBe(50);
    expect(applyBudgetTier('mapIncidents', 0)).toBe(150);
    expect(applyBudgetTier('notifications', 0)).toBe(50);
  });

  it('tier 3 reduces the queue to 25', () => {
    expect(applyBudgetTier('queue', 3)).toBe(25);
  });

  it('tier 4 reduces the queue to 15 and the map to 75', () => {
    expect(applyBudgetTier('queue', 4)).toBe(15);
    expect(applyBudgetTier('mapIncidents', 4)).toBe(75);
  });

  it('tier 5 reduces the map to 40 and the bell to 25', () => {
    expect(applyBudgetTier('mapIncidents', 5)).toBe(40);
    expect(applyBudgetTier('notifications', 5)).toBe(25);
  });

  it('NEVER raises a limit, at any tier', () => {
    // The single most important property: a "degradation" that restored a full
    // window would defeat the budget it exists to enforce.
    for (let tier = 0; tier <= 6; tier += 1) {
      for (const id of LISTENER_IDS) {
        expect(applyBudgetTier(id, tier), `${id} @ tier ${tier}`).toBeLessThanOrEqual(LISTENER_LIMITS[id]);
      }
    }
  });

  it('a high tier does not change a listener the ladder does not name', () => {
    // `incidentDetail`, `incidentHistory` and `sessionUser` are 1- and 50-document
    // windows that the ladder leaves alone — a 1-document listener cannot be
    // degraded, and the history timeline is the one thing a dispatcher must not
    // lose detail on.
    expect(applyBudgetTier('incidentDetail', 5)).toBe(1);
    expect(applyBudgetTier('incidentHistory', 5)).toBe(50);
    expect(applyBudgetTier('sessionUser', 5)).toBe(1);
  });
});

/* ========================================================================== */
/* The cost estimator input — docs/11 §7.3                                    */
/* ========================================================================== */

describe('the document count is recorded for the cost estimator', () => {
  it('accumulates against the open channel', () => {
    attach('queue', 50);
    recordListenerDocuments('queue', 42);
    expect(listenerSnapshot().documents).toBe(42);
    // A LATER snapshot replaces the count rather than adding to it — it is a
    // gauge of the window's current size, not a running total of every document
    // ever delivered. Adding would make the degradation ladder fire on a dashboard
    // that has been open for an hour without anything changing.
    recordListenerDocuments('queue', 7);
    expect(listenerSnapshot().documents).toBe(7);
  });

  it('ignores a record for a listener that is not open', () => {
    recordListenerDocuments('queue', 99);
    expect(listenerSnapshot().documents).toBe(0);
  });

  it('the snapshot reports the ids, so a leak is diagnosable', () => {
    attach('queue', 50, 'a');
    attach('kpiTiles', 1, 'b');
    const snapshot = listenerSnapshot();
    expect(snapshot.open).toBe(2);
    expect(snapshot.max).toBe(8);
    expect([...snapshot.ids].sort()).toEqual(['kpiTiles', 'queue']);
  });
});

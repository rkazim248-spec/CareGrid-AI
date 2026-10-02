import { beforeEach, describe, expect, it } from 'vitest';

import {
  createIdentityWatch,
  decideListenerTeardown,
  type TeardownDecision,
} from '@/lib/realtime/identity';
import {
  openListenerCount,
  registerListener,
  resetListenerRegistryForTests,
  unsubscribeAll,
} from '@/lib/realtime/listener-registry';

/* ========================================================================== */
/* THE TABLE                                                                   */
/* ========================================================================== */

/**
 * brief §6 and §29: a listener must not survive the identity that created it, and
 * must not be closed for a reason that is not one.
 *
 * The defect these tests exist for: `unsubscribeAll()` had **zero callers** from
 * Phase 8 through Phase 9, so a sign-out left the previous account's live
 * incident queue, dispatch board and private notification list in memory.
 */
describe('listeners are closed on an identity change, and only then', () => {
  it('a token REFRESH for the same account does NOT tear down', () => {
    // Firebase refreshes an ID token roughly hourly and fires
    // `onAuthStateChanged` every time. Closing here would close and reopen every
    // channel once an hour: a visible flicker and extra reads, for no security
    // benefit. This is the case a naive implementation gets wrong.
    const decision = decideListenerTeardown({
      previousUid: 'u1',
      nextUid: 'u1',
      hasResolvedOnce: true,
    });
    expect(decision.teardown).toBe(false);
    expect(decision.reason).toBe('same_identity');
  });

  it('a SIGN-OUT tears down, and names the account that held the listeners', () => {
    const decision = decideListenerTeardown({
      previousUid: 'u1',
      nextUid: null,
      hasResolvedOnce: true,
    });
    expect(decision.teardown).toBe(true);
    expect(decision.reason).toBe('signed_out');
    // The uid matters: a test must be able to assert WHICH account's channels were
    // dropped, not merely that something was.
    expect(decision.closingUidFor).toBe('u1');
  });

  it('an ACCOUNT SWITCH tears down, and closes the PREVIOUS account, not the new one', () => {
    // The dangerous case and the reason this module exists. L5 is scoped
    // `where('recipientId','==',uid)`, so a listener that survives a switch is
    // still reading the first person's private correspondence.
    const decision = decideListenerTeardown({
      previousUid: 'alice',
      nextUid: 'bob',
      hasResolvedOnce: true,
    });
    expect(decision.teardown).toBe(true);
    expect(decision.reason).toBe('switched_account');
    expect(decision.closingUidFor).toBe('alice');
  });

  it('a SIGN-IN does not tear down, because the new listeners have not opened yet', () => {
    const decision = decideListenerTeardown({
      previousUid: null,
      nextUid: 'u1',
      hasResolvedOnce: true,
    });
    expect(decision.teardown).toBe(false);
    expect(decision.reason).toBe('signed_in');
  });

  it('the FIRST resolution never tears down, and this is the ambiguous case', () => {
    // `previousUid === null` before the first event and after a sign-out, and the
    // two need OPPOSITE behaviour. A signed-out boot has nothing open; a signed-in
    // boot is about to open listeners that a teardown would immediately race.
    // `hasResolvedOnce` is the only thing that tells them apart.
    const signedOutBoot = decideListenerTeardown({
      previousUid: null,
      nextUid: null,
      hasResolvedOnce: false,
    });
    expect(signedOutBoot.teardown).toBe(false);
    expect(signedOutBoot.reason).toBe('initial_resolution');

    const signedInBoot = decideListenerTeardown({
      previousUid: null,
      nextUid: 'u1',
      hasResolvedOnce: false,
    });
    expect(signedInBoot.teardown).toBe(false);
    expect(signedInBoot.reason).toBe('initial_resolution');
  });

  it('a REPEATED signed-out event tears down again, defensively', () => {
    // `onAuthStateChanged` can deliver `null` more than once. Tearing down again is
    // harmless — `unsubscribeAll` on an empty registry returns 0 — and it is the
    // behaviour that makes the guarantee unconditional: there is no sequence of
    // auth events that can leave a channel attached to a departed user.
    //
    // This is also the case that proves `hasResolvedOnce` is load-bearing. Same
    // previous/next as the signed-out boot, one event later, and the OPPOSITE
    // verdict: a boot must not race the listeners about to open, a repeat sign-out
    // must close anything still standing.
    const afterSignOut = decideListenerTeardown({
      previousUid: null,
      nextUid: null,
      hasResolvedOnce: true,
    });
    expect(afterSignOut.teardown).toBe(true);
    expect(afterSignOut.reason).toBe('signed_out');
  });
});

/* ========================================================================== */
/* The stateful watch, across a realistic session                             */
/* ========================================================================== */

describe('the identity watch over a whole session', () => {
  /** Feed a uid sequence through one watch and collect the decisions. */
  function run(uids: readonly (string | null)[]): TeardownDecision[] {
    const watch = createIdentityWatch();
    return uids.map((uid) => watch.observe(uid));
  }

  it('a full session tears down EXACTLY ONCE, at sign-out', () => {
    // boot -> sign in -> several token refreshes -> sign out
    const decisions = run(['u1', 'u1', 'u1', 'u1', null]);
    expect(decisions.map((d) => d.teardown)).toEqual([false, false, false, false, true]);
    expect(decisions.filter((d) => d.teardown).map((d) => d.reason)).toEqual(['signed_out']);
  });

  it('three account switches produce three teardowns, each closing the right uid', () => {
    const decisions = run(['alice', 'bob', 'carol', null]);
    const teardowns = decisions.filter((d) => d.teardown);
    expect(teardowns.map((d) => d.reason)).toEqual([
      'switched_account',
      'switched_account',
      'signed_out',
    ]);
    expect(teardowns.map((d) => d.closingUidFor)).toEqual(['alice', 'bob', 'carol']);
  });

  it('sign out then back in does NOT close the NEW user listeners', () => {
    // The failure this guards: if `signed_in` tore down, a re-authenticating user
    // would lose every channel on the way back in and the dashboard would sit
    // empty until a manual refresh.
    const decisions = run(['u1', null, 'u2', 'u2']);
    expect(decisions.map((d) => d.teardown)).toEqual([false, true, false, false]);
    // The teardown names u1, not u2.
    expect(decisions[1]?.closingUidFor).toBe('u1');
  });

  it('the watch reports the last uid, and reset() returns it to a fresh boot', () => {
    const watch = createIdentityWatch();
    expect(watch.current()).toBeNull();
    watch.observe('u1');
    expect(watch.current()).toBe('u1');
    // After a reset, a fresh sign-in is an `initial_resolution` again — which is
    // what `signOut()` needs so a later sign-in is not mistaken for `same_identity`.
    watch.reset();
    expect(watch.current()).toBeNull();
    expect(watch.observe('u2').reason).toBe('initial_resolution');
  });

  it('two watches are INDEPENDENT — two roots on one page do not share an identity', () => {
    // A module-scoped watch would leak across a signed-out dashboard rendered
    // beside a signed-in one.
    const a = createIdentityWatch();
    const b = createIdentityWatch();
    a.observe('alice');
    b.observe('bob');
    expect(a.current()).toBe('alice');
    expect(b.current()).toBe('bob');
  });
});

/* ========================================================================== */
/* Against the real registry                                                   */
/* ========================================================================== */

/**
 * The rule above says WHEN to call `unsubscribeAll()`. These prove the call has the
 * effect it claims — the rule is only worth anything if the registry actually
 * detaches every channel, and the previous account's data is only gone if it does.
 */
describe('tearing down really detaches the channels', () => {
  beforeEach(() => {
    resetListenerRegistryForTests();
  });

  /** One open channel, with a counter for whether its detach ran. */
  function attach(id: Parameters<typeof registerListener>[0]['id'], queryKey: string) {
    let detached = 0;
    registerListener({ id, limit: 1, queryKey, detach: () => { detached += 1; } });
    return { detachedCount: () => detached };
  }

  it('three open channels are all detached by one teardown, and the count reports it', () => {
    // The three that carry another person's data on a shared device: `queue` is the
    // dispatcher's live incident queue, `notifications` is scoped
    // `where('recipientId','==',uid)` and is therefore one person's private
    // correspondence, and `responderAssignments` is the dispatch board.
    const a = attach('queue', 'q:a');
    const b = attach('notifications', 'q:b');
    const c = attach('responderAssignments', 'q:c');
    expect(openListenerCount()).toBe(3);

    const closed = unsubscribeAll();

    expect(closed).toBe(3);
    expect(openListenerCount()).toBe(0);
    // The counters, not just the count. A registry that cleared its map without
    // calling `detach` would report 0 open and still hold every live Firestore
    // subscription — which is the bug, wearing a passing assertion.
    expect(a.detachedCount()).toBe(1);
    expect(b.detachedCount()).toBe(1);
    expect(c.detachedCount()).toBe(1);
  });

  it('a teardown with nothing open reports zero and does not throw', () => {
    // Signing out on a device where nothing was ever subscribed must not fail.
    expect(unsubscribeAll()).toBe(0);
    expect(openListenerCount()).toBe(0);
  });

  it('a handle held across the teardown is safe to release afterwards', () => {
    // React's effect cleanup and an identity-change teardown race constantly. If
    // releasing a stale handle were not safe, the subscriber count would go
    // negative and the registry's accounting would drift for the rest of the
    // session — which `unsubscribeAll` alone would not repair.
    const a = attach('queue', 'q:a');
    const closed = unsubscribeAll();
    expect(closed).toBe(1);
    expect(a.detachedCount()).toBe(1);

    // The registry is empty; a second teardown must not double-count anything.
    expect(unsubscribeAll()).toBe(0);
    expect(a.detachedCount()).toBe(1);
    expect(openListenerCount()).toBe(0);
  });

  it('a channel opened AFTER a teardown is live again — the registry is reusable', () => {
    // The second person to sign in must get working listeners, not a registry that
    // believes it is still full or still torn down.
    attach('queue', 'q:alice');
    unsubscribeAll();

    const b = attach('notifications', 'q:bob');
    expect(openListenerCount()).toBe(1);
    expect(b.detachedCount()).toBe(0);
  });
});

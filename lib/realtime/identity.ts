/**
 * ============================================================================
 * CareGrid AI — when to tear down realtime listeners on an auth event
 * ============================================================================
 *
 * `docs/11 §3.5`. **PURE.** No Firebase, no React, no registry import.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FIXES
 * ---------------------------------------------------------------------------
 * `unsubscribeAll()` existed from Phase 8 and had **zero callers**. Nothing ever
 * closed a listener on an identity change.
 *
 * A Firestore listener is a *subscription with a captured credential*. When the
 * signed-in user changes, the queries behind L1–L10 are wrong: L5 is scoped
 * `where('recipientUid','==',uid)`, so the listener is reading **one person's
 * private correspondence** the moment a second account authenticates on the same
 * browser. L1 is the dispatcher's live incident queue, L3 the incident list, L7
 * the dispatch board.
 *
 * The token changing is not the trigger — the *identity* is. Firebase refreshes an
 * ID token roughly hourly, and `onAuthStateChanged` fires on every refresh. Tearing
 * down on the token would close and reopen every channel once an hour, which is a
 * visible flicker and extra reads for no security benefit.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DECISION IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * The rule is four cases and a boundary condition, and it is the kind of rule that
 * is wrong in a way nobody notices: get the "same identity" case wrong and the
 * dashboard silently loses its listeners every hour; get the "first resolution"
 * case wrong and every listener is torn down on boot.
 *
 * Testing it through `onAuthStateChanged` would need a live Firebase instance, so
 * the rule is separated from the wiring: this module decides, `lib/firebase/auth.ts`
 * acts. The suite can then prove every case without a browser, which is the only
 * way it gets proven at all.
 */

/** Why a teardown did or did not happen. */
export type ListenerTeardownReason =
  /** The first event after boot. Nothing was open, so there is nothing to close. */
  | 'initial_resolution'
  /** A token refresh for the same account. A teardown here would be a bug. */
  | 'same_identity'
  /** A user arrived. Their listeners open from the new uid. */
  | 'signed_in'
  /** A user left. Their listeners must not outlive them. */
  | 'signed_out'
  /** A different account arrived. The previous one's listeners must not survive. */
  | 'switched_account';

export type TeardownDecision = {
  /** `true` only when listeners must be closed. */
  readonly teardown: boolean;
  readonly reason: ListenerTeardownReason;
  /**
   * The uid whose listeners are being closed, or `null` on sign-out.
   *
   * Recorded so the log line names the account that held them, and so a test can
   * assert *which* account's channels were dropped rather than merely that
   * something was.
   */
  readonly closingUidFor: string | null;
};

export type IdentityEvent = {
  /** The uid from the previous event, or `null` before the first one. */
  readonly previousUid: string | null;
  /** The uid from this event, or `null` for a sign-out. */
  readonly nextUid: string | null;
  /**
   * Has `onAuthStateChanged` produced at least one event yet?
   *
   * **This is the parameter that makes `previousUid === null` ambiguous.** Before
   * the first event, `previousUid` is `null` because nothing has been seen; after a
   * sign-out it is `null` because the last user left. Those need opposite
   * behaviour — the first must NOT tear down (there is nothing open and tearing
   * down would race the listeners that are about to open) and the second MUST.
   */
  readonly hasResolvedOnce: boolean;
};

/**
 * The rule, in one place.
 *
 * | Event | Teardown | Why |
 * | --- | :-: | --- |
 * | first resolution, no user (signed out at boot) | no | nothing is open; tearing down races the listeners about to open |
 * | first resolution, a user (already signed in) | no | their listeners have not opened yet |
 * | same uid again (token refresh) | **no** | an hourly flicker, for no security gain |
 * | `null` → a uid (signed in) | no | the new account's listeners open from the new uid |
 * | a uid → `null` (signed out) | **yes** | the user's channels must not outlive them |
 * | uid A → uid B (account switch) | **yes** | A's listeners are still bound to A's queries |
 */
export function decideListenerTeardown(event: IdentityEvent): TeardownDecision {
  // The first event is never a teardown, whatever it carries. On a signed-out boot
  // there is nothing open; on a signed-in boot the new listeners are about to open
  // and closing first would only make them re-open. `previousUid` is null in both
  // cases, which is exactly why `hasResolvedOnce` exists.
  if (!event.hasResolvedOnce) {
    return { teardown: false, reason: 'initial_resolution', closingUidFor: null };
  }

  // A token refresh. The common case, and the one a naive implementation gets
  // wrong: Firebase fires this roughly hourly for every signed-in user.
  if (event.previousUid !== null && event.previousUid === event.nextUid) {
    return { teardown: false, reason: 'same_identity', closingUidFor: null };
  }

  if (event.nextUid === null) {
    return { teardown: true, reason: 'signed_out', closingUidFor: event.previousUid };
  }

  if (event.previousUid === null) {
    return { teardown: false, reason: 'signed_in', closingUidFor: null };
  }

  // uid A -> uid B. The dangerous one, and the reason this function exists.
  return { teardown: true, reason: 'switched_account', closingUidFor: event.previousUid };
}

/* ========================================================================== */
/* The observable state, and the one function that advances it                */
/* ========================================================================== */

/**
 * A closure holding "who was signed in last".
 *
 * **Module-scoped state would be a test-ordering hazard** and would leak between
 * two React roots in the same page (a signed-out dashboard rendered alongside a
 * signed-in one). Holding it in a factory and passing it to the wiring means each
 * installation owns its own, and a test can make a fresh one.
 */
export type IdentityWatch = {
  /** Decide, and record the new identity. */
  readonly observe: (nextUid: string | null) => TeardownDecision;
  /** The uid from the last event, or `null`. */
  readonly current: () => string | null;
  /** Forget everything. Only for tests and for a forced teardown. */
  readonly reset: () => void;
};

export function createIdentityWatch(): IdentityWatch {
  let previousUid: string | null = null;
  let hasResolvedOnce = false;

  return {
    observe(nextUid) {
      const decision = decideListenerTeardown({ previousUid, nextUid, hasResolvedOnce });
      previousUid = nextUid;
      hasResolvedOnce = true;
      return decision;
    },
    current: () => previousUid,
    reset() {
      previousUid = null;
      hasResolvedOnce = false;
    },
  };
}

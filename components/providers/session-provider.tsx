'use client';

/**
 * ============================================================================
 * CareGrid AI — the session provider
 * ============================================================================
 *
 * ONE owner of "who is signed in, as what, and what may they do". Mounted once,
 * in the root layout, and read by everything (docs/05 §8.2).
 *
 * ---------------------------------------------------------------------------
 * THE THREE BLOCKS ON CLIENT-SIDE ROLE TAMPERING
 * ---------------------------------------------------------------------------
 * The Phase 2 requirement is that a user cannot become an admin by editing
 * browser storage. There are four independent mechanisms, and this file is only
 * responsible for the first two:
 *
 *   1. **`role` is never read from storage.** This provider holds the role it
 *      received from `GET /api/me`, which the server computed from
 *      `users/{uid}.role`. There is no code path that reads a role from
 *      `localStorage`, a query string, a request header, or a form field. An
 *      earlier draft of this file had a `cg.previewRole` key for reviewing all
 *      four shells in one build — that key is GONE, and its removal is the
 *      point of this rewrite.
 *   2. **`permissions` comes from the server**, not from `can(role, cap)`. Even
 *      if a role were somehow spoofed in memory, the permission list would
 *      still be the server's.
 *   3. **`firestore.rules` sets `users: allow write: if false`.** Editing the
 *      document in the Firebase console from a browser fails.
 *   4. **Every API route re-checks.** A forged UI is irrelevant; a forged
 *      request is rejected by `requireUser()`.
 *
 * A reviewer can verify (1) with `rg localStorage lib/auth components/providers`
 * and (3) by reading one line of `firestore.rules`.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO MIDDLEWARE
 * ---------------------------------------------------------------------------
 * docs/05 §9.1 sketches a middleware that reads a session cookie. docs/10
 * §12.1 and §12.3 state that this product uses NO session cookies — every API
 * call carries `Authorization: Bearer <Firebase ID token>`. So there is nothing
 * at the Edge to read, and the Firestore Admin SDK (the only way to read the
 * authoritative role) does not run on the Edge runtime.
 *
 * Rather than invent a cookie to satisfy the middleware sketch, this build does
 * what docs/05 §9.2 prescribes: the redirect happens in a Client Component
 * (`RequireSession`), and the AUTHORITATIVE checks are the API guard and the
 * rules. A middleware that redirected based on a cookie it cannot verify would
 * be a security control that looks like one — worse than none.
 *
 * ---------------------------------------------------------------------------
 * THE BOOT SEQUENCE
 * ---------------------------------------------------------------------------
 *   1. `getFirebaseClient()` — throws if the public config is missing. Handled
 *      by rendering a setup notice, not a crash.
 *   2. `onAuthStateChanged` — resolves the first time, then only on change.
 *      EXACTLY ONE subscription for the whole app, cleaned up on unmount.
 *   3. `GET /api/me` — the server-computed user, profile and permissions.
 *   4. `POST /api/me/bootstrap` — only when a Firebase user has no profile yet.
 *   5. Install the token provider so `apiFetch` can sign its requests.
 *
 * Steps 3 and 4 are separate requests on purpose: `GET /api/me` is the read, and
 * bootstrap is a write with a side effect (creating two documents). Merging them
 * would mean every page load wrote to Firestore, which is a write per page view
 * and a cost the free tier does not need to pay.
 */

import * as React from 'react';

import {
  AuthError,
  clearUserScopedStorage,
  getIdToken,
  refreshTokenAndUser,
  signOut as firebaseSignOut,
  subscribeToAuthState,
  type MeResponse,
} from '@/lib/firebase/auth';
import {
  ApiError,
  SESSION_EXPIRED_EVENT,
  authEvent,
  clearTokenProvider,
  meBootstrap,
  meGet,
  setTokenProvider,
} from '@/lib/api/client';
import { firebaseConfigurationProblem, getAppEnv, isFirebaseConfigured } from '@/lib/env.client';
import { landingFor, rolesForRoute, routeAllows } from '@/lib/auth/roles';
import { APP_TIMEZONE, DEMO_NOW } from '@/lib/format';
import { USER_ROLES } from '@/types/enums';
import type { AccountStatus, UserRole } from '@/types/enums';

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

export type AuthStatus =
  /** The Firebase listener has not resolved yet. SHOW A SKELETON. */
  | 'initialising'
  /** No Firebase user. */
  | 'signed-out'
  /** A Firebase user exists; the profile fetch is still running. */
  | 'loading-profile'
  /** Fully resolved. */
  | 'signed-in'
  /**
   * A Firebase user exists but `/api/me` failed, or the account is not
   * `active`. Distinct from `signed-out` because the user IS authenticated —
   * showing them the login form would be wrong and confusing.
   */
  | 'error'
  /** No `.env.local`. Nothing can work; say so plainly. */
  | 'unconfigured';

export type SessionState = {
  authStatus: AuthStatus;
  /** The Firebase user, or null. Never a mock. */
  firebaseUser: { uid: string; email: string | null; displayName: string | null; emailVerified: boolean; photoURL: string | null } | null;
  /** The server-computed user record. The ONLY place a role enters the app. */
  user: MeResponse['user'] | null;
  /** null while loading. A missing profile is a first-run state, not an error. */
  profile: MeResponse['profile'];
  /** Server-computed. Do not recompute from `role`. */
  permissions: readonly string[];
  role: UserRole | null;
  accountStatus: AccountStatus | null;
  isAuthenticated: boolean;
  /** True when the account is signed in but blocked (`status !== 'active'`). */
  isAccountBlocked: boolean;
  /** A user-facing sentence, or null. Safe to render verbatim. */
  error: { code: string; message: string } | null;
  /** Set when no Firebase config exists. Explains why nothing works. */
  configurationProblem: string | null;
  /** Where this role should land after signing in. */
  landingRoute: string | null;
  /** `true` while any auth operation is in flight. */
  isBusy: boolean;

  /* --- actions --------------------------------------------------------- */
  refreshToken: () => Promise<string | null>;
  refreshMe: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = React.createContext<SessionState | null>(null);

/* ========================================================================== */
/* Provider                                                                   */
/* ========================================================================== */

export function SessionProvider({
  children,
  defaultTimezone = APP_TIMEZONE,
}: {
  children: React.ReactNode;
  defaultTimezone?: string;
}) {
  const [authStatus, setAuthStatus] = React.useState<AuthStatus>('initialising');
  const [firebaseUser, setFirebaseUser] = React.useState<SessionState['firebaseUser']>(null);
  const [me, setMe] = React.useState<MeResponse | null>(null);
  const [error, setError] = React.useState<SessionState['error']>(null);
  const [isBusy, setIsBusy] = React.useState(false);

  /* --- 0. the configuration problem, DERIVED not stored ------------------- */
  // The single most important line in this file, and it exists because of a bug
  // worth reading about.
  //
  // This was `useState<string | null>(null)` set from a `useEffect`, and the auth
  // subscription below guarded on it with `if (configurationProblem !== null)
  // return;`. That guard does not work on the first render, and the failure was
  // a hard crash rather than a bad-looking page:
  //
  //   commit 1, effect 1  isFirebaseConfigured() is false, so it calls
  //                      setConfigurationProblem(problem) — which SCHEDULES a
  //                      re-render. It does not mutate the value.
  //   commit 1, effect 2  reads `configurationProblem` through its closure, which
  //                      is still the initial `null`. The guard passes.
  //                      subscribeToAuthState() -> auth() -> getFirebaseClient()
  //                      -> getPublicConfig() -> throws EnvError.
  //
  // React does not wrap effects in try/catch, so that throw became an uncaught
  // error and the app showed a red screen instead of the setup notice this file's
  // own header promises. Effect 2 DID list `configurationProblem` in its
  // dependencies and would have skipped on the second render — but the throw had
  // already happened.
  //
  // The lesson is the shape of the bug, not the bug: **a guard built on state that
  // starts in the "not yet known" position is not a guard.** It is correct only
  // after a re-render it has no reason to wait for. Anything that must be known
  // synchronously on the first commit has to be DERIVED, not stored.
  //
  // `useMemo` with an empty dependency array is correct rather than lazy here:
  // `process.env.NEXT_PUBLIC_*` is inlined at build time, so this value cannot
  // change for the lifetime of the page. The alternative — a module-level
  // constant — would be marginally cheaper and would make the value untestable
  // and un-overridable, which is a worse trade for one string comparison.
  const configurationProblem = React.useMemo(
    () => (isFirebaseConfigured() ? null : firebaseConfigurationProblem()),
    [],
  );

  // Guards against the race that actually bites: `onAuthStateChanged` fires
  // during sign-out with `user === null` while a `GET /api/me` from the previous
  // session is still in flight. Without a generation counter, that late response
  // would repopulate the session for a user who just signed out.
  const generationRef = React.useRef(0);
  const isMountedRef = React.useRef(true);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /* --- 1. configuration ------------------------------------------------- */
  // `configurationProblem` is already derived (see above), so this effect only
  // has to move the STATUS. It cannot be folded into the render: `authStatus` is
  // consumed by `useResolvedSession`, and an early return between two
  // `useState` calls is a rules-of-hooks violation.
  React.useEffect(() => {
    if (configurationProblem === null) return;
    setAuthStatus('unconfigured');
  }, [configurationProblem]);

  /* --- the profile load ------------------------------------------------- */
  const loadMe = React.useCallback(
    async (uid: string, generation: number, timezone: string) => {
      try {
        let meResponse: MeResponse;
        try {
          meResponse = await meGet();
        } catch (apiError) {
          if (apiError instanceof ApiError && apiError.code === 'ACCOUNT_UNAVAILABLE') {
            // A Firebase account with no `users/{uid}` document. That is exactly
            // the first-run case, so bootstrap it rather than showing an error.
            await meBootstrap({
              displayName: 'New member',
              timezone,
              locale: 'en',
            });
            meResponse = await meGet();
          } else {
            throw apiError;
          }
        }

        // A response for a session the user has already left. Discard it.
        if (generation !== generationRef.current || !isMountedRef.current) return;

        setMe(meResponse);
        setAuthStatus(meResponse.user.status === 'active' ? 'signed-in' : 'error');
        if (meResponse.user.status !== 'active') {
          setError({
            code: 'ACCOUNT_UNAVAILABLE',
            message: accountStatusMessage(meResponse.user.status),
          });
        }
      } catch (caught) {
        if (generation !== generationRef.current || !isMountedRef.current) return;
        setMe(null);
        setAuthStatus('error');
        setError(toSessionError(caught));
      }
    },
    // The timezone arrives as a PARAMETER, so the prop is never captured in the
    // callback body. Listing it would recreate the callback on every render for
    // no reason, which is exactly the kind of unnecessary identity churn that
    // makes downstream memoisation quietly stop working.
    [],
  );

  /* --- 2/3/4. the one Auth subscription --------------------------------- */
  React.useEffect(() => {
    if (configurationProblem !== null) return;

    // Registered BEFORE the listener fires, because the very first `GET /api/me`
    // needs it. `getIdToken` is the seam; `apiFetch` never imports Firebase.
    setTokenProvider(() => getIdToken(false));

    const unsubscribe = subscribeToAuthState((firebaseAuthUser) => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      setError(null);

      if (!firebaseAuthUser) {
        setFirebaseUser(null);
        setMe(null);
        setAuthStatus('signed-out');
        return;
      }

      setFirebaseUser({
        uid: firebaseAuthUser.uid,
        email: firebaseAuthUser.email,
        displayName: firebaseAuthUser.displayName,
        emailVerified: firebaseAuthUser.emailVerified,
        photoURL: firebaseAuthUser.photoURL,
      });
      setAuthStatus('loading-profile');
      void loadMe(firebaseAuthUser.uid, generation, defaultTimezone);
    });

    return () => {
      // A missing unsubscribe is the most common cause of "I signed out but the
      // app still thinks I am in", so it is not optional.
      unsubscribe();
      clearTokenProvider();
    };
    // `loadMe` is a `useCallback` whose only dependency is `defaultTimezone`,
    // which is itself in this list, so including it does not re-subscribe.
  }, [configurationProblem, defaultTimezone, loadMe]);

  /* --- 5. the session-expired channel ----------------------------------- */
  React.useEffect(() => {
    function onExpired() {
      // A second 401 that a single token refresh could not fix. Sign out
      // cleanly rather than leaving the user staring at a shell that cannot load
      // anything.
      void handleSignOut();
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    // `handleSignOut` is stable via useCallback below; the empty dep list here is
    // intentional so the listener is registered exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- actions ---------------------------------------------------------- */
  const refreshMe = React.useCallback(async () => {
    if (!firebaseUser) return;
    await loadMe(firebaseUser.uid, generationRef.current + 1, defaultTimezone);
    generationRef.current += 1;
  }, [firebaseUser, loadMe, defaultTimezone]);

  const refreshToken = React.useCallback(async (): Promise<string | null> => {
    // The user-triggered "Refresh session" action on a ROLE_MISMATCH state
    // (docs/05 §8.3). Never called on a timer and never in a loop: a silent
    // refresh could change the UI under an operator mid-decision.
    await refreshTokenAndUser();
    await refreshMe();
    return getIdToken(false);
  }, [refreshMe]);

  const handleSignOut = React.useCallback(async () => {
    setIsBusy(true);
    try {
      // Best-effort audit BEFORE the token is released — after sign-out there is
      // no token to authenticate the request with, and an unauthenticated audit
      // entry would be worthless. `authEvent` swallows its own failures.
      await authEvent({ type: 'logout', provider: 'password' });

      await firebaseSignOut();

      // Local state, in this order, so nothing can read a stale session.
      generationRef.current += 1;
      setMe(null);
      setFirebaseUser(null);
      setError(null);
      clearTokenProvider();
      setAuthStatus('signed-out');
    } finally {
      if (isMountedRef.current) setIsBusy(false);
    }
  }, []);

  const value = React.useMemo<SessionState>(() => {
    const role = me?.user.role ?? null;
    const status = me?.user.status ?? null;
    return {
      authStatus,
      firebaseUser,
      user: me?.user ?? null,
      profile: me?.profile ?? null,
      // Server-computed. An empty list during loading is CORRECT: a screen that
      // renders based on permissions shows nothing until the server has spoken,
      // rather than guessing from a possibly-stale role.
      permissions: me?.permissions ?? [],
      role,
      accountStatus: status,
      isAuthenticated: authStatus === 'signed-in',
      isAccountBlocked: status !== null && status !== 'active',
      error,
      configurationProblem,
      landingRoute: role === null ? null : landingFor(role),
      isBusy,
      refreshToken,
      refreshMe,
      signOut: handleSignOut,
    };
  }, [
    authStatus,
    firebaseUser,
    me,
    error,
    configurationProblem,
    isBusy,
    refreshToken,
    refreshMe,
    handleSignOut,
  ]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = React.useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return ctx;
}

/**
 * The fallback every consumer destructures from when the session is unresolved.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERYTHING IS NULL AND NOT A PLACEHOLDER USER
 * ---------------------------------------------------------------------------
 * An earlier version of the Phase 1 shell had a `mockUser` fallback so a
 * component could never see `null`. That is precisely the habit this rewrite
 * exists to remove: a placeholder user in a component tree is a mock identity,
 * and a mock identity that survives into a real session is how a demo value ends
 * up on a production screen.
 *
 * So the fallback is all-null, and each consumer guards. Inside `RequireSession`
 * the guard never fires, which is why it is cheap — but it is still typed, so
 * "what happens when there is no user?" is answered by the compiler rather than
 * by whichever component happens to render first.
 *
 * `isAllowed` returns `false` for everything: rendering no affordance is correct
 * when the role is unknown, and removing a button later is a far better failure
 * than showing a button that must be taken back.
 */
export const UNRESOLVED_SESSION = {
  user: null,
  role: null,
  profile: null,
  permissions: [] as readonly string[],
  firebaseUser: null,
  isAllowed: (_href: string) => false,
  allowedRolesFor: (_href: string) => USER_ROLES as readonly UserRole[],
  error: null,
  accountStatus: null,
  isAuthenticated: false,
  isAccountBlocked: false,
  authStatus: 'initialising' as const,
  configurationProblem: null,
  landingRoute: null,
  isBusy: false,
  refreshToken: async () => null,
  refreshMe: async () => undefined,
  signOut: async () => undefined,
} as const;

/**
 * A session for components mounted inside the gate.
 *
 * `Omit` rather than an intersection: `SessionState & { user: User }` would
 * still type `user` as `User | null`, because the intersection of `User | null`
 * and `User` is the nullable one. `Omit` REPLACES the property.
 *
 * The fields are still runtime-nullable through `UNRESOLVED_SESSION`, which is
 * why the shell and the feature views use `user?.displayName ?? '—'` rather than
 * assuming. That is deliberate: the alternative is a fabricated identity.
 */
export type ResolvedSession = Omit<SessionState, 'user' | 'role' | 'permissions' | 'profile'> & {
  user: SessionState['user'];
  role: SessionState['role'];
  permissions: readonly string[];
  profile: SessionState['profile'];
  firebaseUser: SessionState['firebaseUser'];
  /** An AFFORDANCE, not a boundary — see `lib/auth/permissions.ts`. */
  isAllowed: (href: string) => boolean;
  allowedRolesFor: (href: string) => readonly UserRole[];
};

/**
 * The session for components that live INSIDE the gate.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NON-NULLABLE
 * ---------------------------------------------------------------------------
 * The shell and the feature views sit under `RequireSession`, which does not
 * render them until a session resolves. So within them, "no session" is not a
 * reachable state — and if it ever were, the honest answer is that the component
 * is mounted in the wrong place, which is a bug worth seeing rather than a case
 * worth handling.
 *
 * The alternative (an early `return null` when unresolved) violates the rules of
 * hooks, because it puts every subsequent `useState` behind a conditional. That
 * is a real defect, not a style preference: a query-string change can re-render
 * the same element with a different hook count.
 *
 * So the unresolved fallback exists, and it is `UNRESOLVED_SESSION` — every
 * field null, `isAllowed` always false. Nothing renders a fabricated identity,
 * and a developer who mounts one of these outside the gate gets empty strings
 * and a development-mode warning rather than a mock user's name on the screen.
 */
export function useResolvedSession(): ResolvedSession {
  const session = useSession();

  // Narrowed into locals BEFORE the closures below. TypeScript does not carry a
  // property narrowing (`session.role`) into a callback, so reading the property
  // inside `isAllowed` would re-widen it to `UserRole | null` and fail to
  // compile. Capturing the narrowed value is the fix, and it is also faster.
  const { user, role, firebaseUser } = session;

  return React.useMemo<ResolvedSession>((): ResolvedSession => {
    // A component mounted outside `<RequireSession>` is a wiring bug, and it
    // renders empty values, so it must be loud in development. `console.warn` is
    // already permitted by the lint config — this is a diagnostic, not a log
    // line the server owns.
    if (process.env.NODE_ENV !== 'production' && (user === null || role === null)) {
      console.warn(
        '[session] useResolvedSession() returned an unresolved session. This component ' +
          'should be rendered inside <RequireSession>; the UI will show empty values.',
      );
    }

    return {
      ...session,
      user,
      role,
      firebaseUser,
      // An empty permission list before the server has spoken is CORRECT: a
      // screen that renders from permissions shows nothing until then, rather
      // than guessing from a possibly-stale role.
      permissions: session.permissions,
      // Derived from the SERVER-COMPUTED role, so a caller cannot influence it.
      isAllowed: (href: string) => (role === null ? false : routeAllows(href, role)),
      allowedRolesFor: (href: string) => rolesForRoute(href),
    } as ResolvedSession;
  }, [session, user, role, firebaseUser]);
}

/**
 * Is this route open to the signed-in user's role?
 *
 * An AFFORDANCE, not a boundary. `lib/auth/permissions.ts` explains why, and
 * `lib/server/auth-guard.ts` is what actually decides. Derived from the
 * SERVER-COMPUTED role, so a caller cannot influence it.
 */
export function useRouteAccess(href: string): {
  allowed: boolean;
  allowedRoles: readonly UserRole[];
} {
  const resolved = useResolvedSession();
  if (resolved === null) {
    return { allowed: false, allowedRoles: UNRESOLVED_SESSION.allowedRolesFor(href) };
  }
  return { allowed: resolved.isAllowed(href), allowedRoles: resolved.allowedRolesFor(href) };
}

/* ========================================================================== */
/* Derived hooks                                                              */
/* ========================================================================== */

/**
 * Is this route open to the signed-in user's role?
 *
 * Reads the SERVER's permission list, not a local table. A component that
 * recomputed this from `role` would be trusting a value the client holds; a
 * component that reads the server's answer is at least consistent with what the
 * API will decide.
 *
 * Either way this is an AFFORDANCE, not a boundary. The API re-checks every
 * action, and a user who forges this list sees a button that fails — they does
 * not gain a capability.
 */
export function usePermission(capability: string): boolean {
  const { permissions } = useSession();
  return permissions.includes(capability);
}

/** `true` for a signed-in user, `false` otherwise. Safe during loading. */
export function useIsAuthenticated(): boolean {
  const { isAuthenticated } = useSession();
  return isAuthenticated;
}

/**
 * The role, narrowed, or `null`.
 *
 * `role` is `UserRole | null` everywhere in this codebase. Widening it to
 * `UserRole` at a call site is how a null-check gets skipped and a citizen sees
 * the admin console chrome for one frame.
 */
export function useRole(): UserRole | null {
  const { role } = useSession();
  return role;
}

/* ========================================================================== */
/* Error presentation                                                          */
/* ========================================================================== */

/**
 * Turn any thrown value into a sentence a person can act on.
 *
 * An `AuthError` already has a curated message. An `ApiError` carries the
 * server's English string, which is authored to be shown. Anything else is a bug
 * or a thrown string, and gets a generic sentence — a raw `error.message` here
 * is how an SDK error message reaches a user.
 */
export function toSessionError(error: unknown): { code: string; message: string } {
  if (error instanceof AuthError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'AUTH_FAILED',
    message: 'We could not complete that. Try again in a moment.',
  };
}

/**
 * The message for a non-active account (docs/10 §3.5).
 *
 * Each status gets its OWN sentence, because "your account is not available" is
 * not actionable and this is a screen a person is looking at when they cannot
 * get in. A suspended person needs to know they were suspended; a
 * pending-verification responder needs to know they are waiting, not suspended.
 */
export function accountStatusMessage(status: AccountStatus): string {
  switch (status) {
    case 'suspended':
      return 'Your account has been suspended. Contact an administrator if you think this is a mistake.';
    case 'disabled':
      return 'Your account has been disabled. Contact an administrator for help.';
    case 'pending_verification':
      return 'Your account is waiting for verification. You will have full access once an administrator has reviewed it.';
    case 'active':
      return 'Your account is active.';
    default:
      return 'Your account is not available.';
  }
}

/** `true` for a role, for a route guard. */
export function isRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** The demo clock, re-exported so a Phase 1 screen can keep its mock timestamps. */
export { DEMO_NOW, getAppEnv, clearUserScopedStorage };

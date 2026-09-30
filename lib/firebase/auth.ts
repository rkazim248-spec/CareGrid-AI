/**
 * ============================================================================
 * CareGrid AI — Firebase Auth operations
 * ============================================================================
 *
 * The ONLY file in the app that imports `firebase/auth`. Components call the
 * exported functions; they never touch the SDK. That is what makes the auth
 * surface reviewable in one place and swappable (a test double, or a different
 * IdP) without touching a component.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE ENFORCES: NO RAW FIREBASE MESSAGE EVER REACHES A USER
 * ---------------------------------------------------------------------------
 * `FirebaseError.message` is written for developers. It contains internal
 * phrasing, occasionally the email address, and — for network failures — a host
 * name. The documented contract (docs/16 §1.3) is that a user sees a stable,
 * stable-code'd English sentence. So every SDK error goes through
 * `mapAuthError()`, which produces an `AuthError` carrying a catalogue `code`
 * and a message written for a person in a hurry.
 *
 * ---------------------------------------------------------------------------
 * WHY `auth/invalid-credential` GETS ONE NEUTRAL MESSAGE
 * ---------------------------------------------------------------------------
 * Firebase deliberately returns the same `auth/invalid-credential` for a wrong
 * password and for an address with no account. That is a feature: any other
 * behaviour turns the login form into an account-existence oracle, which is
 * both an enumeration vulnerability and a privacy leak in a system where the
 * reviewer may reasonably assume an incident reporter's address is private
 * (docs/10 §3.1, docs/24).
 *
 * The Phase 2 brief lists "No account was found with this email" as an example
 * message. Implemented literally it would be an enumeration oracle, so it is
 * deliberately NOT implemented; the code comment at `INVALID_CREDENTIAL` records
 * the decision. Both cases say the same thing, which is the correct answer.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO SERVER LOGIN ROUTE (docs/10 §3.2)
 * ---------------------------------------------------------------------------
 * A password never travels to a Vercel function. The browser talks to Firebase
 * Auth; the server only ever verifies a token the browser already holds. A
 * server-side login endpoint would put a password into a request log, an
 * environment variable, and a cold-start function — a strictly worse place for
 * it, with no benefit.
 */

import {
  GoogleAuthProvider,
  browserLocalPersistence,
  confirmPasswordReset as fbConfirmPasswordReset,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reload,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  updateProfile,
  validatePassword as fbValidatePassword,
} from 'firebase/auth';
import type { Auth, PasswordValidationStatus, Unsubscribe, User, UserCredential } from 'firebase/auth';

import { getFirebaseClient } from '@/lib/firebase/client';
import { getAppUrl } from '@/lib/env.client';
import { unsubscribeAll } from '@/lib/realtime/listener-registry';
import { createIdentityWatch } from '@/lib/realtime/identity';
import type { AccountStatus, UserRole } from '@/types/enums';

/* ========================================================================== */
/* Errors                                                                     */
/* ========================================================================== */

/**
 * A user-facing authentication failure.
 *
 * `code` is the stable catalogue value from docs/16 §1.7 so support can match
 * it and so the UI can branch on it without string-matching a sentence.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** Which field the error belongs to, for inline placement. */
  readonly field: 'email' | 'password' | 'confirmPassword' | 'displayName' | 'form';
  /** Seconds the user must wait, when the limit is time-based. */
  readonly retryAfterSec: number | null;

  constructor(
    code: AuthErrorCode,
    message: string,
    field: AuthError['field'] = 'form',
    retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.field = field;
    this.retryAfterSec = retryAfterSec;
  }
}

export type AuthErrorCode =
  | 'AUTH_INVALID_CREDENTIAL'
  | 'AUTH_EMAIL_ALREADY_EXISTS'
  | 'AUTH_INVALID_EMAIL'
  | 'AUTH_WEAK_PASSWORD'
  | 'AUTH_OPERATION_NOT_ALLOWED'
  | 'AUTH_TOO_MANY_REQUESTS'
  | 'AUTH_NETWORK_FAILED'
  | 'AUTH_USER_DISABLED'
  | 'AUTH_TOO_MANY_ATTEMPTS'
  | 'AUTH_RESET_FAILED'
  | 'AUTH_UNAVAILABLE'
  | 'AUTH_FAILED';

/**
 * SDK error code → the sentence a user reads.
 *
 * Ordered by what a user is most likely to hit. Every branch is exhaustive over
 * the codes `firebase/auth` actually emits for the operations in this file; the
 * `default` branch exists so a code added by a future SDK version degrades to a
 * neutral sentence rather than leaking `e.message`.
 *
 * Note what is NOT here: no branch says "no account with that email". See the
 * file header.
 */
function mapAuthError(error: unknown, context: 'sign-in' | 'sign-up' | 'reset'): AuthError {
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'auth/unknown';

  switch (rawCode) {
    /* --- credential validity ------------------------------------------------ */
    // The two-in-one case. ONE message, deliberately.
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return new AuthError(
        'AUTH_INVALID_CREDENTIAL',
        context === 'sign-in'
          ? 'Invalid credentials. Check your email and password and try again.'
          : 'Those details were not accepted. Check them and try again.',
        context === 'sign-in' ? 'form' : 'form',
      );

    case 'auth/invalid-email':
    case 'auth/missing-email':
      return new AuthError(
        'AUTH_INVALID_EMAIL',
        'That does not look like an email address. Check it for a typo.',
        'email',
      );

    case 'auth/email-already-in-use':
      return new AuthError(
        'AUTH_EMAIL_ALREADY_EXISTS',
        'An account already uses that email address. Sign in instead, or reset the password.',
        'email',
      );

    /* --- password ----------------------------------------------------------- */
    case 'auth/weak-password':
      return new AuthError(
        'AUTH_WEAK_PASSWORD',
        'Choose a stronger password: at least 8 characters, including a number.',
        'password',
      );

    case 'auth/missing-password':
      return new AuthError('AUTH_WEAK_PASSWORD', 'Enter your password.', 'password');

    case 'auth/mismatch':
      return new AuthError(
        'AUTH_INVALID_CREDENTIAL',
        'The two passwords do not match. Retype them.',
        'confirmPassword',
      );

    /* --- account state ------------------------------------------------------ */
    case 'auth/user-disabled':
      return new AuthError(
        'AUTH_USER_DISABLED',
        'This account is not available. Contact an administrator if you think this is a mistake.',
        'form',
      );

    case 'auth/operation-not-allowed':
      return new AuthError(
        'AUTH_OPERATION_NOT_ALLOWED',
        'That sign-in method is not enabled for this deployment.',
        'form',
      );

    /* --- rate limiting ------------------------------------------------------ */
    case 'auth/too-many-requests':
      return new AuthError(
        'AUTH_TOO_MANY_REQUESTS',
        'Too many attempts. Wait a minute, then try again.',
        'form',
        60,
      );

    /* --- network / service -------------------------------------------------- */
    case 'auth/network-request-failed':
    case 'auth/internal-error':
    case 'auth/unauthorized-domain':
      return new AuthError(
        'AUTH_NETWORK_FAILED',
        'We could not reach the sign-in service. Check your connection and try again.',
        'form',
      );

    default:
      return new AuthError(
        'AUTH_FAILED',
        context === 'reset'
          ? 'We could not send the reset email. Try again in a moment.'
          : 'Something went wrong. Try again.',
        'form',
      );
  }
}

/** Re-throw anything that is already one of ours unchanged. */
function rethrowIfAuthError(error: unknown, context: 'sign-in' | 'sign-up' | 'reset'): never {
  if (error instanceof AuthError) throw error;
  throw mapAuthError(error, context);
}

/**
 * Narrow an `unknown` throwable to a specific Firebase `code`.
 *
 * `FirebaseError.code` is `string`, not a literal union, so a `switch` on it
 * cannot be exhaustively typed — which is exactly why a raw `switch` is how a
 * new SDK code silently falls into a wrong branch. This helper makes the
 * comparison explicit at every call site instead.
 */
function isAuthErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code) === code
  );
}

/* ========================================================================== */
/* Operations                                                                 */
/* ========================================================================== */

function auth(): Auth {
  return getFirebaseClient().auth;
}

/**
 * How the user arrived. Derived from the TOKEN, never from a request body
 * (docs/10 §3.3): `google.com` → `google`, everything else → `password`.
 */
export async function getProviderOf(user: User): Promise<'password' | 'google'> {
  return user.providerData[0]?.providerId === 'google.com' ? 'google' : 'password';
}

/**
 * Create an account and sign in.
 *
 * The `role` is NOT a parameter and that is the point. `POST /api/me/bootstrap`
 * derives the role on the server as `citizen`; a role in this call would be a
 * role from the client, which docs/22 §2 forbids as an authority. Privileged
 * roles are provisioned by an admin (docs/22 §8.2) or, for the very first
 * admin, out of band by `scripts/create-admin.ts` (docs/22 §8.1).
 */
export async function signUp(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{ user: User; provider: 'password' | 'google' }> {
  try {
    const credential = await createUserWithEmailAndPassword(
      auth(),
      input.email.trim().toLowerCase(),
      input.password,
    );

    // The Auth display name is cosmetic; `users/{uid}.displayName` is the one
    // the product reads. Set both so the two never disagree.
    await updateProfile(credential.user, { displayName: input.displayName.trim() });

    return { user: credential.user, provider: 'password' };
  } catch (error) {
    rethrowIfAuthError(error, 'sign-up');
  }
}

/** Sign in with email and password. */
export async function signIn(input: {
  email: string;
  password: string;
}): Promise<{ user: User; provider: 'password' | 'google' }> {
  try {
    const credential: UserCredential = await signInWithEmailAndPassword(
      auth(),
      input.email.trim().toLowerCase(),
      input.password,
    );
    return { user: credential.user, provider: 'password' };
  } catch (error) {
    rethrowIfAuthError(error, 'sign-in');
  }
}

/**
 * Google sign-in (docs/10 §3.3).
 *
 * Requires `Cross-Origin-Opener-Policy: same-origin-allow-popups`, which
 * `middleware.ts`/headers set. Firebase links a Google identity to an existing
 * password account automatically when the addresses match — intended, and a
 * documented residual risk (docs/24 RR-09), not something to work around here.
 */
export async function signInWithGoogle(): Promise<{ user: User; provider: 'google' } | null> {
  try {
    const provider = new GoogleAuthProvider();
    // Force the chooser rather than silent re-use, so a person switching
    // accounts on a shared device (US-042) is not handed the previous one.
    provider.setCustomParameters({ prompt: 'select_account' });
    const credential = await signInWithPopup(auth(), provider);
    return { user: credential.user, provider: 'google' };
  } catch (error) {
    // A user closing the popup is a normal outcome, not a failure. Returning
    // `null` (rather than throwing) keeps the form untouched — no red banner,
    // no error toast, no announced error for something the user chose.
    if (isAuthErrorCode(error, 'auth/popup-closed-by-user')) {
      return null;
    }
    rethrowIfAuthError(error, 'sign-in');
  }
}

/**
 * Send a reset email.
 *
 * The return value is the SAME for a registered and an unregistered address.
 * The caller must show one neutral sentence either way (docs/10 §3.4) — this
 * function therefore returns nothing and its caller must not branch on success
 * to infer existence.
 */
export async function resetPassword(email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(auth(), email.trim().toLowerCase(), {
      url: `${getAppUrl()}/login?mode=reset`,
      handleCodeInApp: true,
    });
  } catch (error) {
    // `auth/user-not-found` is STILL swallowed: reporting it would be the
    // enumeration oracle. The user gets "if that address has an account…".
    if (isAuthErrorCode(error, 'auth/user-not-found')) {
      return;
    }
    rethrowIfAuthError(error, 'reset');
  }
}

/** Complete a reset from `/login?mode=reset&oobCode=…`. */
export async function confirmNewPassword(oobCode: string, newPassword: string): Promise<void> {
  try {
    await fbConfirmPasswordReset(auth(), oobCode, newPassword);
  } catch (error) {
    rethrowIfAuthError(error, 'reset');
  }
}

/**
 * Sign out and clear every piece of user-scoped local state.
 *
 * Three steps, in this order, and the order matters:
 *   1. `fbSignOut()` — stops the Auth listener and drops the persisted token.
 *   2. Clear `cg.*` EXCEPT `cg.ui` — a theme is a device preference, not user
 *      data, and wiping it on sign-out is a small hostility (docs/05 §8.4).
 *   3. Return; the caller navigates.
 *
 * Deliberately NOT cleared: `cg.ui`. Deliberately cleared: everything else,
 * because a shared device must not show the previous person's draft.
 *
 * ---------------------------------------------------------------------------
 * STEP 0, ADDED IN PHASE 10: CLOSE THE REALTIME LISTENERS FIRST
 * ---------------------------------------------------------------------------
 * `clearUserScopedStorage()` reaches `localStorage` and `sessionStorage`. It does
 * NOT reach a Firestore listener, which is not storage — it is a live subscription
 * holding the previous user's data in memory, and `state.items` in every consumer
 * still points at it. So until Phase 10, signing out on a shared device left the
 * previous person's live incident queue, dispatch board and **private notification
 * list** in the app's memory, and a second person signing in could read them.
 *
 * The teardown runs BEFORE `fbSignOut`, not after, and the order is the point:
 * `fbSignOut` resolves only once the token is gone, and anything that reads
 * listener state in that window would find the old account's channels still
 * attached. Closing first makes the window empty rather than merely short.
 *
 * `decideListenerTeardown` decides; this function acts.
 */
export async function signOut(): Promise<void> {
  closeRealtimeListenersFor('signed_out');
  await fbSignOut(auth());
  clearUserScopedStorage();
  // The identity the app is ABOUT to be, not the one it was. `fbSignOut` fires
  // `onAuthStateChanged(null)` and the watch advances itself, but if the auth
  // listener is torn down first (a sign-out during a page teardown) that event
  // never arrives, and the watch would still believe someone is signed in — so
  // the next person to sign in would be treated as `same_identity` and keep the
  // previous account's listeners.
  identityWatch.reset();
}

/**
 * Close every open realtime listener, and say why.
 *
 * Exported for the Phase 10 test suite and for a sign-out that happens outside
 * this module (an admin revoking an account, a token-invalidated event). Returns
 * the number of channels closed so the caller can log it.
 */
export function closeRealtimeListenersFor(reason: string): number {
  const closed = unsubscribeAll();
  if (closed > 0 && process.env.NODE_ENV !== 'production') {
    console.warn(`[auth] closed ${closed} realtime listener(s): ${reason}`);
  }
  return closed;
}

/**
 * Remove every `cg.*` key except `cg.ui`.
 *
 * Separate function because US-042 (sign-out clears cached user data) and
 * `test-signout` need to assert it directly.
 */
export function clearUserScopedStorage(): string[] {
  if (typeof window === 'undefined') return [];
  const removed: string[] = [];
  const retained = 'cg.ui';
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith('cg.') && key !== retained) {
        window.localStorage.removeItem(key);
        removed.push(key);
      }
    }
    window.sessionStorage.clear();
  } catch {
    // Private mode with storage disabled. The sign-out itself already succeeded,
    // and the token is gone from Firebase regardless, so this is not worth
    // turning into a failure the user sees.
  }
  return removed;
}

/* ========================================================================== */
/* Session observation                                                        */
/* ========================================================================== */

/**
 * The one and only Auth subscription in the app.
 *
 * `SessionProvider` calls this exactly once. Every other component reads the
 * resulting context. That is the mechanism behind docs/22 §2's "no role in
 * localStorage" and behind the Phase 2 requirement of a single central
 * subscription: two listeners on one `Auth` instance is not a correctness bug,
 * but two owners of "am I signed in" is a design bug that shows up as a tab
 * that will not sign out.
 *
 * Returns the unsubscribe function; the provider calls it on unmount. A missing
 * cleanup is the most common cause of a "signed out but the app still thinks
 * I am in" bug.
 */
export function subscribeToAuthState(
  handler: (user: User | null) => void,
): Unsubscribe {
  return onAuthStateChanged(auth(), handleAuthStateOrIgnoreError(handler));
}

/**
 * `onAuthStateChanged` reports a failed token restore as an error argument, not
 * a throw. Unhandled it becomes an unhandled rejection and a blank screen, so it
 * is caught and reported as "signed out" — which is the truth: no usable
 * session exists.
 */
/**
 * The app's record of who is signed in, for the listener-teardown rule.
 *
 * **One per module, not per subscriber.** `subscribeToAuthState` is called from
 * more than one place, and a watch per subscriber would give each its own "previous
 * uid" — so a second subscriber mounting after a sign-out would see
 * `initial_resolution` where the first saw `signed_out`, and the teardown would be
 * skipped by whichever subscriber happened to observe the change first.
 */
const identityWatch = createIdentityWatch();

/**
 * Wrap an auth handler so listeners are closed when — and only when — the
 * *identity* changes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE ONLY PLACE THAT TEARS DOWN ON AN AUTH EVENT
 * ---------------------------------------------------------------------------
 * `signOut()` covers the path the user takes. This covers the ones they do not: a
 * token revoked from the Firebase console, a session terminated by `disableSignIn`,
 * an account deleted elsewhere, and an account switch in a second tab. Every one
 * of those arrives as an `onAuthStateChanged` event and nowhere else, so a teardown
 * wired only into `signOut()` would miss all four.
 *
 * ---------------------------------------------------------------------------
 * WHY IT WRAPS THE *HANDLER* RATHER THAN ADDING A SUBSCRIPTION
 * ---------------------------------------------------------------------------
 * `handleAuthStateOrIgnoreError` is the single funnel every auth handler in the app
 * passes through, so wrapping it here covers every current and future subscriber.
 * A second `onAuthStateChanged` would be one more subscription Firebase has to keep
 * alive, for an event the first one already delivers.
 */
function handleAuthStateOrIgnoreError(
  handler: (user: User | null) => void,
): (user: User | null) => void {
  return (user) => {
    // BEFORE the handler, so the state the handler reads is already correct. A
    // handler that re-renders on sign-out must not see the previous account's
    // notifications for one frame.
    const decision = identityWatch.observe(user?.uid ?? null);
    if (decision.teardown) {
      closeRealtimeListenersFor(
        decision.reason + ' (uid ' + (decision.closingUidFor ?? 'unknown') + ')',
      );
    }

    try {
      handler(user);
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[auth] onAuthStateChanged handler threw; treating as signed out.', error);
      }
      handler(null);
    }
  };
}

/** The current ID token, for the `Authorization` header. Never stored by us. */
export async function getIdToken(forceRefresh = false): Promise<string | null> {
  const user = auth().currentUser;
  if (!user) return null;
  return user.getIdToken(forceRefresh);
}

/**
 * Force a token refresh and reload the Auth user.
 *
 * Called from exactly one place: the "Refresh session" action on a
 * `403 ROLE_MISMATCH` state (docs/05 §8.3). It is NEVER called on a timer and
 * NEVER in a loop — a silent refresh could change the UI under an operator who
 * is mid-decision, so the refresh is always user-triggered.
 */
export async function refreshTokenAndUser(): Promise<void> {
  const user = auth().currentUser;
  if (!user) return;
  await user.getIdToken(true);
  await reload(user);
}

/**
 * The SDK's own password strength verdict, for the strength meter.
 *
 * Firebase is the AUTHORITY on password strength — it is what will reject the
 * sign-up. This exists so the meter shows the same answer the server will give,
 * rather than a second opinion from a regex that will drift from Firebase's
 * policy.
 *
 * Takes the `Auth` instance because the SDK reads the password policy from the
 * project's auth configuration, not from a constant in the SDK.
 */
export async function checkPasswordStrength(
  password: string,
): Promise<PasswordValidationStatus> {
  return fbValidatePassword(auth(), password);
}

/* ========================================================================== */
/* Types the session layer needs                                              */
/* ========================================================================== */

/**
 * The user profile as the SERVER computed it, never as the client assembled it.
 *
 * `role` arrives in this object because `GET /api/me` computed it from
 * `users/{uid}.role` — a server read. A client that wanted a different role
 * would have to change the Firestore document, which `firestore.rules` denies.
 * `permissions` is likewise server-computed, which is what makes
 * `usePermission` a rendering convenience rather than a boundary.
 */
export type MeResponse = {
  user: {
    uid: string;
    email: string;
    emailVerified: boolean;
    displayName: string;
    photoURL: string | null;
    role: UserRole;
    status: AccountStatus;
    provider: 'password' | 'google';
    createdAt: string;
    lastLoginAt: string;
  };
  profile: {
    uid: string;
    displayName: string;
    timezone: string;
    locale: string;
    notifPrefs: {
      inApp: boolean;
      sms: boolean;
      whatsapp: boolean;
      email: boolean;
    };
  } | null;
  permissions: readonly string[];
};

/** Re-exported so `lib/auth/*` never imports `firebase/auth` directly. */
export type { User as FirebaseUser };
export { browserLocalPersistence };

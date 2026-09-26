/**
 * ============================================================================
 * CareGrid AI — Firebase client bootstrap
 * ============================================================================
 *
 * docs/05 §8.1. Initialised ONCE at module scope.
 *
 * ---------------------------------------------------------------------------
 * WHY THE `getApps().length` GUARD
 * ---------------------------------------------------------------------------
 * Next's dev server hot-reloads modules. Without the guard, every refresh would
 * call `initializeApp` again and Firebase would either throw
 * `[DEFAULT] Firebase App named '[DEFAULT]' already exists` or, worse, keep two
 * live apps and two Auth listeners — so signing out on one would leave the
 * other subscribed. A control room with three open tabs must not get three
 * independent views of "am I signed in", and this is the first half of that
 * guarantee (the second half is the single `SessionProvider`).
 *
 * ---------------------------------------------------------------------------
 * WHY `initializeFirestore` AND NOT `getFirestore`
 * ---------------------------------------------------------------------------
 * `ignoreUndefinedProperties: true`. Without it, writing a field whose value is
 * `undefined` throws `Cannot use "undefined" as a Firestore value`. The schema
 * has many genuinely-optional fields (`photoURL`, `disabledReason`,
 * `locationText`, `duplicateOfIncidentId`), and Phase 3+ will write documents
 * that omit them. Turning the throw into an omission is the documented,
 * intended behaviour. The trade-off is that a typo'd field name is silently
 * dropped rather than loudly rejected — accepted, and noted, because the
 * alternative is a class of runtime crash in a write path that must not fail.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * - No `connectAuthEmulator` call. It is wired from the env flag in
 *   `lib/firebase/index.ts` so the choice is visible rather than hidden in a
 *   bootstrap.
 * - No analytics, no performance monitoring, no remote config. Phase 1 of the
 *   roadmap has no use for them and each one is a network call.
 * - No server SDK. `lib/server/firebase-admin.ts` is separate and never mixed
 *   into this file, because mixing them in one bundle is how a service account
 *   key ends up shipped to a browser.
 */

import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { browserLocalPersistence, getAuth, setPersistence, type Auth } from 'firebase/auth';
import { getFirestore, initializeFirestore, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';

import { getPublicConfig } from '@/lib/env.client';

/** The three SDK instances the whole app shares. */
type FirebaseClient = {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
};

let client: FirebaseClient | null = null;

/**
 * Create (or reuse) the Firebase app and its three services.
 *
 * Throws `EnvError` when the public config is missing. Callers that must render
 * anyway — the landing page, the public auth pages — should check
 * `isFirebaseConfigured()` first rather than catching this.
 */
export function getFirebaseClient(): FirebaseClient {
  if (client) return client;

  const config = getPublicConfig();

  // The guard. `getApps()` is Firebase's own registry, so this also survives a
  // second copy of this module in the bundle (which dev HMR can produce).
  const app: FirebaseApp = getApps().length > 0 ? getApp() : initializeApp(config);

  // `initializeFirestore` throws if called twice on the same app, so the
  // fallback to `getFirestore` is required, not defensive noise: it is the
  // HMR path.
  let db: Firestore;
  try {
    db = initializeFirestore(app, { ignoreUndefinedProperties: true });
  } catch {
    db = getFirestore(app);
  }

  const auth = getAuth(app);

  // The persistence decision is deliberate and documented (docs/05 §8.1 step 3).
  // Firestore's DEFAULT indexedDB persistence is what we want — not a switch to
  // `inMemoryPersistence` — because a dispatcher who closes the tab mid-shift
  // and reopens it should still be signed in. The session cookie debate in
  // docs/10 §12.3 is about SERVER sessions; this is the browser's own storage
  // for the Auth token, which is origin-scoped and cleared by signOut().
  void setPersistence(auth, browserLocalPersistence).catch(() => {
    // A Safari private-mode failure to set persistence degrades to in-memory
    // persistence, which means "signed in until the tab closes". That is worth
    // surviving, not worth failing the boot over.
  });

  client = {
    app,
    auth,
    db,
    // Phase 5 owns uploads. Creating the Storage handle now costs nothing and
    // means Phase 5 does not touch app bootstrap.
    storage: getStorage(app),
  };

  return client;
}

/** `true` once `getFirebaseClient()` has succeeded. Never forces a throw. */
export function isFirebaseReady(): boolean {
  return client !== null;
}

/**
 * Test seam. Phase 10's rules/emulator tests need to start from a clean app
 * between cases; production code must never call this.
 */
export function resetFirebaseClientForTests(): void {
  client = null;
}

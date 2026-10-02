/**
 * ============================================================================
 * CareGrid AI — Firebase Admin SDK bootstrap (SERVER ONLY)
 * ============================================================================
 *
 * One Admin app per server instance, created lazily and memoised on `globalThis`.
 *
 * ---------------------------------------------------------------------------
 * WHY `globalThis` AND NOT A MODULE VARIABLE
 * ---------------------------------------------------------------------------
 * Next's dev server reloads modules on every edit. A module-scoped variable is
 * re-initialised, so a hot refresh would create a second Admin app, a second
 * Auth token cache, and a second set of Firestore gRPC channels. On a serverless
 * platform a warm instance is reused across requests, so the same thing happens
 * across invocations that a module variable cannot see. Stashing the instance on
 * `globalThis` under a versioned key is the Firebase-documented workaround and
 * also means a credentials rotation only needs a new key, not a redeploy of
 * every function.
 *
 * ---------------------------------------------------------------------------
 * WHY LAZY AND NOT TOP-LEVEL
 * ---------------------------------------------------------------------------
 * A top-level `initializeApp()` throws at import time when the credentials are
 * absent, which would break the `/` landing page — a public route that needs no
 * database — with an error about a secret. Lazy initialisation confines the
 * failure to the routes that actually need the Admin SDK, where
 * `assertAdminConfigured()` can turn it into a 503 with a clear message.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PRIVATE KEY BUYS
 * ---------------------------------------------------------------------------
 * The Admin SDK **bypasses Firestore Security Rules entirely**. That is what
 * makes the server authoritative (docs/22 §2: `users/{uid}.role` is read from
 * here, per request, never from a token) — and it is also why the key is the
 * single highest-value credential in the project. It is never behind a
 * `NEXT_PUBLIC_` prefix and never reaches a client bundle.
 */

import 'server-only';

import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
// Phase 5. Imported from the SUBCPATH rather than from the `firebase-admin` root:
// `admin.getStorage` does not exist on the default export in v13 (verified by
// probe), and the subpath does export it. A root import would have looked correct
// and failed at runtime.
import { getStorage, type Storage } from 'firebase-admin/storage';

import { adminConfigurationProblem, getServerEnv, isAdminConfigured } from '@/lib/env.server';
import { AppError } from '@/lib/server/errors';

type AdminServices = {
  app: App;
  auth: Auth;
  db: Firestore;
  /** Phase 5. Only ever used server-side; see `getAdminStorage()`. */
  storage: Storage;
};

/**
 * Bump when the shape changes, so a stale instance from a previous shape is
 * discarded instead of being reused with missing fields.
 */
const CACHE_KEY = '__caregrid_admin_v1__';

type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: AdminServices };

function getAdminServices(): AdminServices {
  if (!isAdminConfigured()) {
    // A TYPED error, not a bare `Error`.
    //
    // This matters: the failure mode being defended against is an unconfigured
    // deployment reaching the SDK and getting an opaque SDK error, which
    // `toAppError()` maps to `500 INTERNAL` and a caller reads as "the server is
    // broken". `SERVICE_UNAVAILABLE` is the honest status — the service exists
    // and is not configured — and it carries the reason and the three variable
    // names, so a reader can fix it without opening the documentation.
    throw new AppError({
      code: 'SERVICE_UNAVAILABLE',
      message:
        adminConfigurationProblem() ??
        'The Firebase Admin SDK is not configured, so no server route can verify an ID token or read Firestore.',
    });
  }

  const cache = globalThis as GlobalWithCache;
  const existing = cache[CACHE_KEY];
  if (existing) return existing;

const env = getServerEnv();

const app: App =
  getApps().length > 0 ? getApp() : initializeApp({
    credential: cert({
      projectId: env.projectId,
      clientEmail: env.clientEmail,
      privateKey: env.privateKey,
    }),
    // Without this the App carries no bucket, and `getStorage(app).bucket()`
    // throws `storage/invalid-argument` at the first real call. Pass it only
    // when we actually have one: an empty string is worse than no key at all.
    ...(env.storageBucket ? { storageBucket: env.storageBucket } : {}),
  });

  const services: AdminServices = {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
    storage: getStorage(app),
  };

  cache[CACHE_KEY] = services;
  return services;
}

/** Verifies ID tokens and mints nothing. */
export function getAdminAuth(): Auth {
  return getAdminServices().auth;
}

/** The trusted server-side Firestore handle. Bypasses Security Rules. */
export function getAdminDb(): Firestore {
  return getAdminServices().db;
}

/**
 * The trusted server-side Storage handle. Phase 5.
 *
 * Bypasses Storage Security Rules, which is exactly why it is server-only and why
 * every path it touches is one the CLIENT has no permission on. `storage.rules`
 * makes `incidents/**` and `quarantine/**` `if false` for everyone, so the only way
 * to read or move an object there is through this handle — after the API has made
 * an authorization decision.
 */
export function getAdminStorage(): Storage {
  return getAdminServices().storage;
}

/**
 * The explicit configuration check, for route handlers that want to answer 503
 * with a named reason rather than letting the SDK throw something opaque.
 *
 * Returns the reason rather than throwing, because the two callers want
 * different things: `withRequest` wants a boolean to branch on, and a
 * script wants a sentence to print.
 */
export function adminConfigurationReason(): string | null {
  return adminConfigurationProblem();
}

/**
 * Test seam for the emulator suite (docs/05 §8.1). Production code must never
 * call this.
 */
export function resetAdminForTests(): void {
  delete (globalThis as GlobalWithCache)[CACHE_KEY];
}

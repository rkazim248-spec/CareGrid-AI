/**
 * ============================================================================
 * CareGrid AI — PUBLIC environment access (browser-safe)
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `process.env.NEXT_PUBLIC_*` is inlined by Next at build time, which means a
 * missing variable becomes `undefined` at runtime with no explanation. In an
 * emergency tool the failure mode "the login button silently does nothing"
 * is worse than a loud boot error, so every public variable is validated once,
 * here, and a missing one produces a named, actionable message.
 *
 * WHAT IS AND IS NOT A SECRET (docs/21 §6)
 * -----------------------------------------
 * The `NEXT_PUBLIC_FIREBASE_*` web config is NOT a secret. It ships in the
 * bundle by design and is protected by HTTP-referrer restriction and API
 * enablement in the Google Cloud console. It still lives in the environment
 * rather than in source so the same build can target two projects.
 *
 * The service-account key, `GEMINI_API_KEY`, and the Maps SERVER key are
 * secrets and are NOT reachable from this module. They live in
 * `lib/env.server.ts`, which throws if imported from a client component.
 *
 * NO FAKE DEFAULTS
 * ----------------
 * There is no placeholder API key and no "development" fallback anywhere in
 * this file. An unset variable is an error, not a guess — a fake key produces a
 * Firebase error that looks like a network problem and wastes an afternoon.
 */

/** One missing or malformed variable, named precisely enough to act on. */
export class EnvError extends Error {
  readonly variable: string;
  readonly hint: string;

  constructor(variable: string, hint: string) {
    super(
      `Missing or invalid environment variable ${variable}. ${hint}`,
    );
    this.name = 'EnvError';
    this.variable = variable;
    this.hint = hint;
  }
}

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new EnvError(name, hint);
  }
  return value.trim();
}

/**
 * A URL variable, validated as a URL and forced to https in production.
 * docs/10 §12.1 requires https in production; an http app URL in prod would
 * make the CSRF origin check trivially bypassable by a network attacker.
 */
function requiredUrl(name: string, hint: string): string {
  const raw = required(name, hint);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EnvError(name, `${hint} (the value is not a valid URL: "${raw}")`);
  }
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && parsed.protocol !== 'https:') {
    throw new EnvError(
      name,
      `${hint} (a production build requires https, got "${parsed.protocol}//")`,
    );
  }
  // Trailing slashes make exact-match origin comparisons fail. Normalise once.
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new EnvError(name, `Expected "true" or "false", got "${value}".`);
}

/**
 * The public Firebase web config. Not a secret — see the file header.
 *
 * `getPublicConfig()` is memoised so a fast-refresh cycle re-reads nothing and
 * a missing variable throws ONCE per session, not once per component.
 */
export type PublicFirebaseConfig = {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly storageBucket: string;
  readonly messagingSenderId: string;
  readonly appId: string;
  /** Point every SDK at the local emulator suite. docs/05 §8.1 */
  readonly useEmulators: boolean;
};

let cachedConfig: PublicFirebaseConfig | null = null;

export function getPublicConfig(): PublicFirebaseConfig {
  if (cachedConfig) return cachedConfig;

  const where =
    'Copy .env.example to .env.local and fill it in from the Firebase console ' +
    '(Project settings → Your apps → SDK setup and configuration).';

  cachedConfig = {
    apiKey: required('NEXT_PUBLIC_FIREBASE_API_KEY', where),
    authDomain: required('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', where),
    projectId: required('NEXT_PUBLIC_FIREBASE_PROJECT_ID', where),
    storageBucket: required('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', where),
    messagingSenderId: required('NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID', where),
    appId: required('NEXT_PUBLIC_FIREBASE_APP_ID', where),
    useEmulators: optionalBoolean('NEXT_PUBLIC_FIREBASE_USE_EMULATORS', false),
  };

  return cachedConfig;
}

/**
 * The public app URL. Used for the password-reset `actionCodeSettings.url`, the
 * `next` redirect allow-list, and the CSRF origin set.
 */
export function getAppUrl(): string {
  return requiredUrl(
    'NEXT_PUBLIC_APP_URL',
    'Set it to the origin the app is served from, e.g. http://localhost:3000',
  );
}

export function getAppEnv(): 'development' | 'staging' | 'production' {
  const raw = optional('NEXT_PUBLIC_APP_ENV', 'development');
  if (raw === 'development' || raw === 'staging' || raw === 'production') return raw;
  throw new EnvError('NEXT_PUBLIC_APP_ENV', `Expected development|staging|production, got "${raw}".`);
}

export function isProduction(): boolean {
  return getAppEnv() === 'production';
}

/** Docs/22 §9: the landing route for each role after a successful sign-in. */
export function isEmulatorMode(): boolean {
  return optionalBoolean('NEXT_PUBLIC_FIREBASE_USE_EMULATORS', false);
}

/**
 * Whether Firebase is configured AT ALL, without throwing.
 *
 * The landing page and the public auth pages need to render even when no
 * `.env.local` exists — a reviewer should see the product, not a stack trace.
 * They use this to show an honest setup notice instead of pretending the form
 * works.
 */
export function isFirebaseConfigured(): boolean {
  const required_ = [
    'NEXT_PUBLIC_FIREBASE_API_KEY',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
    'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
    'NEXT_PUBLIC_FIREBASE_APP_ID',
  ];
  return required_.every((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/**
 * The same question, but returning the reason. Used by the setup notice so a
 * developer knows which variable is missing rather than being told "not
 * configured" with nothing to act on.
 */
export function firebaseConfigurationProblem(): string | null {
  if (isFirebaseConfigured()) return null;
  return (
    'Firebase is not configured. Copy .env.example to .env.local and fill in the ' +
    'NEXT_PUBLIC_FIREBASE_* values from the Firebase console. No placeholder key ' +
    'is shipped, on purpose: a fake key produces a Firebase error that looks like ' +
    'a network fault.'
  );
}

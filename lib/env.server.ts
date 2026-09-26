/**
 * ============================================================================
 * CareGrid AI — SERVER environment access
 * ============================================================================
 *
 * This module reads secrets. Importing it from a Client Component would either
 * leak them into the bundle or fail the build. The `import 'server-only'`
 * guard below is what makes the second outcome certain: Next replaces
 * `server-only` with a module that throws the moment a client bundle tries to
 * include it, so a mistake is a build error rather than a leaked service
 * account key.
 *
 * The eslint `no-restricted-imports` rule (docs/32) bans `@/lib/server/**` and
 * `@/lib/firebase/**` from client-reachable files as a second, independent
 * check. Two mechanisms, one invariant: secrets never reach the browser.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR SECRETS, AND WHAT EACH ONE UNLOCKS
 * ---------------------------------------------------------------------------
 * | Variable                | Unlocks                                     | Blast radius if leaked |
 * |-------------------------|---------------------------------------------|-----------------------|
 * | `FIREBASE_PRIVATE_KEY`  | Bypasses Firestore Security Rules entirely  | Total: every document  |
 * | `GEMINI_API_KEY`        | Spends the project's Gemini quota          | Bounded, rate-limited |
 * | `GOOGLE_MAPS_SERVER_KEY`| Billed geocoding and distance-matrix calls  | Bounded               |
 * | `CRON_SECRET`           | Lets a caller run maintenance jobs         | Job execution         |
 *
 * There is NO login route and NO custom-token minting (docs/10 §3.2, §12.3), so
 * the private key is used for exactly one thing: verifying an ID token the
 * browser already holds, and reading/writing Firestore from a trusted server.
 */

/** Build-time poison pill. Throws if a client bundle reaches this module. */
import 'server-only';

class ServerEnvError extends Error {
  readonly variable: string;

  constructor(variable: string, hint: string) {
    super(`Missing or invalid server environment variable ${variable}. ${hint}`);
    this.name = 'ServerEnvError';
    this.variable = variable;
  }
}

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ServerEnvError(name, hint);
  }
  return value.trim();
}

function requiredBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ServerEnvError(name, `Expected "true" or "false", got "${raw}".`);
}

function requiredNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ServerEnvError(name, `Expected a number, got "${raw}".`);
  }
  return parsed;
}

const where = 'See docs/21_ENVIRONMENT_VARIABLES.md and .env.example.';

/**
 * Whether the Admin SDK credentials are present.
 *
 * Unlike the public config there is no "half configured" state worth running
 * with: the Admin SDK is all-or-nothing, and a missing private key produces an
 * obscure `invalid_grant` rather than a named error. Checking up front turns
 * that into one clear sentence.
 */
export function isAdminConfigured(): boolean {
  return ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].every(
    (name) => {
      const value = process.env[name];
      return typeof value === 'string' && value.trim() !== '';
    },
  );
}

export function adminConfigurationProblem(): string | null {
  if (isAdminConfigured()) return null;
  return (
    'The Firebase Admin SDK is not configured, so no server route can verify an ID token ' +
    'or read Firestore. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and ' +
    'FIREBASE_PRIVATE_KEY in .env.local. Until then the API returns 503 and the ' +
    'client shows a configuration error — it does not pretend to be signed in.'
  );
}

export function getServerEnv() {
  return {
    projectId: required('FIREBASE_PROJECT_ID', where),
    clientEmail: required('FIREBASE_CLIENT_EMAIL', where),
    /**
     * `process.env` collapses `\n` in a PEM when the key travels through some
     * CI secret stores, which produces a signature error that looks like a
     * clock-skew problem. Restoring the newlines is the documented fix
     * (Firebase's own admin SDK init docs).
     */
    privateKey: required('FIREBASE_PRIVATE_KEY', where).replace(/\\n/g, '\n'),
    isProduction: process.env.NODE_ENV === 'production',
    appUrl: required('NEXT_PUBLIC_APP_URL', 'Used for the CSRF origin set.'),
    /** docs/10 §3.6. A privileged action needs a token issued within this window. */
    reauthWindowSec: requiredNumber('REAUTH_WINDOW_SEC', 300),
    /** docs/16 §1.9. Null means "unlimited" for endpoints that do not set one. */
    logLevel: process.env.LOG_LEVEL?.trim() ?? 'info',
    maintenanceEnabled: requiredBoolean('ENABLE_MAINTENANCE_JOBS', false),
    seedEnabled: requiredBoolean('ALLOW_SEED', false),
  } as const;
}

/**
 * The allowed browser origins for a state-changing request.
 *
 * Compared with `Set.has` against the WHOLE origin string, never a prefix
 * match: `'https://caregrid.example.evil.com'.startsWith('https://caregrid.example')`
 * is true, and that is the entire bug class docs/10 §12.1 warns about.
 */
export function allowedOrigins(): Set<string> {
  const appUrl = getServerEnv().appUrl;
  const list = new Set<string>([appUrl, new URL(appUrl).origin]);
  return list;
}

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

import {
  ACCEPTED_AUDIO_TYPES,
  ACCEPTED_IMAGE_TYPES,
  REPORT_LIMITS,
} from '@/config/limits';

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

/**
 * A STATIC snapshot of every public variable this module can read.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: the build-time inlining trap
 * ---------------------------------------------------------------------------
 * Next.js replaces `process.env.NEXT_PUBLIC_FOO` with the literal string value
 * at build time, but ONLY when it sees a literal member expression. A COMPUTED
 * access — `process.env[name]`, where `name` is a variable — is never rewritten.
 *
 * On the server that mistake is invisible: Node has a real `process.env`, so
 * the lookup succeeds and every test passes. In the client bundle the lookup
 * hits an empty object and EVERY variable reads `undefined`.
 *
 * The reason this survived review is that it contradicted all the available
 * evidence. `.env.local` held every key, the server-side REST probe
 * authenticated successfully, and the Firebase project was genuinely healthy —
 * only the browser disagreed. The symptom that reached the user was
 * "Something went wrong. Try again.", because a missing config throws an
 * `EnvError` from deep inside the auth layer, where it is indistinguishable
 * from a real Firebase failure.
 *
 * So: one literal per variable, written out explicitly, is the only form the
 * bundler can see. Adding a variable means adding a line here, and the
 * `PublicEnvName` type then rejects any caller that tries to read a name that
 * is not in this list. That friction is deliberate.
 *
 * WHY A FUNCTION AND NOT A MODULE-LEVEL CONSTANT
 * The literals must stay literal for the bundler, but the read must happen at
 * CALL time rather than import time. A `const PUBLIC_ENV = {...}` snapshot is
 * frozen the moment the module loads, which silently breaks anything that
 * changes the environment afterwards — notably `tests/unit/app-providers-boot`,
 * which swaps variables to exercise the "not configured" path. Next.js
 * substitutes these literals at build time regardless of the surrounding
 * function, so laziness costs nothing in the browser and preserves the ability
 * to test the unconfigured path honestly.
 *
 * `undefined` is a legitimate value: it is how a genuinely unset variable is
 * represented, and every accessor below decides what that means.
 */
type PublicEnvName =
  | 'NEXT_PUBLIC_APP_ENV'
  | 'NEXT_PUBLIC_APP_URL'
  | 'NEXT_PUBLIC_FIREBASE_API_KEY'
  | 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'
  | 'NEXT_PUBLIC_FIREBASE_PROJECT_ID'
  | 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'
  | 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'
  | 'NEXT_PUBLIC_FIREBASE_APP_ID'
  | 'NEXT_PUBLIC_FIREBASE_USE_EMULATORS'
  | 'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'
  | 'NEXT_PUBLIC_MAP_STYLE'
  | 'NEXT_PUBLIC_MAP_STYLE_ID'
  | 'NEXT_PUBLIC_MAP_ZOOM_DEFAULT'
  | 'NEXT_PUBLIC_MAP_ZOOM_MAX'
  | 'NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN';

function publicEnv(): Readonly<Record<PublicEnvName, string | undefined>> {
  return {
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_FIREBASE_USE_EMULATORS: process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS,
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
    NEXT_PUBLIC_MAP_STYLE: process.env.NEXT_PUBLIC_MAP_STYLE,
    NEXT_PUBLIC_MAP_STYLE_ID: process.env.NEXT_PUBLIC_MAP_STYLE_ID,
    NEXT_PUBLIC_MAP_ZOOM_DEFAULT: process.env.NEXT_PUBLIC_MAP_ZOOM_DEFAULT,
    NEXT_PUBLIC_MAP_ZOOM_MAX: process.env.NEXT_PUBLIC_MAP_ZOOM_MAX,
    NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN,
  };
}

function required(name: PublicEnvName, hint: string): string {
  const value = publicEnv()[name];
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
function requiredUrl(name: PublicEnvName, hint: string): string {
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

function optional(name: PublicEnvName, fallback: string): string {
  const value = publicEnv()[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function optionalBoolean(name: PublicEnvName, fallback: boolean): boolean {
  const value = publicEnv()[name]?.trim().toLowerCase();
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
  // Reads `PUBLIC_ENV`, never `process.env[name]` — see the note on
  // `PUBLIC_ENV` above. This function is the one that decides whether the app
  // shows the "Firebase is not configured" panel, so a false `false` here tells
  // the user their `.env.local` is broken when it is perfectly correct.
  const required_: readonly PublicEnvName[] = [
    'NEXT_PUBLIC_FIREBASE_API_KEY',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
    'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
    'NEXT_PUBLIC_FIREBASE_APP_ID',
  ];
  return required_.every((name) => {
    const value = publicEnv()[name];
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

/* ========================================================================== */
/* Uploads — the PUBLIC subset (docs/15 §7.1)                                  */
/* ========================================================================== */

/**
 * The client-visible upload limits.
 *
 * A client pre-check is **UX, not a control** (docs/15 §8.1, step 1). It exists
 * so a person learns their photo is too large immediately, instead of after
 * selecting it, reading it, base64-ing it, and sending it to a server that then
 * refuses it. The server is authoritative for every number here; nothing in this
 * object decides anything.
 *
 * The numbers are read from `REPORT_LIMITS` rather than typed again, because a
 * pre-check that disagrees with the server is a pre-check that lies to a person
 * during an emergency. That is the whole reason this function exists instead of
 * the component importing `REPORT_LIMITS` directly: the shape is the seam that
 * lets Phase 6 replace these with server-supplied values.
 */
export function getUploadLimits() {
  return {
    maxImageBytes: REPORT_LIMITS.maxImageBytes,
    maxAudioBytes: REPORT_LIMITS.maxAudioBytes,
    maxAudioDurationSec: REPORT_LIMITS.maxAudioDurationSec,
    maxImages: REPORT_LIMITS.maxImages,
    maxAudioClips: REPORT_LIMITS.maxAudioClips,
    acceptedImageTypes: [...ACCEPTED_IMAGE_TYPES],
    acceptedAudioTypes: [...ACCEPTED_AUDIO_TYPES],
  } as const;
}

/* ========================================================================== */
/* Google Maps — the CLIENT half (docs/12 §7, docs/21 §5)                      */
/* ========================================================================== */

/**
 * The browser-visible Google Maps configuration.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS `NEXT_PUBLIC_` AND `GOOGLE_MAPS_SERVER_KEY` IS NOT
 * ---------------------------------------------------------------------------
 * The Maps JavaScript API is loaded by a `<script>` tag in the page. A browser
 * cannot hold a secret, so the key that loads it is public by construction and
 * is protected by TWO Google Cloud restrictions instead:
 *
 *   1. **Application → HTTP referrers**: `localhost:3000/*`,
 *      `https://<staging-domain>/*`, `https://<prod-domain>/*` (docs/21 §5).
 *   2. **API restriction**: Maps JavaScript API and Places API only.
 *
 * Anything that runs on OUR server — geocoding, the distance matrix, the risk
 * analytics pass — uses `GOOGLE_MAPS_SERVER_KEY` from `lib/env.server.ts`,
 * restricted by IP to the Vercel egress ranges. The two keys are different
 * values with different restrictions, and neither is ever sent to the other side.
 *
 * `undefined` here is a NORMAL state in Phase 3: the map ships in Phase 6, and
 * a missing browser key must not break sign-in or the report form.
 */
export type PublicMapsConfig = {
  readonly browserKey: string | null;
  readonly style: 'roadmap' | 'satellite' | 'hybrid' | 'dark';
  readonly zoomDefault: number;
  readonly zoomMax: number;
  readonly mapsProblem: string | null;
};

let cachedMaps: PublicMapsConfig | null = null;

export function getPublicMapsConfig(): PublicMapsConfig {
  if (cachedMaps) return cachedMaps;

  const key = optional('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', '');
  const rawStyle = optional('NEXT_PUBLIC_MAP_STYLE', 'dark');
  const style =
    rawStyle === 'roadmap' || rawStyle === 'satellite' || rawStyle === 'hybrid' || rawStyle === 'dark'
      ? rawStyle
      : 'dark';

  const zoomDefault = clampNumber('NEXT_PUBLIC_MAP_ZOOM_DEFAULT', 13, 1, 21);
  const zoomMax = clampNumber('NEXT_PUBLIC_MAP_ZOOM_MAX', 18, zoomDefault, 21);

  cachedMaps = {
    browserKey: key === '' ? null : key,
    style,
    zoomDefault,
    zoomMax,
    mapsProblem:
      key === ''
        ? 'The map is not configured: NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set. Incident locations ' +
          'are still shown in the list, which is the documented fallback (docs/12 §9).'
        : null,
  };

  return cachedMaps;
}

/** `true` when the browser map may load. The LIST fallback renders when false. */
export function isMapsConfigured(): boolean {
  return getPublicMapsConfig().browserKey !== null;
}

function clampNumber(name: PublicEnvName, fallback: number, min: number, max: number): number {
  const raw = optional(name, '');
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * The Mapbox browser token, for `features/analytics/risk-map.tsx`.
 *
 * A Mapbox PUBLIC token is designed for the browser — it is restricted by HTTP
 * referrer and by the specific APIs enabled on it, and it grants no write access.
 * It is NOT a secret and deliberately carries the `NEXT_PUBLIC_` prefix, which is
 * exactly what makes it publishable. The contrast with `IMAGEKIT_PRIVATE_KEY` and
 * `GEMINI_API_KEY` is the whole point: those carry no prefix because they are
 * server-only.
 *
 * Distinct from `getPublicMapsConfig()`, which describes the Google Maps key that
 * nothing currently loads.
 */
export type PublicMapboxConfig = {
  /** `null` when unset, so the caller can render a missing-token state. */
  readonly accessToken: string | null;
  /** `docs/25`: the style id, not a URL. `dark-v11` matches the operations theme. */
  readonly style: string;
  readonly problem: string | null;
};

let cachedMapbox: PublicMapboxConfig | null = null;

export function getPublicMapboxConfig(): PublicMapboxConfig {
  if (cachedMapbox) return cachedMapbox;
  const token = optional('NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN', '');
  cachedMapbox = {
    accessToken: token === '' ? null : token,
    style: optional('NEXT_PUBLIC_MAP_STYLE_ID', 'mapbox://styles/mapbox/dark-v11'),
    problem:
      token === ''
        ? 'The map is not configured: NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN is not set. Risk ' +
          'zones are still listed below, which is the documented fallback.'
        : null,
  };
  return cachedMapbox;
}

/** `true` when the Mapbox layer may load. The risk TABLE renders either way. */
export function isMapboxConfigured(): boolean {
  return getPublicMapboxConfig().accessToken !== null;
}

/** Whether development-only client diagnostics should be written to the console. */
export function isDevelopmentBuild(): boolean {
  return process.env.NODE_ENV === 'development';
}

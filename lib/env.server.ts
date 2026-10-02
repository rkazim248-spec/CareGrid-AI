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
 * `@/lib/env.server` from client-reachable files as a second, independent
 * check. Two mechanisms, one invariant: secrets never reach the browser.
 *
 * ---------------------------------------------------------------------------
 * THREE TIERS, AND THE DIFFERENCE MATTERS
 * ---------------------------------------------------------------------------
 * `getServerEnv()` is the **required** tier. It throws when a variable the
 * server cannot work without is missing, and it is called on the CSRF path of
 * every state-changing request.
 *
 * The **optional** tier is everything a future integration needs and this
 * phase does not: `GEMINI_API_KEY`, `GOOGLE_MAPS_SERVER_KEY`, the Twilio
 * triple, `CRON_SECRET`, `IP_HASH_SALT`. These are read through
 * `serverIntegrationConfig()`, which NEVER throws, because a missing Gemini
 * key must not stop a citizen from signing in or reading their own reports.
 * The integration that needs a key asks `isGeminiConfigured()` first and
 * answers `503 AI_UNAVAILABLE` when it is not there.
 *
 * `NEXT_PUBLIC_FIREBASE_USE_EMULATORS === 'true'` in a **production** build is
 * the third tier: not a missing value but a dangerous one, so
 * `assertServerInvariants()` refuses to let it stand.
 *
 * ---------------------------------------------------------------------------
 * THE SECRETS, AND WHAT EACH ONE UNLOCKS (docs/21 §6)
 * ---------------------------------------------------------------------------
 * | Variable                  | Unlocks                                       | Blast radius if leaked |
 * |---------------------------|-----------------------------------------------|-----------------------|
 * | `FIREBASE_PRIVATE_KEY`    | Bypasses Firestore Security Rules entirely    | Total: every document  |
 * | `FIREBASE_CLIENT_EMAIL`    | Half of the Admin SDK credential pair          | Total, with the key    |
 * | `GEMINI_API_KEY`          | Spends the project's Gemini quota             | Bounded, rate-limited |
 * | `GOOGLE_MAPS_SERVER_KEY`  | Billed geocoding and distance-matrix calls    | Bounded               |
 * | `TWILIO_AUTH_TOKEN`       | Sends SMS/WhatsApp at the project's cost       | Billed                |
 * | `CRON_SECRET`             | Lets a caller run maintenance jobs            | Job execution         |
 * | `IP_HASH_SALT`            | Makes a stored IP hash linkable                | Pseudonymity gone     |
 *
 * There is NO login route and NO custom-token minting (docs/10 §3.2, §12.3), so
 * the private key is used for exactly one thing: verifying an ID token the
 * browser already holds, and reading/writing Firestore from a trusted server.
 *
 * Nothing in this file ever prints, returns, or logs a value. A boot error
 * names the VARIABLE and never its value (docs/10 §16.3, control 8).
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

function optionalString(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ServerEnvError(name, `Expected "true" or "false", got "${raw}".`);
}

const where = 'See docs/21_ENVIRONMENT_VARIABLES.md and .env.example.';

/* ========================================================================== */
/* Tier 1 — required                                                          */
/* ========================================================================== */

/**
 * Whether the Admin SDK credentials are present.
 *
 * Unlike the public config there is no "half configured" state worth running
 * with: the Admin SDK is all-or-nothing, and a missing private key produces an
 * obscure `invalid_grant` rather than a named error. Checking up front turns
 * that into one clear sentence.
 */
export function isAdminConfigured(): boolean {
  return FIREBASE_ADMIN_VARS.every(
    (name) => {
      const value = process.env[name];
      return typeof value === 'string' && value.trim() !== '';
    },
  );
}

/**
 * The Admin SDK variables, as a list. Phase 14.
 *
 * Existed as an inline array literal inside `isAdminConfigured()` until the admin
 * provider panel needed the same three names for its own status line. A second
 * hand-written copy is how a fourth credential gets added to the check but not to
 * the panel, and the panel then reports a healthy Firebase with a variable nobody
 * ever sets.
 */
export const FIREBASE_ADMIN_VARS = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
] as const;

/**
 * The Admin SDK as an `IntegrationStatus`, for the provider panel.
 *
 * Built on `statusFor` so the shape matches every other provider, and so the
 * reported `required` field is the SAME array `isAdminConfigured()` checks rather
 * than a parallel list that could disagree with it.
 *
 * Its `problem` names variables and their absence. It never names a value —
 * `FIREBASE_PRIVATE_KEY` is the one field where that distinction matters most.
 */
export function firebaseAdminStatus(): IntegrationStatus {
  return statusFor(
    FIREBASE_ADMIN_VARS,
    'Every API request is refused with 503 until this is set — nothing else can work first.',
    'This is the first thing to fix when the whole API is returning 503.',
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
    /**
     * The Cloud Storage bucket that holds evidence.
     *
     * This has to be explicit. `initializeApp({ credential: cert(...) })` sets no
     * `storageBucket`, and `getStorage(app)` then defers the failure to
     * `.bucket()`, which throws `storage/invalid-argument: Bucket name not
     * specified`. `isStorageConfigured()` caught that and reported the bucket as
     * unusable, so every signed-upload request answered 503 and the citizen saw
     * "Photos and voice notes cannot be uploaded right now" even though
     * Firestore and Auth — which use the SAME service account — were working
     * perfectly. The account was never the problem; the app simply did not know
     * which bucket to talk to.
     *
     * Read from the server-only name first, then the public one. The public
     * value is safe to expose (it is a bucket NAME, not a credential) and it is
     * what the client already reads, so a deployment that only has that one
     * still works.
     */
    storageBucket:
      optionalString('FIREBASE_STORAGE_BUCKET') ||
      optionalString('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'),
    isProduction: process.env.NODE_ENV === 'production',
    appUrl: required('NEXT_PUBLIC_APP_URL', 'Used for the CSRF origin set.'),
    /** docs/10 §3.6. A privileged action needs a token issued within this window. */
    reauthWindowSec: boundedNumber('REAUTH_WINDOW_SEC', 300, 30, 3600),
    /** docs/16 §1.9. Null means "unlimited" for endpoints that do not set one. */
    logLevel: optionalString('LOG_LEVEL', 'info'),
    maintenanceEnabled: optionalBoolean('ENABLE_MAINTENANCE_JOBS', false),
    seedEnabled: optionalBoolean('ALLOW_SEED', false),
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
  for (const origin of vercelDeploymentOrigins()) list.add(origin);
  return list;
}

/**
 * The origins Vercel serves THIS build from, read from the platform's own
 * variables.
 *
 * `NEXT_PUBLIC_APP_URL` is one static string, but a Vercel project serves the
 * same build from a production hostname AND a separate hostname per preview
 * branch. A build that trusts only `NEXT_PUBLIC_APP_URL` therefore rejects every
 * state-changing request that arrives from a preview deployment, and — when
 * `NEXT_PUBLIC_APP_URL` still holds a development value such as
 * `http://localhost:3000`, because it was copied out of a local `.env.local` —
 * it rejects the PRODUCTION deployment as well. `assertSameOrigin` answers
 * `CSRF_FAILED`, so `POST /api/me/bootstrap` never creates the profile document
 * that a brand-new account needs, and the session cannot finish loading.
 *
 * These three variables are injected by the platform rather than supplied by us,
 * and each is stored as an exact origin compared with `Set.has`. There is no
 * prefix match anywhere here, so this cannot widen the check into the
 * `'https://app.example.evil.com'.startsWith('https://app.example')` bug class.
 *
 * Gated on `VERCEL === '1'` so that a self-hosted deployment never grows
 * platform-shaped entries it has no way to validate.
 */
function vercelDeploymentOrigins(): string[] {
  if (process.env.VERCEL !== '1') return [];
  const origins: string[] = [];
  for (const name of ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL', 'VERCEL_URL']) {
    const value = optionalString(name);
    if (value === '') continue;
    try {
      origins.push(new URL(value.includes('://') ? value : `https://${value}`).origin);
    } catch {
      // A malformed platform value is ignored rather than trusted.
    }
  }
  return origins;
}

/* ========================================================================== */
/* Tier 2 — optional integration configuration (NEVER throws)                  */
/* ========================================================================== */

/**
 * One integration's readiness, and the sentence that explains a refusal.
 *
 * `configured: false` is a NORMAL state in this phase, not a fault. Gemini,
 * Google Maps server key, and Twilio all ship unconfigured, and the whole point
 * of Phase 3 is that the application runs correctly that way.
 *
 * The `problem` sentence ALWAYS names the variables it is about. An admin page
 * that says "the AI provider is not configured" makes the reader open the
 * documentation; one that says "GEMINI_API_KEY is not set" does not. A variable
 * NAME is not a secret — a value would be, and a name is exactly what an
 * operator needs.
 */
export type IntegrationStatus = {
  /** The variable NAME, never its value. docs/10 §16.3, control 7. */
  readonly required: readonly string[];
  readonly configured: boolean;
  /** `null` when configured. A renderable sentence when not. */
  readonly problem: string | null;
};

const how = 'Add it to .env.local for local work, or to the Vercel project environment. ' + where;

function statusFor(names: readonly string[], lead: string, tail: string): IntegrationStatus {
  const configured = names.every((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() !== '';
  });
  if (configured) return { required: names, configured: true, problem: null };
  const verb = names.length === 1 ? 'is' : 'are';
  return {
    required: names,
    configured: false,
    problem: `${names.join(' and ')} ${verb} not set. ${lead} ${tail} ${how}`,
  };
}


/* --- Gemini — docs/21 §2, read by services/integrations/gemini ------------ */

/** The exact variable names Gemini needs, in the order a reader should set them. */
export const GEMINI_REQUIRED_VARS = ['GEMINI_API_KEY'] as const;

export function geminiStatus(): IntegrationStatus {
  return statusFor(GEMINI_REQUIRED_VARS, 'AI triage is therefore unavailable.', 'Every report is still recorded and reviewed by a person.');
}

export function isGeminiConfigured(): boolean {
  return geminiStatus().configured;
}

/**
 * The Gemini tunables.
 *
 * Every field has a documented default (docs/21 §2) so a build with none of
 * them set behaves exactly as docs/09 §7 specifies for a missing key: triage
 * is skipped and the deterministic fallback runs. No field here is a secret.
 */
export function geminiConfig() {
  return {
    apiKey: optionalString('GEMINI_API_KEY'),
    model: optionalString('GEMINI_MODEL', 'gemini-2.5-flash'),
    timeoutMs: tunableNumber('GEMINI_TIMEOUT_MS', 20_000, 1_000, 120_000),
    maxRetries: tunableNumber('GEMINI_MAX_RETRIES', 3, 0, 5),
    rpmLimit: tunableNumber('GEMINI_RPM_LIMIT', 8, 0, 1_000),
    rpdLimit: tunableNumber('GEMINI_RPD_LIMIT', 200, 0, 100_000),
    audioEnabled: optionalBoolean('GEMINI_AUDIO_ENABLED', true),
    /** FR-024. Below this the UI says "needs review". */
    confidenceReviewThreshold: tunableNumber('AI_CONFIDENCE_REVIEW_THRESHOLD', 0.6, 0, 1),
    /** docs/09 §12. The ONE repair attempt allowed after a schema failure. */
    repairAttempts: tunableNumber('AI_REPAIR_ATTEMPTS', 1, 0, 2),
    /** docs/09 §12. The local RPM/RPD guard. Not the abuse control — see the note there. */
    localQuotaGuard: optionalBoolean('AI_ENABLE_LOCAL_QUOTA_GUARD', true),
  } as const;
}

/**
 * Is the deterministic-response development mode on? brief §26.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE PLACE THAT DECIDES, AND IT REFUSES PRODUCTION
 * ---------------------------------------------------------------------------
 * A "mock" AI is a genuinely dangerous thing to have in an emergency system, and
 * the danger is specific: a branch that makes triage "succeed" without a provider
 * is invisible in a demo and catastrophic in production, because every field looks
 * populated and nothing was actually assessed. docs/32 MUST 7 forbids it, and
 * `scripts/security-check.cjs` fails the build on a `NODE_ENV`/`DEV` branch in an
 * integration adapter.
 *
 * So the flag is honoured only when ALL of the following hold, and the decision
 * lives in one function so it cannot be spread across the adapter:
 *
 *  1. `AI_MOCK_MODE` is explicitly `true`. Never inferred, never a default.
 *  2. `NODE_ENV` is not `production` (docs/16's own precedent — `ALLOW_SEED` is
 *     refused the same way).
 *  3. `GEMINI_API_KEY` is absent. If a real key is present the real provider is
 *     used, so enabling the flag by accident in a configured environment cannot
 *     shadow a working integration.
 *
 * Condition 3 is the one that makes this safe in practice: a deployment with a
 * real key is immune regardless of the flag, and the only environments where the
 * canned path can activate are ones with no key and therefore already on the
 * keyword fallback for every other reason.
 *
 * It is NOT a `getTriageProvider()` branch, and `services/integrations/gemini/index.ts`
 * contains no environment read at all — see the check above. The provider class is
 * selected here and the result is a normal `TriageProvider`.
 */
export function isAiMockMode(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (!optionalBoolean('AI_MOCK_MODE', false)) return false;
  return optionalString('GEMINI_API_KEY') === '';
}

/* --- Uploads — docs/15 §7, read by services/uploads/* ------------------- */

/* --- Duplicate detection - docs/07 §9.5, DEC-01/DEC-02 --------------------- */

/**
 * The duplicate-detection tunables.
 *
 * **These are environment variables because the brief requires it and the
 * specification already does.** brief §18: "Implement duplicate detection around a
 * configurable radius... **Do NOT hardcode 500 throughout the application.**"
 * `docs/01` DEC-01 records the decision as "500 m duplicate radius, configurable
 * 100-2000 m" with the rationale "a street-crossing radius", and DEC-02 sets the
 * time window.
 *
 * The bounds passed to `tunableNumber` are DEC-01 and DEC-02's own ranges, so an
 * operator who sets `DUPLICATE_RADIUS_METERS=5000` gets the documented 2000 rather
 * than a 5 km radius that would match half a city's incidents. A configurable value
 * whose configuration is unvalidated is a hardcoded value with extra steps.
 *
 * `lookbackHours` is expressed in hours because the brief and every environment
 * variable in this project are, and converted once here to the **360 minutes**
 * `docs/07 §9.5` specifies. The brief's example of 24 is an example; DEC-02's
 * 6-hour default is the decision, and the two disagree. See
 * `docs/30.7_PHASE_6_MAPS_DUPLICATES.md` §2.
 */
export function duplicateConfig() {
  return {
    /** DEC-01. 500 m, range 100-2000. */
    radiusM: tunableNumber('DUPLICATE_RADIUS_METERS', 500, 100, 2000),
    /**
     * DEC-02. 360 min = 6 h, range 60-4320 min (1 h - 72 h).
     *
     * The env var is in HOURS because that is the unit an operator thinks in, and
     * `tunableNumber` receives the equivalent MINUTE range so the clamp is still
     * enforced in the unit the value is stored in. A `DUPLICATE_LOOKBACK_HOURS=1`
     * is therefore clamped to 1 h, and `=200` to 72 h.
     */
    timeWindowMin: tunableNumber('DUPLICATE_LOOKBACK_HOURS', 6, 1, 72) * 60,
    /** Auto-confirm similarity floor. `docs/07 §9.5`. */
    textSimilarityConfirm: tunableNumber('DUPLICATE_TEXT_CONFIRM', 0.6, 0.2, 0.9),
    /** Potential-duplicate score floor. `docs/07 §9.5`. */
    potentialThreshold: tunableNumber('DUPLICATE_POTENTIAL', 0.55, 0.2, 0.95),
    /**
     * The `limit()` read cap. FR-037.
     *
     * **Also the Firestore read budget, and the reason `docs/07 §9.2`'s "one read"
     * rule matters so much.** Ten queries at 50 documents each is 500 document reads
     * for one duplicate check, which at Firestore's pricing is a real cost on every
     * report. One query at 50 is 50.
     */
    maxCandidates: tunableNumber('DUPLICATE_MAX_CANDIDATES', 50, 10, 200),
  } as const;
}

/* --- Uploads — docs/15 §7, read by services/uploads/* ------------------- */

/**
 * The upload tunables.
 *
 * Every default is the documented value from docs/15 §7.1, so a deployment with
 * none of them set behaves exactly as the specification describes rather than as
 * whatever the code happened to default to.
 *
 * `maxImageBytes` and `maxAudioBytes` are the two numbers a reader is most likely
 * to want to argue with, so both carry the reason they are what they are:
 * 5 MiB is FR-005's per-image cap, and 15 MiB is FR-006's per-clip cap. The
 * reason the architecture is shaped around them is §7.2: base64 inflates by
 * 1.37x, so the largest allowed file exceeds Vercel's 4 MiB body limit and the
 * upload MUST go browser-to-Storage directly. That arithmetic is why this is an
 * env var at all rather than a constant in a route.
 */
export function uploadConfig() {
  return {
    maxImageBytes: tunableNumber('UPLOAD_MAX_IMAGE_BYTES', 5_242_880, 1024, 15 * 1024 * 1024),
    maxAudioBytes: tunableNumber('UPLOAD_MAX_AUDIO_BYTES', 15_728_640, 1024, 20 * 1024 * 1024),
    /** docs/15 §10.2. The client auto-stops at this; the server refuses above it. */
    maxAudioDurationSec: tunableNumber('UPLOAD_MAX_AUDIO_SEC', 120, 5, 300),
    /** docs/15 §7.1. A signed PUT URL's lifetime. */
    signedUrlTtlSec: tunableNumber('UPLOAD_SIGNED_URL_TTL_SEC', 900, 60, 3600),
    /** docs/15 §3.3, §16.2. How long an unclaimed staging object survives. */
    stagingSweepMin: tunableNumber('STAGING_UPLOAD_SWEEP_MIN', 30, 1, 1440),
    /**
     * How far into an object the sniffer reads. docs/15 §5.2.4 is explicit that
     * 4 KiB is NOT enough for `audio/webm`: the `Segment`/`Tracks` elements that
     * identify the track types routinely sit beyond it, so a legitimate 90-second
     * voice note would be rejected. 64 KiB is the documented mitigation and the
     * default here.
     */
    sniffBytes: tunableNumber('UPLOAD_SNIFF_BYTES', 65_536, 4096, 1_048_576),
  } as const;
}

/* --- Google Maps - docs/21 §2, docs/12 ------------------------------------ */

export const GOOGLE_MAPS_SERVER_VARS = ['GOOGLE_MAPS_SERVER_KEY'] as const;

export function googleMapsStatus(): IntegrationStatus {
  return statusFor(
    GOOGLE_MAPS_SERVER_VARS,
    'Server-side geocoding and distance lookups are therefore unavailable.',
    'The map still renders from stored coordinates, and the list view is unaffected.',
  );
}

export function isGoogleMapsServerConfigured(): boolean {
  return googleMapsStatus().configured;
}

export function googleMapsConfig() {
  return {
    serverKey: optionalString('GOOGLE_MAPS_SERVER_KEY'),
    region: optionalString('GOOGLE_MAPS_REGION', 'IN'),
    defaultCenter: optionalString('GOOGLE_MAPS_DEFAULT_CENTER', '17.4478,78.4874'),
    localRpmLimit: tunableNumber('GEOCODING_RPM_LOCAL', 30, 0, 1_000),
  } as const;
}

/* --- Twilio — docs/13, docs/21 §2 ---------------------------------------- */

export const TWILIO_VARS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER',
] as const;

export function twilioStatus(): IntegrationStatus {
  return statusFor(
    TWILIO_VARS,
    'SMS and WhatsApp are therefore unavailable.',
    'In-app notifications are unaffected and every user-visible alert still works.',
  );
}

export function isTwilioConfigured(): boolean {
  return twilioStatus().configured;
}

export function twilioConfig() {
  return {
    accountSid: optionalString('TWILIO_ACCOUNT_SID'),
    authToken: optionalString('TWILIO_AUTH_TOKEN'),
    whatsappNumber: optionalString('TWILIO_WHATSAPP_NUMBER'),
    smsEnabled: optionalBoolean('ENABLE_SMS_NOTIFICATIONS', false),
    whatsappEnabled: optionalBoolean('ENABLE_WHATSAPP_NOTIFICATIONS', false),
    retryLimit: tunableNumber('NOTIFICATION_RETRY_LIMIT', 2, 0, 5),
  } as const;
}

/* --- Mapbox — docs/21 §2, docs/12 ------------------------------------------ */

/**
 * Mapbox is the CLIENT-side map, so the token the browser needs is a public one.
 *
 * It is declared here rather than only in `lib/env.client.ts` because the admin
 * provider panel has to be able to answer "is Mapbox configured?" from the SERVER,
 * and `NEXT_PUBLIC_*` variables are readable in both places — Next inlines them at
 * build time, so the server bundle sees the same string the browser does. Reading
 * it here is therefore the same read the browser makes, not a second source.
 *
 * The SERVER token is deliberately absent from this list. `.env.example` is
 * explicit that a Mapbox secret must never be exposed, and a list that included
 * it would invite someone to add it "so the panel can see it".
 */
export const MAPBOX_REQUIRED_VARS = ['NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN'] as const;

export function mapboxStatus(): IntegrationStatus {
  return statusFor(
    MAPBOX_REQUIRED_VARS,
    'The map, and therefore location display on every incident, is unavailable.',
    'Incident lists and all non-map features are unaffected.',
  );
}

export function isMapboxConfigured(): boolean {
  return mapboxStatus().configured;
}

/**
 * The token used for SERVER-SIDE GEOCODING.
 *
 * ---------------------------------------------------------------------------
 * THIS REUSES THE PUBLIC TOKEN, AND THAT IS A DELIBERATE, ACCEPTED TRADEOFF
 * ---------------------------------------------------------------------------
 * The textbook answer is a second, secret, server-only token: the public token is
 * inlined by Next at build time and anyone can lift it from the JavaScript, and
 * geocoding is metered per request, so a public geocoding token is a bill anyone on
 * the internet can inflate.
 *
 * This deployment does not do that, because the project decided against adding a
 * second geocoding credential. So `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` is read here,
 * on the server, and used for the forward-geocode request.
 *
 * WHAT THAT COSTS, stated plainly so nobody is surprised:
 *  - Anyone who opens the app can read the token out of the bundle.
 *  - They can therefore call Mapbox's geocoder with it, and the bill lands here.
 *  - `.env.example` says "NEVER put a Mapbox secret/server token in NEXT_PUBLIC_" —
 *    that is still true, and still why a public token is the *only* thing in
 *    `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`. We are not exposing a secret; we are
 *    deliberately spending a public one on a metered endpoint.
 *
 * THE MITIGATION, and it is not optional: the token MUST be restricted in the
 * Mapbox dashboard by URL so it only answers requests from this deployment's origin.
 * That caps the blast radius to our own traffic rather than the open internet. It
 * does not make the risk zero — a referrer restriction is defeatable by anyone who
 * spoofs a header — it makes it a cost that tracks our real traffic.
 *
 * IF THIS EVER MATTERS: switching to a secret token is a one-line change here plus
 * one new variable. `geocodeAddress` already treats an absent token as
 * `provider_unavailable`, which degrades an address-only report into a report with
 * a stated warning rather than losing it, so that migration is safe to make later.
 */
export function geocodingToken(): string | null {
  // `|| null`, not the raw result: `optionalString` returns its fallback — an empty
  // string — for an absent variable, and `'' !== null` reads as "configured". That
  // turned an unset token into a live geocoding path that failed at request time
  // instead of degrading, which is exactly the outcome this function exists to avoid.
  return optionalString('NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN') || null;
}

/**
 * The language geocoding results are returned in. docs/12 §5 — the app's UI language.
 *
 * There is no dedicated geocoding-language variable: this deployment adds no
 * geocoding-specific configuration. The app's own locale is the right answer anyway,
 * since a citizen typing an address is typing it in the language they are reading
 * the form in.
 */
export function geocodingLanguage(): string {
  return optionalString('NEXT_PUBLIC_DEFAULT_LOCALE') || 'en';
}

/**
 * Whether this deployment INTENDS to use Mapbox.
 *
 * `MAPBOX_ENABLED` is an explicit opt-in signal, and it exists because "token
 * absent" and "Mapbox deliberately not wanted" are indistinguishable from
 * configuration alone. Without it the provider panel cannot render the difference,
 * and every deployment that will never use Mapbox shows a permanent red gap that
 * an operator has to chase at 3am.
 *
 * It does NOT default to "inferred from the token": that would make this function
 * a restatement of `mapboxStatus()` and therefore useless as an intent signal.
 * Absent or unparseable means TRUE — a provider is expected unless someone says
 * otherwise — which fails toward "please look at this", never toward "hide it".
 */
export function isMapboxEnabled(): boolean {
  const raw = process.env.MAPBOX_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

export function mapboxConfig() {
  return {
    accessToken: optionalString('NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN'),
    defaultZoom: tunableNumber('MAPBOX_DEFAULT_ZOOM', 13, 1, 22),
    maxZoom: tunableNumber('MAPBOX_MAX_ZOOM', 18, 1, 24),
  } as const;
}

/* --- ImageKit — docs/15, docs/21 §2 ----------------------------------------- */

/**
 * Evidence storage.
 *
 * TWO variables matter and they are not interchangeable: the public key identifies
 * the account to the browser, and the private key signs the uploads. A
 * configuration with the public key but no private key can upload nothing, which
 * is the case `state: 'degraded'` exists to describe — it is not the same
 * situation as being entirely unconfigured, and an operator who cannot tell those
 * apart will try the wrong fix.
 */
export const IMAGEKIT_REQUIRED_VARS = [
  'NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY',
  'IMAGEKIT_PRIVATE_KEY',
  'IMAGEKIT_URL_ENDPOINT',
] as const;

/** Only the pair that actually gates an upload. Used for the degraded check. */
export const IMAGEKIT_UPLOAD_VARS = ['IMAGEKIT_PRIVATE_KEY', 'IMAGEKIT_URL_ENDPOINT'] as const;

export function imagekitStatus(): IntegrationStatus {
  return statusFor(
    IMAGEKIT_REQUIRED_VARS,
    'Photo and audio evidence cannot be uploaded, though every report is still accepted without it.',
    'Incidents, triage, and dispatch are unaffected.',
  );
}

export function isImagekitConfigured(): boolean {
  return imagekitStatus().configured;
}

/** True when the browser can be given a public key, even if uploads cannot work. */
export function isImagekitPublicConfigured(): boolean {
  return statusFor(['NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY'], '', '').configured;
}

/** True when a signed upload can actually be issued. */
export function isImagekitUploadConfigured(): boolean {
  return IMAGEKIT_UPLOAD_VARS.every((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/* --- AssemblyAI — docs/15 §9, docs/21 §2 ------------------------------------ */

export const ASSEMBLYAI_REQUIRED_VARS = ['ASSEMBLYAI_API_KEY'] as const;

export function assemblyaiStatus(): IntegrationStatus {
  return statusFor(
    ASSEMBLYAI_REQUIRED_VARS,
    'Voice notes are stored but not transcribed, so triage falls back to their absence.',
    'A caller who reports by text is completely unaffected.',
  );
}

export function isAssemblyaiConfigured(): boolean {
  return assemblyaiStatus().configured;
}

export function assemblyaiConfig() {
  return {
    apiKey: optionalString('ASSEMBLYAI_API_KEY'),
    timeoutMs: tunableNumber('ASSEMBLYAI_TIMEOUT_MS', 60_000, 1_000, 300_000),
    pollIntervalMs: tunableNumber('ASSEMBLYAI_POLL_INTERVAL_MS', 3_000, 500, 30_000),
  } as const;
}

/* --- Operations ---------------------------------------------------------- */

export function cronSecret(): string | null {
  const value = optionalString('CRON_SECRET');
  return value === '' ? null : value;
}

export function ipHashSalt(): string | null {
  const value = optionalString('IP_HASH_SALT');
  return value === '' ? null : value;
}

/**
 * The global request budget. docs/21 §2, default 15000.
 *
 * Applied by `lib/server/route.ts` to the handler as a whole. A handler that
 * exceeds it is converted to `504 TIMEOUT`, so a hanging Gemini call becomes a
 * clean error rather than a platform-level 504 with no body.
 */
export function requestTimeoutMs(): number {
  return tunableNumber('REQUEST_TIMEOUT_MS', 15_000, 1_000, 120_000);
}

/**
 * The rate-limit store, per docs/21 §2 and docs/10 §17.1.
 *
 * `memory` is DOCUMENTED AS UNSAFE and is refused in production rather than
 * honoured. A Vercel function is a single-use process: an in-process counter is
 * multiplied by the instance count and resets on every cold start, so it is not
 * a limit at all. Refusing loudly beats pretending.
 */
export function rateLimitConfig() {
  const store = optionalString('RATE_LIMIT_STORE', 'firestore');
  return {
    store: store === 'memory' ? ('memory' as const) : ('firestore' as const),
    windowSec: tunableNumber('RATE_LIMIT_WINDOW_SEC', 3600, 1, 86_400),
    /** docs/21 §2: read `x-forwarded-for` on Vercel, where the proxy is ours. */
    trustProxy: optionalBoolean('RATE_LIMIT_TRUST_PROXY', true),
  } as const;
}

/* ========================================================================== */
/* Tier 3 — the whole picture                                                 */
/* ========================================================================== */

/**
 * Every integration's readiness, for `GET /api/admin/system/health`.
 *
 * NAMES only, never values. An admin endpoint is the one place where a
 * configuration summary is appropriate, and even there the value of a secret is
 * never serialised — a leaked health endpoint is how a database URL ends up in
 * a screenshot (docs/10 §16.3, control 7).
 */
export function integrationStatus(): {
  readonly firebaseAdmin: IntegrationStatus;
  readonly gemini: IntegrationStatus;
  readonly googleMapsServer: IntegrationStatus;
  readonly twilio: IntegrationStatus;
  readonly cron: IntegrationStatus;
} {
  return {
    firebaseAdmin: {
      required: ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'],
      configured: isAdminConfigured(),
      problem: adminConfigurationProblem(),
    },
    gemini: geminiStatus(),
    googleMapsServer: googleMapsStatus(),
    twilio: twilioStatus(),
    cron: statusFor(
      ['CRON_SECRET'],
      'The scheduled jobs are therefore refused.',
      'This is expected in local development and required in production.',
    ),
  };
}

/**
 * Configuration mistakes that must STOP the server, as sentences.
 *
 * Returns a list rather than throwing, because there are two different callers
 * with two different needs: the Admin SDK bootstrap wants to throw (it cannot
 * work), and the admin health route wants to LIST them (that is its job).
 *
 * Each entry is a `DECISION REQUIRED`-grade condition, not a style preference:
 *
 *   1. `ALLOW_SEED=true` in production would let `scripts/seed.ts` write demo
 *      data into the live project (docs/21 §4, FR-147).
 *   2. `RATE_LIMIT_STORE=memory` on a stateless platform is not a limit
 *      (docs/10 §17.1).
 *   3. A `NEXT_PUBLIC_*` value containing `-----BEGIN` is a service-account key
 *      that has been given a browser-visible name, which publishes it
 *      (docs/21 §6).
 */
export function serverEnvProblems(): string[] {
  const problems: string[] = [];
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && optionalBoolean('ALLOW_SEED', false)) {
    problems.push(
      'ALLOW_SEED is true in a production build. Seeding writes demo incidents into the live project; set it to false.',
    );
  }

  if (optionalString('RATE_LIMIT_STORE', 'firestore') === 'memory') {
    problems.push(
      'RATE_LIMIT_STORE=memory. A serverless function is a single-use process, so an in-memory counter resets on every cold start and is multiplied by the instance count. Use firestore.',
    );
  }

  // Phase 4. brief §26 asks for a development mock, and docs/32 MUST 7 forbids a
  // provider that can "succeed" without one. Both are satisfiable only if the
  // flag is reported rather than merely refused at the call site, so this is a
  // FAULT even in development: a non-empty problem list is what
  // `/api/admin/system/health` shows an operator, and a mock that is silently on
  // is exactly the state nobody should be in.
  //
  // Two separate messages, because "you have a mock on" and "you have a mock on
  // IN PRODUCTION" are different urgencies and an operator reading a single
  // combined sentence cannot tell which they are looking at.
  if (optionalBoolean('AI_MOCK_MODE', false)) {
    problems.push(
      isProduction
        ? 'AI_MOCK_MODE is TRUE IN A PRODUCTION BUILD. AI triage is returning a canned response instead of calling Gemini, so no emergency report is being assessed. Unset it and redeploy.'
        : 'AI_MOCK_MODE is enabled, so AI triage returns a canned response instead of calling Gemini. ' +
          'It is refused in production and ignored whenever GEMINI_API_KEY is set. Unset it before sharing a build.',
    );
  }

  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('NEXT_PUBLIC_')) continue;
    if (typeof value === 'string' && value.includes('-----BEGIN')) {
      problems.push(
        `${name} contains a private key block. Anything prefixed NEXT_PUBLIC_ is published to the browser.`,
      );
    }
  }

  if (isProduction) {
    const appUrl = optionalString('NEXT_PUBLIC_APP_URL');
    if (appUrl !== '' && !appUrl.startsWith('https://')) {
      problems.push(
        'NEXT_PUBLIC_APP_URL is not https in production, which makes the CSRF origin check bypassable by a network attacker.',
      );
    }
  }

  return problems;
}

/**
 * Throw when the deployment is misconfigured in a way that cannot be worked
 * around. Called once per server instance from the Admin SDK bootstrap.
 */
export function assertServerInvariants(): void {
  const problems = serverEnvProblems();
  if (problems.length === 0) return;
  throw new ServerEnvError(
    'server configuration',
    problems.join(' '),
  );
}

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/**
 * A numeric variable that THROWS on a malformed value.
 *
 * Used only for a SECURITY-relevant number, where a typo must be loud. An
 * operator who believes they have set `REAUTH_WINDOW_SEC=300` and has not should
 * be told, not silently given the default.
 */
function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ServerEnvError(name, `Expected a number, got "${raw}".`);
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * A numeric integration tunable that FALLS BACK on a malformed value.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM `boundedNumber`
 * ---------------------------------------------------------------------------
 * Because the two failure modes are different. A malformed `REAUTH_WINDOW_SEC`
 * is a security setting an operator believes they have configured, so it must be
 * loud. A malformed `GEMINI_TIMEOUT_MS=20000;` — a stray semicolon from a
 * dashboard paste — is a tuning value on a path that must not be able to fail a
 * request, so it degrades to the documented default.
 *
 * One function for both would mean choosing between two bad outcomes: either a
 * typo silently disables a security window, or a typo takes down an emergency
 * report. Splitting them means neither can happen.
 */
function tunableNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * `NOTIFICATION_RETRY_LIMIT` — the ceiling on delivery attempts per notification.
 *
 * `docs/21` records it; `brief §5` requires controlled retries with no infinite
 * loop. The value is a RETRY count, so total attempts are `limit + 1` — one initial
 * try plus the retries.
 *
 * Read through an accessor rather than inline so the bound is one number in one place.
 * `services/notifications/dispatch.ts` compares against it before every provider call,
 * which is what makes the ceiling structural: there is no scheduler in that module to
 * run away, only a comparison.
 *
 * Bounded to 0..5: a value above 5 is a configuration mistake, and honouring it would
 * mean a failed SMS provider is retried six times per notification per recipient.
 */
export function notificationRetryLimit(): number {
  return boundedNumber('NOTIFICATION_RETRY_LIMIT', 2, 0, 5);
}

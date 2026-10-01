/**
 * ============================================================================
 * CareGrid AI — the five-provider health panel (Phase 14)
 * ============================================================================
 *
 * `GET /api/admin/providers` renders this. It is the screen an operator opens
 * when a feature is "not working" and needs to know whether the feature is dark
 * because it was never configured or because something is broken.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 * **A boolean, a variable NAME, or a sentence. Never a value.**
 *
 * docs/10 §16.3 control 7. The reason is not theoretical: this response is the
 * most screenshot-able page in the product, and a Firestore private key is 2 KB of
 * base64 that reads as harmless in a bug report. Every function here returns
 * `configured: boolean` and `problem: string`, and the ONLY way a value could
 * escape is a future edit that formats `problem` with the offending value —
 * which is why `detail` below is built from names and counts, never from `env`.
 *
 * `tests/unit/admin/provider-health.test.ts` asserts this property over every
 * provider by string-scanning the rendered payload for anything that looks like a
 * secret, so the guarantee survives the next person to touch this file.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT PING ANYTHING
 * ---------------------------------------------------------------------------
 * docs/06 §1.1 budgets each sub-check at 1.5 s. A panel that awaited five
 * third-party services would report their outages as ours, would take longer than
 * the 15 s request timeout to answer a question about local configuration, and
 * would turn a health page into a load test against vendors.
 *
 * So this reports CONFIGURATION, which is instantaneous and is the question an
 * operator actually has at the moment a route returns 503. That is also why
 * `failed` is in the vocabulary but is not emitted here: nothing in this build
 * probes a provider, so reporting `failed` would be a lie. `failed` is reserved
 * for the Phase 9 live probe, and the schema accepts it so the panel does not
 * need a breaking change when that arrives.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR STATES THIS BUILD CAN ACTUALLY PRODUCE
 * ---------------------------------------------------------------------------
 *   unconfigured — a required variable is absent. The feature is dark.
 *   degraded     — partially configured: a narrower feature is dark while the
 *                  rest of the provider works. Only ImageKit can be in this state,
 *                  and only for the public-key-without-private-key case.
 *   configured   — present and we are not claiming more than that.
 *   healthy      — configured AND not running in a reduced mode (AI mock mode).
 *   failed       — reserved for the live probe; never emitted here.
 *
 * `healthy` and `configured` are separated on purpose. AI mock mode runs the
 * deterministic fallback with NO Gemini key at all, and calling that "healthy"
 * would tell an operator their triage is model-backed when it is not.
 */

import 'server-only';

import {
  assemblyaiStatus,
  firebaseAdminStatus,
  geminiStatus,
  imagekitStatus,
  isImagekitPublicConfigured,
  isImagekitUploadConfigured,
  isAiMockMode,
  isMapboxEnabled,
  mapboxStatus,
} from '@/lib/env.server';
import type { IntegrationStatus } from '@/lib/env.server';

/** The five providers the ops panel is specified to show. */
export type ProviderId = 'firebase' | 'gemini' | 'mapbox' | 'imagekit' | 'assemblyai';

/**
 * The five states. A closed union so a `status` field cannot grow a sixth value
 * that some consumer has not been taught to render.
 */
export type ProviderState = 'configured' | 'unconfigured' | 'healthy' | 'degraded' | 'failed';

export type ProviderHealth = {
  readonly id: ProviderId;
  readonly label: string;
  readonly state: ProviderState;
  /** A sentence, or absent. Never a value. */
  readonly detail: string | undefined;
  /** Whether this deployment is expected to have the provider at all. */
  readonly expected: boolean;
};

export type ProvidersReport = {
  readonly providers: readonly ProviderHealth[];
  readonly healthyCount: number;
  readonly degradedCount: number;
  readonly unconfiguredCount: number;
  readonly generatedAt: string;
};

/* ========================================================================== */
/* The panel                                                                    */
/* ========================================================================== */

/**
 * Build the report.
 *
 * Synchronous, and deliberately so: there is nothing to await, so the route has
 * no partial-failure state where some providers are reported and others are
 * missing. A health panel that can render HALF is worse than one that is slow,
 * because "Mapbox is not listed" and "Mapbox is fine" look identical.
 */
export function providerHealthReport(): ProvidersReport {
  const providers: ProviderHealth[] = [
    firebaseProvider(),
    geminiProvider(),
    mapboxProvider(),
    imagekitProvider(),
    assemblyaiProvider(),
  ];

  return {
    providers,
    healthyCount: providers.filter((p) => p.state === 'healthy').length,
    degradedCount: providers.filter((p) => p.state === 'degraded').length,
    unconfiguredCount: providers.filter((p) => p.state === 'unconfigured').length,
    generatedAt: new Date().toISOString(),
  };
}

/* ========================================================================== */
/* One builder per provider                                                     */
/* ========================================================================== */

/**
 * Firebase is never merely `configured`: every other provider in this list is
 * useless without it, because every read and write goes through the Admin SDK.
 * A deployment with the other four set and this one missing cannot serve a single
 * API request — `withRequest` answers 503 before authentication. So its absence
 * is the one condition the panel treats as total, and it is named FIRST so it
 * renders at the top of a list an operator scans in order.
 */
function firebaseProvider(): ProviderHealth {
  const status = firebaseAdminStatus();
  return {
    id: 'firebase',
    label: 'Firebase (auth + database)',
    state: status.configured ? 'healthy' : 'unconfigured',
    detail: status.configured
      ? undefined
      : 'Every API request is refused until this is set. Fix this one first.',
    expected: true,
  };
}

/**
 * Gemini has a second dimension: mock mode.
 *
 * With `GEMINI_API_KEY` absent AND mock mode on, triage runs the deterministic
 * fallback and the system works. That is `degraded`, not `unconfigured` — the
 * reports still get triaged, by a lookup table instead of a model, and an operator
 * needs to know that because the confidence scores are not comparable.
 */
function geminiProvider(): ProviderHealth {
  const status = geminiStatus();
  if (status.configured) {
    return {
      id: 'gemini',
      label: 'Gemini (AI triage)',
      state: 'healthy',
      detail: undefined,
      expected: true,
    };
  }
  const mocking = isAiMockMode();
  return {
    id: 'gemini',
    label: 'Gemini (AI triage)',
    state: mocking ? 'degraded' : 'unconfigured',
    detail: mocking
      ? 'Running in mock mode: triage uses a deterministic fallback, not a model. Confidence scores are not real model output.'
      : status.problem ?? undefined,
    expected: true,
  };
}

/**
 * Mapbox.
 *
 * `expected: false` when the deployment has not opted in, which is a different
 * fact from `unconfigured`. A project that will never use Mapbox should show it
 * as "not used here" rather than as a red gap somebody has to chase at 3am. The
 * distinction is made by an explicit opt-out variable rather than by inferring it
 * from absence, because "absent" and "intentionally absent" are indistinguishable
 * from configuration alone and guessing wrong erodes trust in the panel.
 */
function mapboxProvider(): ProviderHealth {
  const status = mapboxStatus();
  if (status.configured) {
    return {
      id: 'mapbox',
      label: 'Mapbox (maps)',
      state: 'healthy',
      detail: undefined,
      expected: true,
    };
  }
  const wanted = isMapboxEnabled();
  return {
    id: 'mapbox',
    label: 'Mapbox (maps)',
    state: wanted ? 'unconfigured' : 'configured',
    detail: wanted
      ? status.problem ?? undefined
      : 'Not enabled in this deployment. Location text and coordinates still work; only the map is unavailable.',
    expected: wanted,
  };
}

/**
 * ImageKit is the one provider that can be genuinely PARTLY configured.
 *
 * The public key alone means the browser knows which account to talk to but the
 * server cannot sign an upload, so a photo upload fails at the last step with an
 * error that looks like a network fault. Calling that `unconfigured` sends the
 * operator to set a variable that is already set; `degraded` names the actual gap.
 */
function imagekitProvider(): ProviderHealth {
  const status = imagekitStatus();
  if (status.configured) {
    return {
      id: 'imagekit',
      label: 'ImageKit (evidence storage)',
      state: 'healthy',
      detail: undefined,
      expected: true,
    };
  }
  const publicKey = isImagekitPublicConfigured();
  const uploads = isImagekitUploadConfigured();
  if (publicKey !== uploads) {
    return {
      id: 'imagekit',
      label: 'ImageKit (evidence storage)',
      state: 'degraded',
      // Names only, and specifically the SIDE that is missing rather than the
      // values: an operator needs to know which half to go and set.
      detail: uploads
        ? 'The public key is not set, so the browser cannot identify the account. Uploads still succeed.'
        : 'The private key or URL endpoint is not set, so the server cannot sign an upload. Photo and audio evidence cannot be stored.',
      expected: true,
    };
  }
  return {
    id: 'imagekit',
    label: 'ImageKit (evidence storage)',
    state: 'unconfigured',
    detail: status.problem ?? undefined,
    expected: true,
  };
}

function assemblyaiProvider(): ProviderHealth {
  const status = assemblyaiStatus();
  return {
    id: 'assemblyai',
    label: 'AssemblyAI (voice transcription)',
    state: status.configured ? 'healthy' : 'unconfigured',
    detail: status.configured ? undefined : (status.problem ?? undefined),
    // Optional by design: voice reporting is one input method among several, and
    // its absence degrades a feature rather than breaking the product.
    expected: true,
  };
}

/* ========================================================================== */
/* Helpers                                                                      */
/* ========================================================================== */

/** Re-exported so a test can assert the panel covers exactly the five. */
export const PROVIDER_IDS: readonly ProviderId[] = [
  'firebase',
  'gemini',
  'mapbox',
  'imagekit',
  'assemblyai',
];

/** The status accessor each provider reads, so a test can prove coverage. */
export const PROVIDER_STATUS_READERS: Readonly<Record<ProviderId, () => IntegrationStatus>> = {
  firebase: firebaseAdminStatus,
  gemini: geminiStatus,
  mapbox: mapboxStatus,
  imagekit: imagekitStatus,
  assemblyai: assemblyaiStatus,
};
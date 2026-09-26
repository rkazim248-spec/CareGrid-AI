/**
 * ============================================================================
 * CareGrid AI — the Google Maps integration
 * ============================================================================
 *
 * Server-side geocoding and reverse geocoding. The ONE file that reads
 * `GOOGLE_MAPS_SERVER_KEY`.
 *
 * ---------------------------------------------------------------------------
 * THE TWO KEYS, AND WHY THEY ARE DIFFERENT FILES' WORRIES
 * ---------------------------------------------------------------------------
 * | Key                          | Read by                          | Restricted by      |
 * |------------------------------|----------------------------------|--------------------|
 * | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | `lib/env.client.ts` (the map) | HTTP referrers  |
 * | `GOOGLE_MAPS_SERVER_KEY`     | this file                        | IP addresses      |
 *
 * The browser key loads the Maps JavaScript API and is public by construction —
 * a browser cannot hold a secret. The server key is billed per call and MUST
 * never reach a bundle, which is why it lives in `lib/env.server.ts` and not in
 * `lib/env.client.ts` (docs/21 §5).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS IN PHASE 3
 * ---------------------------------------------------------------------------
 * A complete, honest, NON-FUNCTIONAL adapter, for the same reason Gemini's is:
 * no key, no calls, and a typed `MAPS_UNAVAILABLE` rather than a fabricated
 * coordinate.
 *
 * The failure mode this defends against is the most dangerous class of bug in
 * the product. A geocoder that "helpfully" returns `0, 0` when it has no key
 * puts a fabricated location in the middle of the Indian Ocean on a real
 * emergency report, and every responder is then sent there. `null` is the only
 * honest answer and it is what this returns.
 *
 * ---------------------------------------------------------------------------
 * WHAT PHASE 6 ADDS, AND ONLY HERE
 * ---------------------------------------------------------------------------
 * `geocode()` and `reverseGeocode()` over the Geocoding API, with:
 *   - `GEOCODING_RPM_LOCAL` as a LOCAL per-minute guard, so a typing user or a
 *     re-render loop cannot exhaust the project's Google quota (docs/21 §2);
 *   - `GOOGLE_MAPS_REGION` as the `region` bias parameter;
 *   - `GOOGLE_MAPS_DEFAULT_CENTER` only for a map's initial viewport, never as a
 *     fallback for a failed lookup;
 *   - a 6-second timeout, per docs/08 §1.1;
 *   - `GEOCODE_FAILED` (422) for "no result", and `MAPS_UNAVAILABLE` (502) for
 *     "the provider failed". They are different: one is a permanent answer
 *     about the input, the other is worth a retry.
 *
 * The list fallback (docs/12 §9) is already the documented behaviour when this
 * is unavailable, so a dead geocoder degrades the map and nothing else.
 */

import 'server-only';

import { AppError } from '@/lib/server/errors';
import {
  googleMapsConfig,
  googleMapsStatus,
  type IntegrationStatus,
} from '@/lib/env.server';
import type {
  GeocodeResult,
  GeocodingProvider,
  ProviderCallOptions,
  ProviderStatus,
} from '@/lib/integrations/contracts';

/** docs/08 §1.1: the Maps budget is 8 seconds, not the AI's 20. */
export const MAPS_TIMEOUT_MS = 8_000;

class UnconfiguredMapsProvider implements GeocodingProvider {
  readonly name = 'google-maps';

  isAvailable(): boolean {
    return false;
  }

  async geocode(_query: string, _options: ProviderCallOptions): Promise<GeocodeResult> {
    throw mapsUnavailable();
  }

  async reverseGeocode(
    _point: { readonly lat: number; readonly lng: number },
    _options: ProviderCallOptions,
  ): Promise<GeocodeResult> {
    throw mapsUnavailable();
  }
}

/**
 * The single sentence every Maps failure produces.
 *
 * `502`, not `503`: the request was well-formed and we reached a boundary we
 * intended to reach, so the fault is upstream. `503` would tell a client to
 * back off, which is right for a database and wrong for a geocoder whose quota
 * is not the caller's problem.
 */
function mapsUnavailable(): AppError {
  return new AppError({
    code: 'MAPS_UNAVAILABLE',
    message:
      'Location lookup is unavailable, so this place is shown without a name. ' +
      'The coordinates and the list view are unaffected.',
  });
}

const CACHE_KEY = '__caregrid_maps_provider_v1__';
type GlobalWithProvider = typeof globalThis & { [CACHE_KEY]?: GeocodingProvider };

export function getGeocodingProvider(): GeocodingProvider {
  const cache = globalThis as GlobalWithProvider;
  const existing = cache[CACHE_KEY];
  if (existing) return existing;
  const provider: GeocodingProvider = new UnconfiguredMapsProvider();
  cache[CACHE_KEY] = provider;
  return provider;
}

export function resetMapsProviderForTests(): void {
  delete (globalThis as GlobalWithProvider)[CACHE_KEY];
}

export function providerStatus(): ProviderStatus {
  const status: IntegrationStatus = googleMapsStatus();
  return {
    provider: 'google-maps',
    configured: status.configured,
    requiredVars: status.required,
    problem: status.problem,
  };
}

/** The non-secret tunables, for the admin health endpoint. */
export function mapsSettings() {
  const config = googleMapsConfig();
  return {
    region: config.region,
    defaultCenter: config.defaultCenter,
    localRpmLimit: config.localRpmLimit,
    timeoutMs: MAPS_TIMEOUT_MS,
  };
}

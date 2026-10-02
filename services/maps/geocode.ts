/**
 * ============================================================================
 * CareGrid AI — server-side geocoding (FR-035)
 * ============================================================================
 *
 * Why a service rather than an inline `fetch` in the route:
 *
 *  - **The browser never performs the geocode.** A Mapbox access token in a
 *    `NEXT_PUBLIC_` variable is public by construction. That is acceptable for
 *    rendering a map. So the geocode call goes through the server: the request is
 *    logged, rate-limited and counted against our own budget rather than fired
 *    straight from a citizen's device where anyone could replay it.
 *
 *    Stated honestly, because this is a weaker claim than it first looks: the token
 *    this service authenticates with is that SAME public token, so it does not
 *    prevent someone lifting a token and geocoding with it. What it buys is that
 *    every legitimate call is attributable to a submission we accepted, and the
 *    token can be URL-restricted to our origin so the bill tracks our real traffic
 *    instead of the open internet. See `geocodingToken()` in `lib/env.server.ts`.
 *  - **It is a dependency, so it is mockable.** Every other service in this file
 *    tree takes a seam so tests can drive it without a network. A bare `fetch`
 *    inside a route handler has no seam, which is how geocoding ends up being the
 *    one thing in an emergency path that cannot be tested.
 *  - **It must degrade, not fail.** An address that cannot be geocoded is still a
 *    real report from a real citizen at a real place. Losing the incident because a
 *    third-party geocoder was down would be exactly the wrong trade.
 *
 * ---------------------------------------------------------------------------
 * PROVIDER: MAPBOX GEOCODING, NOT GOOGLE
 * ---------------------------------------------------------------------------
 * Mapbox is already the map provider and its token is already configured, so
 * there is no new credential to provision and no second billing relationship. The
 * Google geocoding integration that previously lived in
 * `services/integrations/google-maps` had no configured key, which meant it could
 * only ever have been a code path that failed at runtime.
 *
 * The tradeoff is stated once here so it is not rediscovered as a surprise: reusing
 * the configured public token for metered calls is cheaper to configure and weaker
 * than a secret server token. That is a deliberate choice for this deployment.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT RETURNS, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * It returns a point plus the geocoder's own granularity, because docs/12 §2.1
 * requires an `address_text` fix to grade `low` at best: a street-address match is
 * a street-level approximation, and reporting it as `high` would put a responder's
 * "this is the exact place" trust in a result that is not exact.
 *
 * It NEVER returns a partial match as if it were a full one. Mapbox answers with a
 * `feature.properties.accuracy` and can return a `poi`/`address`/`place`/`locality`
 * hierarchy; only `address`, `street`, `poi` and `place` are specific enough to
 * place an emergency. A `locality` hit — the whole district — is reported as a
 * failure (`'too_coarse'`) rather than silently downgraded, because an
 * emergency at the district level cannot be dispatched to and the citizen needs to
 * be told to be more specific.
 */

import { createLogger } from '@/lib/server/http';
import { geocodingLanguage, geocodingToken } from '@/lib/env.server';

const log = createLogger('svc:geocode');

/**
 * How specific a match must be to be usable.
 *
 * Mapbox's `accuracy` values, most to least precise. `locality` and the rest are
 * deliberately absent.
 */
const USABLE_ACCURACY = new Set(['rooftop', 'exact', 'street', 'address', 'poi', 'place']);

/** Ranked for the `accuracyGrade` decision. Lower index is more precise. */
const ACCURACY_RANK = ['rooftop', 'exact', 'street', 'address', 'poi', 'place'] as const;

export type GeocodeResult =
  | {
      readonly ok: true;
      readonly lat: number;
      readonly lng: number;
      /** The geocoder's own declared radius, metres. Never a guess. */
      readonly accuracyM: number;
      /** `'address' | 'street' | 'poi' | 'place'` — what was actually matched. */
      readonly matchType: string;
      /** A short label. A locality or city name, never a house number we invented. */
      readonly label: string | null;
    }
  /** Nothing matched, or nothing usable. Never fatal to the report. */
  | { readonly ok: false; readonly reason: 'no_match' | 'too_coarse' | 'provider_unavailable' };

/* ========================================================================== */
/* The fetch seam                                                              */
/* ========================================================================== */

/**
 * The one injectable dependency.
 *
 * Defaults to the real `fetch`. Tests pass a stub, so no test in this repo ever
 * needs a network or an API key to cover the address path.
 */
export type GeocodeFetch = (
  input: string,
  init: { signal: AbortSignal; headers: Readonly<Record<string, string>> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

let fetchImpl: GeocodeFetch = (input, init) =>
  // The global `fetch` satisfies the narrow structural type; the cast is because
  // its `Response.json()` returns `Promise<any>` and we want `Promise<unknown>`
  // to keep the parse honest.
  fetch(input, init as RequestInit) as Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;

/** Swap the transport. Returns a restore function. Test-only, like every other seam. */
export function setGeocodeFetch(next: GeocodeFetch): () => void {
  const previous = fetchImpl;
  fetchImpl = next;
  return () => {
    fetchImpl = previous;
  };
}

/* ========================================================================== */
/* Configuration                                                               */
/* ========================================================================== */

/**
 * The Mapbox token to geocode with.
 *
 * Delegates to `lib/env.server` rather than reading `process.env` itself, which is
 * this repo's rule: a service that reads `process.env` directly cannot be reasoned
 * about from one place, and `tests/unit/api/integrations.test.ts` enforces it.
 *
 * Returns `null` when no token is configured, which turns into
 * `provider_unavailable` and degrades an address-only report into a report with a
 * stated warning rather than losing it.
 *
 * On which token this is: this deployment deliberately spends the PUBLIC Mapbox
 * token on metered geocoding instead of adding a second secret credential. That is
 * a real cost — the token is readable in the browser bundle, so the bill is not
 * bounded by our auth — and it is mitigated by a URL restriction on the token in
 * the Mapbox dashboard. The full reasoning, and the one-line path to undoing it,
 * are in `geocodingToken()` in `lib/env.server.ts`. Read that before changing it.
 */
function geocodeToken(): string | null {
  return geocodingToken();
}

/** `false` when geocoding cannot run. The form uses this to warn, never to block. */
export function isGeocodingConfigured(): boolean {
  return geocodeToken() !== null;
}

/* ========================================================================== */
/* Geocode                                                                     */
/* ========================================================================== */

const TIMEOUT_MS = 4_000;

/** Mapbox rejects free-text queries without these. */
const COUNTRY_BIAS = ['in,north-america', 'in,europe', 'in,africa', 'in,asia', 'in,australia'];

const ENDPOINT = 'https://api.mapbox.com/search/geocode/v6/forward';

/**
 * Turn a typed address into a point.
 *
 * Never throws. Every failure is a `{ ok: false }` value, because the caller is a
 * report-submission path where the geocoder being unavailable must not cost a
 * citizen their report.
 */
export async function geocodeAddress(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<GeocodeResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'no_match' };

  const token = geocodeToken();
  if (token === null) {
    log.warn({ reason: 'not_configured' });
    return { ok: false, reason: 'provider_unavailable' };
  }

  // The citizen's own text is URL-encoded, not interpolated raw, and it is the only
  // caller-supplied value in this request. `limit: 1` because a second candidate
  // would still be a guess and picking between two guesses is not a decision this
  // service should make on a citizen's behalf.
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('access_token', token);
  url.searchParams.set('limit', '1');
  url.searchParams.set('types', 'address,street,poi,place');
  url.searchParams.set('language', geocodingLanguage());
  url.searchParams.set('country', COUNTRY_BIAS.join(','));

  // One timeout for our own fetch, composed with any caller signal so an aborted
  // request really stops and does not leave a socket open.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetchImpl(url.toString(), {
      signal: timeout.signal,
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      // 401/403 is a token problem, which is a deployment fault and worth logging at
      // `error`; a 429 or 5xx is the provider's problem and is only a `warn`.
      const level = response.status === 401 || response.status === 403 ? 'error' : 'warn';
      log[level]({ status: response.status });
      return { ok: false, reason: 'provider_unavailable' };
    }

    const payload = await response.json();
    return readFirstFeature(payload);
  } catch (error) {
    // A timeout, a DNS failure, a CORS-shaped network error, or an abort. All of
    // them mean "we could not geocode", and none of them should be visible to the
    // citizen as a failure of their report.
    log.warn({ reason: 'network', detail: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'provider_unavailable' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Read the single candidate out of a Mapbox v6 forward-geocode response.
 *
 * Written defensively because this is third-party JSON: every field is checked
 * against its shape before it is believed, and a response that does not match is
 * treated as `no_match` rather than as a crash.
 */
function readFirstFeature(payload: unknown): GeocodeResult {
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'no_match' };

  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features) || features.length === 0) return { ok: false, reason: 'no_match' };

  const first = features[0];
  if (typeof first !== 'object' || first === null) return { ok: false, reason: 'no_match' };

  const feature = first as {
    geometry?: { coordinates?: unknown };
    properties?: {
      mapbox_id?: unknown;
      feature_type?: unknown;
      accuracy?: unknown;
      /** Mapbox's declared measurement radius, metres, when the dataset provides one. */
      accuracy_measured?: unknown;
      full_address?: unknown;
      name?: unknown;
      coordinates?: { latitude?: unknown; longitude?: unknown };
    };
  };

  // v6 puts the point in `properties.coordinates`, with `geometry.coordinates` kept
  // for compatibility. v6 puts the match type in `properties.feature_type`. Both are
  // read, and either alone is enough.
  //
  // The fallback to `geometry` is only taken when `properties.coordinates` is
  // ABSENT. A present-but-invalid value (out of range, non-numeric) is rejected
  // outright: falling back there would let a malformed primary silently be replaced
  // by a different, valid-looking point, and an incident would be filed at the
  // origin instead of at the error.
  const declared = feature.properties?.coordinates;
  const point = declared === undefined ? readLngLat(feature.geometry?.coordinates) : readPoint(declared);
  if (point === null) return { ok: false, reason: 'no_match' };

  const featureType = typeof feature.properties?.feature_type === 'string'
    ? feature.properties.feature_type
    : null;
  const legacyAccuracy = typeof feature.properties?.accuracy === 'string' ? feature.properties.accuracy : null;

  const accuracy = featureType ?? legacyAccuracy;
  if (accuracy === null || !USABLE_ACCURACY.has(accuracy)) {
    // `locality`, `district`, `region`, `country`, or a type we do not recognise.
    log.info({ reason: 'too_coarse', accuracy });
    return { ok: false, reason: 'too_coarse' };
  }

  // A declared radius where the provider gives one, otherwise the provider's own
  // precision tier mapped to a conservative metre value. Never an optimistic one:
  // understating the radius would grade a coarse match `high`.
  const declaredRadius = readMetres(feature.properties?.accuracy_measured);
  const accuracyM = declaredRadius ?? DEFAULT_ACCURACY_M[accuracy] ?? 1000;

  const label = firstNonEmptyString([
    feature.properties?.full_address,
    feature.properties?.name,
  ]);

  return {
    ok: true,
    lat: point.lat,
    lng: point.lng,
    accuracyM,
    matchType: accuracy,
    label,
  };
}

/** Conservative radius in metres per precision tier. docs/12 §2.1 floors `address_text` at `low`. */
const DEFAULT_ACCURACY_M: Readonly<Record<string, number>> = {
  rooftop: 30,
  exact: 50,
  address: 100,
  street: 250,
  poi: 300,
  place: 2000,
};

/** `{ latitude, longitude }`, validated. `{ longitude, latitude }` is a classic and real bug. */
function readPoint(value: unknown): { lat: number; lng: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { latitude?: unknown; longitude?: unknown };
  const lat = record.latitude;
  const lng = record.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** `[lng, lat]` GeoJSON order, which is the reverse of `{ lat, lng }`. */
function readLngLat(value: unknown): { lat: number; lng: number } | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lng = value[0];
  const lat = value[1];
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function readMetres(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function firstNonEmptyString(candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim().slice(0, 200);
  }
  return null;
}

/* ========================================================================== */
/* Grade                                                                       */
/* ========================================================================== */

/**
 * The `accuracyGrade` for a geocoded address.
 *
 * A typed address is `street`-ish at best, so this maps the precision tier to a
 * grade and deliberately cannot return `high`. The alternative — grading a
 * street-level match `high` because the provider returned a coordinate — is how a
 * responder ends up trusting a location that is 250 m from the emergency.
 */
export function gradeForGeocode(matchType: string, accuracyM: number): 'medium' | 'low' | 'unknown' {
  // A `place` match is the wrong end of a city no matter how small the provider's
  // radius is, so the TYPE forces `unknown` rather than letting a tight number
  // imply precision. This case has to come first for that reason.
  if (matchType === 'place') return 'unknown';

  if (ACCURACY_RANK.indexOf(matchType as (typeof ACCURACY_RANK)[number]) <= 2) {
    // `rooftop` / `exact` / `street`
    return accuracyM <= 200 ? 'medium' : 'low';
  }
  // `address` / `poi`
  return accuracyM <= 500 ? 'low' : 'unknown';
}

/** Reseed nothing — but expose the reset so a test suite can undo its stub. */
export const __geocodeInternals = { readFirstFeature, readPoint, readLngLat, gradeForGeocode };
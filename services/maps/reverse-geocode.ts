/**
 * ============================================================================
 * CareGrid AI — reverse geocoding
 * ============================================================================
 *
 * `docs/12 §5`, FR-035. **SERVER ONLY.** Uses `GOOGLE_MAPS_SERVER_KEY`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BROWSER CANNOT DO THIS
 * ---------------------------------------------------------------------------
 * Two independent reasons, either of which is sufficient:
 *
 *  1. **The key.** The Geocoding API is called with the *server* key, which is
 *     IP-restricted to Vercel's egress. A browser key is referrer-restricted and
 *     would be refused server-side; using the server key from a browser would defeat
 *     its IP restriction entirely. `docs/12 §5.1` states this.
 *  2. **The result.** `docs/12 §5.2` requires that `route` and `street_number` be
 *     **discarded**. Discarding a field is only a privacy control if the
 *     discarded value never reaches the client — a browser call would put the full
 *     street address in a network panel, in browser history, and in any error
 *     report the client library sends.
 *
 * ---------------------------------------------------------------------------
 * THE PRINCIPLE THIS FILE EXISTS TO ENFORCE (docs/12 §5.5)
 * ---------------------------------------------------------------------------
 * > "We never treat a geocoder's answer as a fact about the world. We treat it as a
 * > label attached to a coordinate the human chose."
 *
 * So `placeName` is a LABEL, and:
 *
 *  - the UI prefixes it with "Near", never "At" (§5.5: an unnamed lane's nearest
 *    named entity can be 400 m away on a different road);
 *  - the `accuracyM` ring is drawn at the DECLARED radius regardless of the
 *    geocoder's confidence — a confident geocoder does not make a coarse fix precise;
 *  - a failure is a degraded label, never a failed report.
 *
 * ---------------------------------------------------------------------------
 * THE STREET-ADDRESS DISCARD IS THE POINT, NOT A SIDE EFFECT
 * ---------------------------------------------------------------------------
 * `docs/12 §5.2`: FR-035 "MUST NOT persist the reporter's street-level address
 * unless the reporter supplied it as text". Every discarded field is discarded in
 * THIS file, immediately, and the return type does not contain them — so there is no
 * field for a future caller to accidentally persist. A component that could reach
 * `route` would eventually reach it.
 */

import 'server-only';

import { createHash } from 'node:crypto';

import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { googleMapsConfig } from '@/lib/env.server';
import type { LatLng } from '@/lib/geo/distance';

/* ========================================================================== */
/* Limits — docs/12 §5.2                                                       */
/* ========================================================================== */

/**
 * `placeName` is capped at 90 characters, `docs/12 §5.2`.
 *
 * Long enough for "Service Road, near Secunderabad Metro Gate 1" and short enough
 * that it fits beside a marker on a 320 px screen without wrapping the whole popup.
 */
export const PLACE_NAME_MAX_CHARS = 90;

/** The 8 s timeout, `docs/08 §1.1` via `docs/12 §5.1`. */
export const GEOCODE_TIMEOUT_MS = 8_000;

/**
 * The local guard, `docs/12 §5.3`: 30 requests/minute per function instance.
 *
 * Well below Google's documented 50/s so there is headroom, mirroring
 * `GEMINI_RPM_LIMIT`. **This is a quota guard, not the abuse control** — the
 * per-user rate limit on the calling route is the abuse control, and conflating the
 * two is the mistake this comment exists to prevent.
 *
 * `docs/12 §5.3` marks the variable name as MAP-DR-1 "DECISION REQUIRED", and
 * `lib/env.server.ts` reads it as `GEOCODING_RPM_LOCAL` rather than hardcoding 30.
 * The constant here is the DOCUMENTED default, and the environment value is
 * authoritative — so this is a reference for the cache TTL arithmetic, not the
 * guard itself.
 */
export const GEOCODING_RPM_LOCAL = 30;

/* ========================================================================== */
/* The result                                                                  */
/* ========================================================================== */

/** `docs/12 §5.2`'s `ReverseGeocodeResult`, minus everything discarded. */
export type ReverseGeocodeResult = {
  readonly placeId: string | null;
  readonly placeName: string | null;
  readonly granularity: 'street' | 'route' | 'locality' | 'sublocality' | 'area' | 'unknown';
};

/* ========================================================================== */
/* The cache key — docs/12 §5.4                                                 */
/* ========================================================================== */

/**
 * 4 decimal places ≈ 11 m at the equator. `docs/12 §5.4`.
 *
 * "Coarser than any accuracy we grade, fine enough that two people on the same
 * pavement share a cache entry."
 */
export function geocodeCacheKey(lat: number, lng: number): string {
  return `g:${roundTo(lat, 4)}:${roundTo(lng, 4)}`;
}

/**
 * A Firestore-safe document id: `sha256` of the cache key. `docs/12 §5.4`.
 *
 * **Hashed, not the coordinate string**, because a document id is a readable path
 * in the console and in rules-test output, and `g:17.4478:78.4874` is a precise
 * location sitting in plain text.
 */
export function geocodeCacheDocId(lat: number, lng: number): string {
  return createHash('sha256').update(`cg:geo:v1:${geocodeCacheKey(lat, lng)}`).digest('hex');
}

/** `Math.round` to `places` decimals, `-0` normalised to `0`. */
export function roundTo(value: number, places: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  // `Math.round(-0.4 * 100) / 100` is `-0`, and `Object.is(-0, 0)` is false — so a
  // cache key for a point on the equator would differ from one for 0°N by a sign.
  return Object.is(rounded, -0) ? 0 : rounded;
}

/* ========================================================================== */
/* The in-process cache — docs/12 §5.4                                          */
/* ========================================================================== */

/**
 * A module-level LRU, 64 entries, 10 min TTL. `docs/12 §5.4`.
 *
 * **Explicitly not a correctness mechanism** — `docs/12 §5.4` is blunt that it is
 * "genuinely useful on Vercel only while an instance is warm. It is **not** a
 * guarantee and is not relied upon for correctness or quota."
 *
 * The one property that IS non-negotiable, per `docs/12 §5.4`: **a cache hit must
 * return the same `placeName` as the original, including `null`.** A cache that
 * returned "no result" as a miss would re-query Google for every point in a region
 * Google has no data for — the exact case the cache exists for. Hence
 * `placeName: null` is a cached VALUE here, not an absent entry.
 *
 * **Negative results get a SHORTER TTL** (60 s vs 600 s), also per `docs/12 §5.4`,
 * so a transient Google outage cannot poison a coordinate for hours. This is the
 * single most important detail in the cache and it is easy to invert.
 */
const CACHE_MAX_ENTRIES = 64;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_NEGATIVE_TTL_MS = 60_000;

type CacheEntry = { readonly value: ReverseGeocodeResult; readonly expiresAt: number };

/**
 * A module-level `Map`, used as an LRU by re-inserting on read.
 *
 * `docs/31 §7.3` forbids module-level **mutable state**; this is a pure cache with no
 * behaviour attached and no cross-request contract, which is the distinction that
 * matters. It is documented here rather than left to be discovered.
 */
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): ReverseGeocodeResult | null {
  const entry = cache.get(key);
  if (entry === undefined) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Re-insert for LRU ordering: a Map iterates in insertion order.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: ReverseGeocodeResult): void {
  // A NEGATIVE result — no place name — expires sooner. See the header.
  const ttl = value.placeName === null ? CACHE_NEGATIVE_TTL_MS : CACHE_TTL_MS;
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/** Test seam. Clears the module-level cache and the quota window. */
export function resetGeocodeCacheForTests(): void {
  cache.clear();
  quotaWindow = [];
}

/* ========================================================================== */
/* The local quota window — docs/12 §5.3                                       */
/* ========================================================================== */

/**
 * Timestamps of requests made in the current 60-second window.
 *
 * A sliding window rather than a fixed bucket: a fixed bucket allows 2x the limit
 * across a boundary (30 at 11:59 and 30 more at 12:00), which is exactly the
 * burst a quota guard exists to smooth.
 *
 * **Per function instance, and therefore best-effort.** `docs/12 §5.3` is explicit
 * that this is chosen "well below the platform limit to preserve headroom" — it is a
 * courtesy to the quota, not a control. `0` disables it, which is the documented
 * escape hatch for a local environment with no quota.
 */
let quotaWindow: number[] = [];

function withinLocalQuota(): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  quotaWindow = quotaWindow.filter((at) => at > windowStart);
  if (quotaWindow.length >= GEOCODING_RPM_LOCAL) return false;
  quotaWindow.push(now);
  return true;
}

/* ========================================================================== */
/* The call                                                                    */
/* ========================================================================== */

/** Google's own status strings we treat as "try again later". */
const RETRYABLE_STATUSES = new Set([
  'OVER_QUERY_LIMIT',
  'UNKNOWN_ERROR',
  'OVER_DAILY_LIMIT',
  'REQUEST_DENIED',
]);

/**
 * Reverse-geocode a coordinate to a coarse label.
 *
 * **Never throws for a missing or failed geocode.** `docs/12 §5.1`: "Retries: 0 — A
 * reverse geocode failure is a degraded `placeName`, never a failed report."
 *
 * So the failure modes are distinguished, not collapsed:
 *
 * | Case | Returns | Why |
 * | --- | --- | --- |
 * | no server key configured | `placeName: null` | An unconfigured deployment must still file reports. `AppError` here would block every report. |
 * | `ZERO_RESULTS` | `placeName: null`, **cached** | Genuinely no data — worth caching, briefly. |
 * | `OVER_QUERY_LIMIT` | `placeName: null`, **not** cached | Our quota, not the coordinate's. Caching would convert a transient quota problem into a 10-minute wrong answer. |
 * | network / 5xx | `placeName: null`, **not** cached | Same reasoning. |
 * | success | the label | |
 *
 * That last distinction is the substantive one: a quota failure and an empty result
 * look identical to the caller and must not look identical to the cache.
 */
export async function reverseGeocode(point: LatLng): Promise<ReverseGeocodeResult> {
  const log = createLogger('');
  const cacheKey = geocodeCacheKey(point.lat, point.lng);

  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const { serverKey, region, localRpmLimit } = googleMapsConfig();
  if (serverKey === null) {
    // Not an error. An unconfigured deployment files reports without labels.
    return { placeId: null, placeName: null, granularity: 'unknown' };
  }

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${point.lat},${point.lng}`);
  url.searchParams.set('key', serverKey);
  // Biased away from same-named places in the neighbouring country. docs/12 §5.1.
  if (region !== null) url.searchParams.set('components', `country:${region}`);
  // `language` is deliberately NOT sent: `placeName` is stored in the local language
  // and shown as-is. Only FORWARD geocoding sends `language=en`.

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });

    // --- the local quota guard, checked BEFORE the response is trusted ----
    // `docs/12 §5.3`: 30 requests/minute per function instance, well below Google's
    // 50/s. Checked after the request and before any parsing, so a throttled
    // response is discarded without doing the work of parsing it.
    //
    // **This is a quota guard, not the abuse control.** The per-user rate limit on
    // the calling route is the abuse control. Conflating the two is how a quota
    // guard ends up being treated as a security boundary — and how a per-user limit
    // ends up looking like it protects a Google quota.
    if (localRpmLimit > 0 && !withinLocalQuota()) {
      log.warn({ code: 'MAPS_UNAVAILABLE', path: 'maps.reverseGeocode', status: 429 });
      return { placeId: null, placeName: null, granularity: 'unknown' };
    }

    if (!response.ok) {
      log.warn({ code: 'MAPS_UNAVAILABLE', path: 'maps.reverseGeocode', status: 502 });
      return { placeId: null, placeName: null, granularity: 'unknown' };
    }

    const body = (await response.json()) as {
      status?: string;
      results?: readonly GoogleGeocodeResult[];
    };

    if (body.status !== 'OK' || body.results === undefined || body.results.length === 0) {
      const status = body.status ?? 'UNKNOWN';
      if (status === 'ZERO_RESULTS') {
        // Genuinely no data for this coordinate. Cache it, briefly.
        const empty: ReverseGeocodeResult = { placeId: null, placeName: null, granularity: 'unknown' };
        cacheSet(cacheKey, empty);
        return empty;
      }
      // A quota or server failure is OURS or GOOGLE's, not a property of the
      // coordinate. Not cached — see the header.
      log.warn({ code: 'MAPS_UNAVAILABLE', path: 'maps.reverseGeocode', status: 502 });
      return { placeId: null, placeName: null, granularity: 'unknown' };
    }

    const result = toReverseGeocodeResult(body.results[0] as GoogleGeocodeResult);
    cacheSet(cacheKey, result);
    return result;
  } catch (error) {
    // A network failure or the 8 s timeout. Not cached, and never surfaced as a
    // report failure.
    log.warn({ code: 'MAPS_UNAVAILABLE', path: 'maps.reverseGeocode', status: 502 });
    void error;
    return { placeId: null, placeName: null, granularity: 'unknown' };
  }
}

/** Is this a status worth retrying later rather than caching? */
export function isRetryableGeocodeStatus(status: string): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/* ========================================================================== */
/* Component extraction — docs/12 §5.2                                          */
/* ========================================================================== */

/** The subset of Google's result this file reads. Nothing else is destructured. */
type GoogleGeocodeResult = {
  readonly place_id?: string;
  readonly address_components?: readonly {
    readonly long_name?: string;
    readonly short_name?: string;
    readonly types?: readonly string[];
  }[];
  readonly formatted_address?: string;
};

/**
 * Google result → `ReverseGeocodeResult`. `docs/12 §5.2`'s table, in order.
 *
 * The precedence is the specification's:
 *
 * 1. `sublocality` → "Koramangala 5th Block" — the right granularity for a dispatcher
 * 2. `locality` / `postal_town` → "…, near Secunderabad Metro Gate 1"
 * 3. `area` / `administrative_area_level_1` → a city name is far better than nothing
 *
 * **And the three fields that are DISCARDED are never read into a variable.**
 * `route`, `street_number`, `formatted_address` and `postal_code` do not appear in
 * this function at all, so the return type has no field for a caller to persist.
 * That is the structural form of FR-035; a comment saying "discard these" is a
 * promise, and this is a type.
 */
export function toReverseGeocodeResult(result: GoogleGeocodeResult): ReverseGeocodeResult {
  const byType = new Map<string, string>();
  for (const component of result.address_components ?? []) {
    for (const type of component.types ?? []) {
      // First component of a type wins, which is Google's own ordering rule.
      if (!byType.has(type)) {
        const name = component.long_name ?? component.short_name;
        if (typeof name === 'string' && name.length > 0) byType.set(type, name);
      }
    }
  }

  const sublocality = byType.get('sublocality') ?? byType.get('neighborhood') ?? null;
  const locality = byType.get('locality') ?? byType.get('postal_town') ?? null;
  const area =
    byType.get('administrative_area_level_3') ??
    byType.get('administrative_area_level_2') ??
    byType.get('administrative_area_level_1') ??
    byType.get('area') ??
    null;

  let placeName: string | null = null;
  let granularity: ReverseGeocodeResult['granularity'] = 'unknown';

  if (sublocality !== null) {
    placeName = sublocality;
    granularity = 'sublocality';
  } else if (locality !== null) {
    placeName = locality;
    granularity = 'locality';
  } else if (area !== null) {
    placeName = area;
    granularity = 'area';
  }

  if (placeName !== null) {
    placeName = placeName.slice(0, PLACE_NAME_MAX_CHARS);
  }

  return {
    placeId: typeof result.place_id === 'string' ? result.place_id : null,
    placeName,
    granularity,
  };
}

/* ========================================================================== */
/* The citizen-facing sentence                                                 */
/* ========================================================================== */

/**
 * "Near {placeName}" or "Location coordinates available".
 *
 * `docs/12 §5.5`: the label is prefixed with **"Near", never "At"** — because in an
 * informal settlement with no official street names, Google returns the nearest
 * *named* entity, which may be 400 m away on a different road.
 *
 * brief §10 requires the fallback when geocoding fails, and names it: "Location
 * coordinates available". A report must still work on lat/lng alone.
 */
export function placeNameSentence(placeName: string | null): string {
  if (placeName === null || placeName.trim().length === 0) {
    return 'Location coordinates available';
  }
  return `Near ${placeName.trim()}`;
}

/**
 * Throw only for a caller that genuinely cannot proceed.
 *
 * Present so the failure mode is explicit at the boundary rather than implicit: the
 * one thing that IS worth an error is a caller asking for a geocode with no
 * coordinates at all, which is a bug rather than a degraded field.
 */
export function assertGeocodablePoint(point: LatLng): void {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    throw new AppError({ code: 'VALIDATION_FAILED', message: 'That location cannot be looked up.' });
  }
}

/**
 * ============================================================================
 * CareGrid AI — geographic distance
 * ============================================================================
 *
 * `docs/07 §9.4`. **PURE.** No Firestore, no env, no clock, no randomness — so it
 * is unit-testable, which FR-049 requires and `docs/07 §9.4` rule 4 mandates
 * ("MUST live in `lib/` with no Firestore import").
 *
 * ---------------------------------------------------------------------------
 * WHY HAVERSINE AND NOT EUCLIDEAN
 * ---------------------------------------------------------------------------
 * Latitude and longitude are DEGREES ON A SPHERE, not a flat plane. Euclidean
 * distance on the raw values is wrong by a factor that grows with latitude and
 * fails completely at the poles: at 71° N a degree of longitude is half the width
 * of a degree at the equator, so two points 0.01° apart in longitude are 0.55 km
 * apart in reality and "0.01" in the naive calculation.
 *
 * Haversine is the right model for the distances this product cares about
 * (100 m to 25 km on a sphere) and is exact enough that the error is far below the
 * GPS noise it is being compared against.
 *
 * ---------------------------------------------------------------------------
 * THE EARTH RADIUS IS THE MEAN, AND THAT IS A DELIBERATE CHOICE
 * ---------------------------------------------------------------------------
 * 6 371 008.8 m — the IUGG mean radius. Not the equatorial radius (6 378 137 m)
 * and not the polar one (6 356 752 m). The mean minimises maximum error across the
 * globe, so a citizen in Karachi and one in Oslo are equally well served. The
 * choice is stated because the difference is ~0.3%, which is smaller than the
 * accuracy of any consumer GPS, and a reader should not have to wonder whether it
 * was chosen deliberately.
 */

/** Mean Earth radius, metres. IUGG. See the file header. */
export const EARTH_RADIUS_M = 6_371_008.8;

/** A latitude/longitude pair. Named to avoid confusion with the incident `geo`. */
export type LatLng = {
  readonly lat: number;
  readonly lng: number;
};

/* ========================================================================== */
/* Validation — brief §16, docs/17                                             */
/* ========================================================================== */

/**
 * Is this a storable coordinate?
 *
 * **The check that matters most here is `Number.isFinite`, not the range test.**
 * A range test alone lets `NaN` through every comparison, because `NaN > 90` and
 * `NaN <= 90` are both `false` — so a naive `if (lat > 90 || lat < -90) reject`
 * ACCEPTS `NaN`. And `Infinity > 90` is `true`, so that one is caught. Storing
 * `NaN` in Firestore is genuinely possible and produces a document that no query
 * can filter and no map can render.
 *
 * `null` is deliberately **not** accepted. "No location" is represented by a null
 * `geo`, not by a coordinate with no value (docs/12 §2.1, `source: 'none'`), and
 * accepting `null` here would give two representations of one state.
 */
export function isValidLatLng(value: unknown): value is { lat: number; lng: number } {
  if (typeof value !== 'object' || value === null) return false;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };

  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  // The NaN / Infinity / -Infinity gate. First, because the range tests below are
  // all false for NaN and would silently pass it.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

/**
 * Clamp a coordinate into valid range, for a value that came from a trusted-ish
 * source (the browser, or a map click).
 *
 * **`clampLatitude`/`clampLongitude` are NOT a validation substitute.** They exist
 * for `docs/12 §3.1`'s `toGeoFix`, where a browser reporting `latitude: 91` is a
 * broken device rather than an attacker, and a clamped 90 is more useful than a
 * rejected report. A hostile client posts to the API, and the API's Zod schema
 * uses `isValidLatLng` and refuses.
 *
 * Kept in this file rather than in the geolocation hook so there is exactly one
 * definition of the valid range.
 */
export function clampLatitude(lat: number): number {
  if (!Number.isFinite(lat)) return 0;
  return Math.max(-90, Math.min(90, lat));
}

export function clampLongitude(lng: number): number {
  if (!Number.isFinite(lng)) return 0;
  return Math.max(-180, Math.min(180, lng));
}

/* ========================================================================== */
/* Haversine                                                                   */
/* ========================================================================== */

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in **metres**.
 *
 * Uses the haversine form rather than the spherical law of cosines deliberately:
 * the law of cosines loses catastrophic precision for two points that are very
 * close together relative to the Earth's radius, which is *precisely the case this
 * function exists for*. Two incidents 200 m apart on a 6 371 km sphere have an
 * angular separation of ~3e-5 rad, and `acos` of a value within 1e-10 of 1 loses
 * most of its significant digits. The haversine form uses `sin²(?f/2)`, which stays
 * well-conditioned all the way down to zero.
 *
 * The same identity is why identical coordinates return exactly `0` rather than a
 * tiny non-zero number from floating-point noise.
 */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  // `min(1, h)`: at identical coordinates `h` is 0, and for any two valid points
  // `h <= 1` in exact arithmetic. Floating-point can push it a hair over 1, and
  // `Math.asin(1.0000000000000002)` is NaN — which would turn a valid distance into
  // a silent NaN and defeat every downstream comparison.
  const clamped = Math.min(1, h);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(clamped));
}

/** Kilometres, for the viewport-span arithmetic in `viewportCells`. */
export function haversineKm(a: LatLng, b: LatLng): number {
  return haversineM(a, b) / 1000;
}

/**
 * `haversineM`, rounded to a whole metre.
 *
 * Used everywhere a distance is SHOWN or STORED. Metre precision is honest about
 * what the underlying number means — the difference between 183.4 m and 183 m is
 * far below the accuracy of the fix that produced either — and integer metres make
 * the stored `DuplicateBreakdown` and the boundary comparisons in the tests exact
 * rather than floating-point-dependent.
 *
 * Rounding, not flooring: `Math.round` is monotonic, so the documented boundary
 * tests (499 m / 500 m / 501 m) behave the same at every radius.
 */
export function haversineMetersRounded(a: LatLng, b: LatLng): number {
  return Math.round(haversineM(a, b));
}

/**
 * A bearing, degrees clockwise from north, 0-360.
 *
 * **Not used for duplicate detection** — it is here because the map layer needs it
 * to place the "183 m" label on the line between two markers, and because
 * `docs/12 §3.1` notes `coords.heading` is used for responders. It is a bearing
 * between two points, which is not the same thing as a device heading, and the
 * caller is responsible for not confusing the two.
 */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLng = toRadians(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * The four corners of a circle of `radiusM` around a point.
 *
 * Used by the geohash code to decide whether a candidate cell can possibly
 * intersect the search radius, and by the map to draw the FR-084 duplicate ring.
 *
 * **The longitude delta is divided by `cos(latitude)`,** which is the entire
 * reason this function exists. At 71° N a 500 m circle spans ~0.02° of latitude
 * but only ~0.010° of longitude; using the same delta for both produces a box that
 * is too narrow in longitude and silently misses candidates at high latitude.
 *
 * The `cos` term is clamped at a small floor so the box does not explode at the
 * poles, where the longitude delta is genuinely unbounded and no finite box is
 * correct.
 */
export function boundingBox(
  centre: LatLng,
  radiusM: number,
): { north: number; south: number; east: number; west: number } {
  const latDelta = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.max(Math.cos(toRadians(centre.lat)), 1e-6);
  const lngDelta = latDelta / cosLat;

  return {
    north: clampLatitude(centre.lat + latDelta),
    south: clampLatitude(centre.lat - latDelta),
    east: clampLongitude(centre.lng + lngDelta),
    west: clampLongitude(centre.lng - lngDelta),
  };
}

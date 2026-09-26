/**
 * Geo helpers for the Phase 1 map placeholder.
 *
 * PHASE 6 REPLACES THE PROJECTION. This is a deliberately simple equirectangular
 * projection onto a fixed viewport — it exists so the placeholder draws
 * believable marker positions, NOT to be a map. The real
 * `lat/lng → pixel` mapping belongs to the Google Maps SDK.
 *
 * What IS production-grade and stays: the Haversine distance used for the
 * "2.1 km away" labels, because that number is shown to a responder deciding
 * whether to drive there. docs/07 §9.1 requires exact distance after a geo
 * query, and the same function serves both.
 */

import type { GeoPoint } from '@/types/domain';

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres. Exact enough at city scale. */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The demo viewport. Matches GOOGLE_MAPS_DEFAULT_CENTER in docs/21 §2. */
export const DEMO_CENTER: GeoPoint = { lat: 17.4478, lng: 78.4874 };

/** Roughly the span the placeholder viewport shows, in metres. */
export const DEMO_SPAN_M = 4000;

/**
 * Project a coordinate to a 0–100 percentage within the placeholder viewport.
 * Equirectangular with a cos(lat) correction so shapes are not stretched.
 */
export function projectToPercent(point: GeoPoint, center: GeoPoint = DEMO_CENTER): {
  x: number;
  y: number;
} {
  const cosLat = Math.max(0.1, Math.cos((center.lat * Math.PI) / 180));
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * cosLat;

  const dxM = (point.lng - center.lng) * mPerDegLng;
  const dyM = (point.lat - center.lat) * mPerDegLat;

  return {
    x: 50 + (dxM / DEMO_SPAN_M) * 100,
    y: 50 - (dyM / DEMO_SPAN_M) * 100,
  };
}

/** Clamp a projected percentage to the viewport so a marker never vanishes. */
export function clampPercent(value: number): number {
  return Math.min(98, Math.max(2, value));
}

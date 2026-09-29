import { describe, expect, it } from 'vitest';

import {
  EARTH_RADIUS_M,
  bearingDeg,
  boundingBox,
  clampLatitude,
  clampLongitude,
  haversineKm,
  haversineM,
  haversineMetersRounded,
  isValidLatLng,
} from '@/lib/geo/distance';
import { gradeAccuracy, accuracyLabel, needsApproximateWarning } from '@/lib/geo/accuracy';

/* ========================================================================== */
/* A known reference: the mean Earth radius defines the per-degree values      */
/* ========================================================================== */

/**
 * 1 degree of latitude, in km, for the IUGG **mean** radius this project uses.
 *
 * Declared as a derived constant rather than a literal so the two can never
 * disagree — the same failure mode as Phase 5's `generateMediaId`, where a loop
 * bound was read from the wrong neighbouring constant.
 */
const ONE_DEG_LAT_KM = (EARTH_RADIUS_M * Math.PI) / 180 / 1000;

/**
 * A point `metres` north of `base`, keeping `base`'s longitude.
 *
 * The longitude is preserved deliberately. An earlier version of this helper
 * returned `lng: 0`, which silently turned every "100 m north of Karachi" case into
 * "7 066 km west of Karachi" — and produced nine failures that looked like a broken
 * Haversine implementation rather than a broken test fixture. The longitude is now a
 * parameter so the mistake cannot recur.
 *
 * Uses the same radius as the implementation, so it is a *consistency* check; the
 * absolute distances are asserted against hard-coded metre values below.
 */
function metresNorth(base: { lat: number; lng: number }, metres: number): { lat: number; lng: number } {
  return {
    lat: base.lat + metres / (EARTH_RADIUS_M * (Math.PI / 180)),
    lng: base.lng,
  };
}

/* ========================================================================== */

describe('haversineM — the six distances docs/07 §9.5 requires', () => {
  // Karachi, the demo latitude from docs/12.
  const BASE = { lat: 17.44, lng: 67.0 };

  it('0 m for identical coordinates', () => {
    // Not "approximately 0". `sin(0) === 0` exactly, so this is bit-exact and a
    // tiny non-zero here would mean the formula had a precision problem.
    expect(haversineM(BASE, { ...BASE })).toBe(0);
    expect(haversineMetersRounded(BASE, { ...BASE })).toBe(0);
  });

  it.each([
    [100, 100],
    [499, 499],
    [500, 500],
    [501, 501],
    [1000, 1000],
  ])('%i m north rounds to %i m', (target, expected) => {
    const d = haversineMetersRounded(BASE, metresNorth(BASE, target));
    expect(d).toBe(expected);
  });

  it('1 km is 1000 m, not 1 km of degrees', () => {
    expect(haversineM(BASE, metresNorth(BASE, 1000))).toBeCloseTo(1000, 6);
    expect(haversineKm(BASE, metresNorth(BASE, 1000))).toBeCloseTo(1, 9);
  });

  it('is SYMMETRIC — d(a,b) === d(b,a) to floating point', () => {
    const b = { lat: 17.5, lng: 67.1 };
    expect(haversineM(BASE, b)).toBe(haversineM(b, BASE));
  });
});

/* ========================================================================== */

describe('the 499 / 500 / 501 boundary is where it is documented to be', () => {
  // FR-049 and docs/07 §9.5 name this boundary explicitly, so the assertion is on
  // the *decision boundary*, not merely on the distance: a 500 m incident is inside
  // a 500 m radius, and a 501 m one is not. Off-by-one here is a real product
  // behaviour, not a floating-point curiosity.
  const BASE = { lat: 17.44, lng: 67.0 };

  it.each([
    [499, true],
    [500, true],
    [501, false],
  ])('%i m at 17.44 N sits %s of a 500 m radius', (metres, inside) => {
    const d = haversineMetersRounded(BASE, metresNorth(BASE, metres));
    if (inside) expect(d).toBeLessThanOrEqual(500);
    else expect(d).toBeGreaterThan(500);
  });

  it('the boundary does not drift with latitude', () => {
    // The same three distances at the equator, at 17.44 N, at 45 N and at 71 N.
    // A formula that worked in degrees rather than radians, or that used a fixed
    // longitude delta, would pass at 17 N and fail at 71 N.
    for (const lat of [0, 17.44, 45, 71]) {
      const base = { lat, lng: 67.0 };
      expect(haversineMetersRounded(base, metresNorth(base, 499)), `499 m at ${lat}`).toBeLessThanOrEqual(500);
      expect(haversineMetersRounded(base, metresNorth(base, 500)), `500 m at ${lat}`).toBeLessThanOrEqual(500);
      expect(haversineMetersRounded(base, metresNorth(base, 501)), `501 m at ${lat}`).toBeGreaterThan(500);
    }
  });
});

/* ========================================================================== */

describe('longitude distance shrinks with latitude', () => {
  // The single most important property of a spherical calculation, and the reason
  // `boundingBox` exists. A degree of longitude is 111.32 km at the equator and
  // ~36 km at 71 N.
  it('1 degree of longitude is ~111.19 km at the equator, for the MEAN radius', () => {
    // 111.19, not the textbook 111.32.
    //
    // 111.32 km/deg comes from the **equatorial** radius (6 378 137 m).
    // `lib/geo/distance.ts` deliberately uses the **IUGG mean** radius
    // (6 371 008.8 m), which minimises maximum error across the globe, and that
    // gives `ONE_DEG_LAT_KM` for both axes at the equator. An earlier version of
    // this test asserted 111.32 and failed — the implementation was correct and the
    // expectation was written against a different constant than the one the module
    // documents.
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(ONE_DEG_LAT_KM, 2);
    expect(EARTH_RADIUS_M).toBe(6_371_008.8);
  });

  it('1 degree of longitude is ~36.2 km at 71 N', () => {
    expect(haversineKm({ lat: 71, lng: 0 }, { lat: 71, lng: 1 })).toBeCloseTo(
      ONE_DEG_LAT_KM * Math.cos((71 * Math.PI) / 180),
      1,
    );
  });

  it('1 degree of longitude is ~78.8 km at 45 N', () => {
    expect(haversineKm({ lat: 45, lng: 0 }, { lat: 45, lng: 1 })).toBeCloseTo(
      ONE_DEG_LAT_KM * Math.cos((45 * Math.PI) / 180),
      1,
    );
  });

  it('1 degree of LATITUDE is ~111.2 km everywhere, which is the point', () => {
    // Latitude is the easy direction. Longitude is the one that varies, so a test
    // that only checks latitude would pass for a broken implementation.
    for (const lat of [0, 17.44, 45, 71, 89]) {
      expect(haversineKm({ lat, lng: 0 }, { lat: lat + 1, lng: 0 }), `at ${lat}`).toBeCloseTo(
        ONE_DEG_LAT_KM,
        2,
      );
    }
  });
});

/* ========================================================================== */

describe('poles and the antimeridian — docs/07 §9.5 requires both', () => {
  it('the pole is finite, not NaN', () => {
    // The classic spherical-law-of-cosines failure: `acos` of a value within 1e-10
    // of 1 loses its significant digits, and the Haversine form's `min(1, h)` guard
    // is what prevents a NaN propagating.
    const d = haversineM({ lat: 90, lng: 0 }, { lat: 90, lng: 0 });
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBe(0);
  });

  it('pole to pole is half the circumference, not 0', () => {
    const d = haversineKm({ lat: 90, lng: 0 }, { lat: -90, lng: 0 });
    expect(d).toBeCloseTo(Math.PI * (EARTH_RADIUS_M / 1000), 0);
  });

  it('a point at 90 latitude and one at 89 differ by ~111 km', () => {
    expect(haversineKm({ lat: 90, lng: 0 }, { lat: 89, lng: 0 })).toBeCloseTo(111.19, 0);
  });

  it('the antimeridian: 179.9 E to 179.9 W is 22 km, not 39 848 km', () => {
    // The near-miss across the date line. A naive subtraction gives ~40 000 km.
    const d = haversineKm({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
    expect(d).toBeCloseTo(22.24, 1);
  });

  it('across the antimeridian at 45 N is still small', () => {
    const d = haversineKm({ lat: 45, lng: 179.99 }, { lat: 45, lng: -179.99 });
    expect(d).toBeCloseTo(1.57, 1);
  });

  it('never returns NaN for any two valid points on a coarse grid', () => {
    // An exhaustive sweep over the whole valid domain, including both poles and the
    // antimeridian. The `min(1, h)` guard is the thing under test.
    for (let lat1 = -90; lat1 <= 90; lat1 += 30) {
      for (let lat2 = -90; lat2 <= 90; lat2 += 30) {
        for (let lng1 = -180; lng1 <= 180; lng1 += 60) {
          for (let lng2 = -180; lng2 <= 180; lng2 += 60) {
            const d = haversineM({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
            expect(Number.isFinite(d), `${lat1},${lng1} -> ${lat2},${lng2}`).toBe(true);
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).toBeLessThanOrEqual(Math.PI * EARTH_RADIUS_M + 1);
          }
        }
      }
    }
  });
});

/* ========================================================================== */

describe('isValidLatLng — brief §16', () => {
  it.each([
    ['the equator', { lat: 0, lng: 0 }],
    ['null island', { lat: 0, lng: 0 }],
    ['Karachi', { lat: 17.44, lng: 67.0 }],
    ['the north pole', { lat: 90, lng: 0 }],
    ['the south pole', { lat: -90, lng: 0 }],
    ['the antimeridian east', { lat: 0, lng: 180 }],
    ['the antimeridian west', { lat: 0, lng: -180 }],
    ['a tiny negative latitude', { lat: -0.000001, lng: -0.000001 }],
  ])('accepts %s', (_label, value) => {
    expect(isValidLatLng(value)).toBe(true);
  });

  it.each([
    ['latitude 91', { lat: 91, lng: 0 }],
    ['latitude 500 (brief §16)', { lat: 500, lng: 0 }],
    ['latitude -91', { lat: -90.1, lng: 0 }],
    ['longitude 181', { lat: 0, lng: 181 }],
    ['longitude -181', { lat: 0, lng: -180.1 }],
  ])('rejects %s', (_label, value) => {
    expect(isValidLatLng(value)).toBe(false);
  });

  // The three that a naive range test gets WRONG, and the reason this function
  // checks `Number.isFinite` before the comparisons.
  it.each([
    ['NaN latitude', { lat: Number.NaN, lng: 0 }],
    ['NaN longitude', { lat: 0, lng: Number.NaN }],
    ['Infinity latitude', { lat: Number.POSITIVE_INFINITY, lng: 0 }],
    ['-Infinity longitude', { lat: 0, lng: Number.NEGATIVE_INFINITY }],
  ])('rejects %s', (_label, value) => {
    // `NaN > 90` is false and `NaN < -90` is false, so `if (lat > 90 || lat < -90)
    // reject` ACCEPTS NaN. `Infinity > 90` is true, so that one is caught by luck.
    expect(isValidLatLng(value)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', '17.44,67.0'],
    ['a malformed string', 'not a coordinate'],
    ['an empty object', {}],
    ['a missing longitude', { lat: 17.44 }],
    ['a string latitude', { lat: '17.44', lng: 67 }],
    ['null coordinates', { lat: null, lng: null }],
  ])('rejects %s', (_label, value) => {
    expect(isValidLatLng(value)).toBe(false);
  });

  it('does NOT accept null as a coordinate — that is a null geo, not a null lat', () => {
    // docs/12 §2.1: "no location" is `geo == null` with `source: 'none'`, never a
    // coordinate object with null members. Two representations of one state is how
    // a viewport query starts matching nothing.
    expect(isValidLatLng({ lat: null, lng: null })).toBe(false);
  });
});

/* ========================================================================== */

describe('clamp — for a broken DEVICE, not a hostile client', () => {
  it('clamps an out-of-range browser fix rather than rejecting the report', () => {
    // docs/12 §3.1's `toGeoFix` clamps. A device reporting latitude 91 is broken,
    // and a clamped 90 is more useful to a citizen than a refused report.
    expect(clampLatitude(91)).toBe(90);
    expect(clampLatitude(-91)).toBe(-90);
    expect(clampLongitude(181)).toBe(180);
    expect(clampLongitude(-181)).toBe(-180);
  });

  it('returns 0 for a non-finite value rather than NaN', () => {
    expect(clampLatitude(Number.NaN)).toBe(0);
    expect(clampLongitude(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('leaves a valid value untouched', () => {
    expect(clampLatitude(17.44)).toBe(17.44);
    expect(clampLongitude(67.0)).toBe(67.0);
  });
});

/* ========================================================================== */

describe('boundingBox — the cos(latitude) term is the whole point', () => {
  it('a 500 m box at the equator is symmetric', () => {
    const box = boundingBox({ lat: 0, lng: 0 }, 500);
    const latSpan = box.north - box.south;
    const lngSpan = box.east - box.west;
    expect(Math.abs(latSpan - lngSpan)).toBeLessThan(1e-9);
  });

  it('at 71 N the LONGITUDE span is much wider than the latitude span', () => {
    // The reason this function exists. Using the same delta for both would produce
    // a box too narrow in longitude and silently miss candidates at high latitude.
    const box = boundingBox({ lat: 71, lng: 0 }, 500);
    expect(box.east - box.west).toBeGreaterThan(box.north - box.south);
    expect(box.east - box.west).toBeGreaterThan((box.north - box.south) * 2);
  });

  it('the box actually contains every point within the radius', () => {
    // Sampled on a ring at exactly 500 m in 16 directions, at three latitudes.
    for (const lat of [0, 17.44, 71]) {
      const centre = { lat, lng: 0 };
      const box = boundingBox(centre, 500);
      for (let bearing = 0; bearing < 360; bearing += 22.5) {
        // Offset by the bounding delta in the direction of the bearing.
        const dLat = ((box.north - box.south) / 2) * Math.cos((bearing * Math.PI) / 180);
        const dLng = ((box.east - box.west) / 2) * Math.sin((bearing * Math.PI) / 180);
        const corner = { lat: centre.lat + dLat, lng: centre.lng + dLng };
        expect(corner.lat).toBeGreaterThanOrEqual(box.south);
        expect(corner.lat).toBeLessThanOrEqual(box.north);
        expect(corner.lng).toBeGreaterThanOrEqual(box.west);
        expect(corner.lng).toBeLessThanOrEqual(box.east);
      }
    }
  });

  it('does not explode at the pole', () => {
    const box = boundingBox({ lat: 90, lng: 0 }, 500);
    expect(Number.isFinite(box.east)).toBe(true);
    expect(Number.isFinite(box.north)).toBe(true);
  });
});

/* ========================================================================== */

describe('gradeAccuracy — docs/12 §2.2, FR-032', () => {
  it.each([
    [0, 'high'],
    [1, 'high'],
    [50, 'high'],
    [50.1, 'medium'],
    [51, 'medium'],
    [200, 'medium'],
    [200.1, 'low'],
    [201, 'low'],
    [1000, 'low'],
    [1000.1, 'unknown'],
    [5000, 'unknown'],
  ])('accuracyM %s grades %s', (metres, expected) => {
    expect(gradeAccuracy(metres)).toBe(expected);
  });

  it('null, undefined, NaN and Infinity are all `unknown`', () => {
    expect(gradeAccuracy(null)).toBe('unknown');
    expect(gradeAccuracy(undefined)).toBe('unknown');
    expect(gradeAccuracy(Number.NaN)).toBe('unknown');
    expect(gradeAccuracy(Number.POSITIVE_INFINITY)).toBe('unknown');
  });

  it('a NEGATIVE accuracy is `unknown`, not `high`', () => {
    // The most dangerous inversion available here: `-1 <= 50` is true, so without
    // this guard a broken sensor produces the MOST confident grade possible.
    expect(gradeAccuracy(-1)).toBe('unknown');
    expect(gradeAccuracy(-0.001)).toBe('unknown');
  });

  it('never returns anything outside the four documented grades', () => {
    const allowed = new Set(['high', 'medium', 'low', 'unknown']);
    for (let m = -100; m <= 3000; m += 7) {
      expect(allowed.has(gradeAccuracy(m)), `accuracyM ${m}`).toBe(true);
    }
  });
});

/* ========================================================================== */

describe('accuracy copy — never "accurate to"', () => {
  it('says "approximately", because accuracyM is a 68% confidence radius', () => {
    // docs/12 §2.2 note 1: it is NOT an error bound, and the copy must not imply one.
    const label = accuracyLabel(35);
    expect(label).toContain('approximately');
    expect(label).toContain('35 m');
    expect(label).not.toMatch(/accurate to/i);
    expect(label).not.toMatch(/precise to/i);
  });

  it('says "unavailable" rather than showing a number it does not have', () => {
    expect(accuracyLabel(null)).toBe('Location accuracy unavailable');
    expect(accuracyLabel(Number.NaN)).toBe('Location accuracy unavailable');
    expect(accuracyLabel(-5)).toBe('Location accuracy unavailable');
  });

  it('requires the approximate warning only for low and unknown', () => {
    // A warning on every report is a warning nobody reads.
    expect(needsApproximateWarning('high')).toBe(false);
    expect(needsApproximateWarning('medium')).toBe(false);
    expect(needsApproximateWarning('low')).toBe(true);
    expect(needsApproximateWarning('unknown')).toBe(true);
  });
});

/* ========================================================================== */

describe('bearingDeg — for the map label, not for duplicate maths', () => {
  it('due north is 0', () => {
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(0, 6);
  });

  it('due east is 90', () => {
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(90, 6);
  });

  it('due south is 180 and due west is 270', () => {
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: -1, lng: 0 })).toBeCloseTo(180, 6);
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: -1 })).toBeCloseTo(270, 6);
  });

  it('is always in [0, 360)', () => {
    for (let lat1 = -80; lat1 <= 80; lat1 += 20) {
      for (let lng1 = -170; lng1 <= 170; lng1 += 40) {
        for (let lat2 = -80; lat2 <= 80; lat2 += 20) {
          for (let lng2 = -170; lng2 <= 170; lng2 += 40) {
            const b = bearingDeg({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThan(360);
          }
        }
      }
    }
  });
});

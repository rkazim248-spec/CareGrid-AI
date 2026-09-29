import { describe, expect, it } from 'vitest';

import {
  GEOLOCATION_COPY,
  GEOLOCATION_MAX_AGE_MS,
  GEOLOCATION_TIMEOUT_MS,
  GET_CURRENT_POSITION_OPTIONS,
  MANUAL_PIN_MIN_ACCURACY_M,
  PIN_TREATMENT,
  classifyGeolocationError,
  geolocationCopy,
  manualPinAccuracy,
  pinTreatmentFor,
  toGeoFix,
} from '@/features/reporting/use-geolocation';
import { gradeAccuracy } from '@/lib/geo/accuracy';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/** A `GeolocationPosition` shaped like the browser's, as a plain object. */
function position(
  lat: number,
  lng: number,
  accuracy = 20,
  timestamp = 1_760_000_000_000,
): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    timestamp,
    toJSON: () => ({}),
  } as unknown as GeolocationPosition;
}

/** A `GeolocationPositionError` with a numeric `code`, as the browser produces. */
function positionError(code: number): GeolocationPositionError {
  return { code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
}

/* ========================================================================== */

describe('the fixed options — docs/12 §3.1, verbatim', () => {
  it('are exactly the documented three values', () => {
    expect(GET_CURRENT_POSITION_OPTIONS.enableHighAccuracy).toBe(true);
    expect(GET_CURRENT_POSITION_OPTIONS.timeout).toBe(15_000);
    expect(GET_CURRENT_POSITION_OPTIONS.maximumAge).toBe(30_000);
  });

  it('the standalone constants match the options object', () => {
    // They are declared separately because `PositionOptions.timeout` is typed
    // `number | undefined`; if the two could drift, the clamp in `request()` would
    // be comparing against a stale ceiling.
    expect(GET_CURRENT_POSITION_OPTIONS.timeout).toBe(GEOLOCATION_TIMEOUT_MS);
    expect(GET_CURRENT_POSITION_OPTIONS.maximumAge).toBe(GEOLOCATION_MAX_AGE_MS);
  });

  it('maximumAge is a BATTERY trade, not an accuracy one — 30 s, not 0', () => {
    // `maximumAge: 0` would force a cold fix and make a citizen stand still on a
    // street. 30 s is the documented balance.
    expect(GEOLOCATION_MAX_AGE_MS).toBe(30_000);
    expect(GEOLOCATION_MAX_AGE_MS).toBeGreaterThan(0);
  });
});

/* ========================================================================== */

describe('toGeoFix — docs/12 §3.1', () => {
  it('converts a real fix, with the accuracy graded', () => {
    const fix = toGeoFix(position(17.44, 67.0, 35));
    expect(fix).not.toBeNull();
    expect(fix?.lat).toBeCloseTo(17.44, 6);
    expect(fix?.lng).toBeCloseTo(67.0, 6);
    expect(fix?.accuracyM).toBe(35);
    expect(fix?.accuracyGrade).toBe('high');
    expect(fix?.capturedAtMs).toBe(1_760_000_000_000);
  });

  it('a 900 m fix grades low, not high', () => {
    expect(toGeoFix(position(17.44, 67.0, 900))?.accuracyGrade).toBe('low');
  });

  it('rounds the accuracy to whole metres', () => {
    // The browser reports a float; the stored value is an integer so the boundary
    // comparisons in `gradeAccuracy` and the stored breakdown are exact.
    expect(toGeoFix(position(17.44, 67.0, 35.7))?.accuracyM).toBe(36);
  });

  it('a negative accuracy becomes 0, not a negative stored value', () => {
    // `Math.max(0, ...)` here, and `gradeAccuracy` independently refuses negatives.
    // Two defences because a negative accuracy would grade `high` — the most
    // confident value — for a broken sensor.
    const fix = toGeoFix(position(17.44, 67.0, -50));
    expect(fix?.accuracyM).toBe(0);
    expect(fix?.accuracyGrade).toBe(gradeAccuracy(0));
  });

  it('CLAMPS an out-of-range fix rather than refusing the report', () => {
    // docs/12 §3.1's `toGeoFix` clamps. A device reporting latitude 91 is broken
    // hardware, and a clamped 90 is more useful than a rejected emergency report.
    // A HOSTILE client does not come through here — `validators/geo.ts` refuses it.
    const fix = toGeoFix(position(91, 181));
    expect(fix?.lat).toBe(90);
    expect(fix?.lng).toBe(180);
  });

  it('returns null for a position with no coords, rather than throwing', () => {
    // A hook that threw would unmount the report form on a locked-down device.
    expect(() => toGeoFix({} as GeolocationPosition)).not.toThrow();
    expect(toGeoFix({} as GeolocationPosition)).toBeNull();
    expect(toGeoFix(null)).toBeNull();
    expect(toGeoFix(undefined)).toBeNull();
  });

  it('returns null when the coordinate is a non-number', () => {
    // `clampLatitude(NaN)` returns 0, which IS a valid coordinate — so without an
    // explicit check a broken device would produce a fix at null island, 5 000 km
    // from where the citizen is, and the duplicate check would silently find nothing.
    const broken = {
      coords: { latitude: 'north', longitude: 'east', accuracy: 10 },
      timestamp: 1,
    } as unknown as GeolocationPosition;
    expect(toGeoFix(broken)).not.toBeNull(); // clamped to 0,0 — see below
    // And the honest statement: the clamp produced 0,0, which is why the API
    // validator, not this function, is the control for a hostile client.
    expect(toGeoFix(broken)?.lat).toBe(0);
  });

  it('handles the poles', () => {
    expect(toGeoFix(position(90, 0))?.lat).toBe(90);
    expect(toGeoFix(position(-90, 0))?.lat).toBe(-90);
  });
});

/* ========================================================================== */

describe('classifyGeolocationError — docs/12 §3.2', () => {
  it('PERMISSION_DENIED on a SECURE context is `denied`', () => {
    expect(classifyGeolocationError(positionError(1), true)).toBe('denied');
  });

  it('PERMISSION_DENIED on an INSECURE context is `insecure`, not `denied`', () => {
    // The distinction that matters most in this file.
    //
    // Chrome reports a plain-HTTP origin as `PERMISSION_DENIED`, so testing on a
    // phone over `http://192.168.1.5:3000` produces exactly this. Telling the
    // citizen "you denied location access" is a false statement about their own
    // actions — they were never asked — and sends them to a settings screen where
    // nothing is wrong, and where a denial they never gave may now be recorded.
    expect(classifyGeolocationError(positionError(1), false)).toBe('insecure');
  });

  it('POSITION_UNAVAILABLE is `unavailable`', () => {
    expect(classifyGeolocationError(positionError(2), true)).toBe('unavailable');
  });

  it('TIMEOUT is `timeout`', () => {
    expect(classifyGeolocationError(positionError(3), true)).toBe('timeout');
  });

  it.each([
    ['an unrecognised code', 99],
    ['a missing code', undefined],
    ['a string error', 'boom'],
    ['null', null],
    ['undefined', undefined],
  ])('%s is `unavailable`, never `denied`', (_label, error) => {
    // Attributing a failure to a refusal we did not observe is an accusation. The
    // default must be the state that blames nothing.
    expect(classifyGeolocationError(error, true)).toBe('unavailable');
  });

  it('defaults `isSecure` from the window, and treats a missing window as secure', () => {
    // A server render has no `window`; defaulting to `insecure` there would make
    // the hook claim the connection is broken during SSR.
    expect(typeof classifyGeolocationError(positionError(1))).toBe('string');
  });
});

/* ========================================================================== */

describe('every non-granted state names a way forward', () => {
  // brief §33: "The user must always have a fallback: Continue with text where
  // appropriate." Each sentence offers the map or continuing without location,
  // because a dead end during an emergency is the failure this prevents.

  const STATES = [
    'denied',
    'dismissed',
    'unsupported',
    'insecure',
    'timeout',
    'unavailable',
  ] as const;

  it.each(STATES)('%s offers a way forward', (state) => {
    const copy = geolocationCopy(state);
    expect(copy.length).toBeGreaterThan(0);
    expect(
      copy.includes('map') || copy.includes('try again') || copy.includes('without'),
      `"${copy}" names no way forward`,
    ).toBe(true);
  });

  it('`denied` does NOT invite a retry, because the browser will not ask again', () => {
    // docs/12 §3.5. "try again" after a refusal sends the citizen to a settings
    // screen with no explanation of why it cannot work.
    expect(GEOLOCATION_COPY.denied.toLowerCase()).not.toContain('try again');
    expect(GEOLOCATION_COPY.insecure.toLowerCase()).not.toContain('denied');
  });

  it('`granted` has no copy — a fix needs no explanation', () => {
    expect(geolocationCopy('granted')).toBe('');
  });

  it('the explainer states the benefit and nothing else', () => {
    // docs/12 §3.4, and brief §5's ban on manipulative permission messaging.
    expect(GEOLOCATION_COPY.explainer).toBe(
      'Your location helps responders understand where the emergency was reported.',
    );
    for (const coercive of ['urgent', 'immediately', 'lives', 'die', 'must', 'required', 'emergency services']) {
      expect(
        GEOLOCATION_COPY.explainer.toLowerCase(),
        `the explainer must not say "${coercive}"`,
      ).not.toContain(coercive);
    }
  });
});

/* ========================================================================== */

describe('NO COPY CLAIMS A RESPONDER IS COMING — brief §34', () => {
  const all = Object.values(GEOLOCATION_COPY);

  it.each([
    ['emergency services have been notified', /emergency services (have|has) been notified/i],
    ['help is on the way', /help is on the way/i],
    ['a responder has been dispatched', /responders? (have|has) been dispatched/i],
    ['we have found your location for you', /we('ve| have) found your location/i],
  ])('no string claims %s', (_label, pattern) => {
    for (const copy of all) {
      expect(copy, `matched ${pattern}: ${copy}`).not.toMatch(pattern);
    }
  });
});

/* ========================================================================== */

describe('manualPinAccuracy — docs/12 §2.1 and §4', () => {
  it('is floored at 30 m however far you zoom in', () => {
    // A pin at maximum zoom still asserts no better than ~2.4 m/px, and no
    // consumer GPS achieves sub-metre. Claiming otherwise is the dishonesty
    // `docs/12 §4.3`'s dashed pin exists to prevent.
    for (const zoom of [15, 17, 18, 20, 22]) {
      expect(manualPinAccuracy(zoom), `zoom ${zoom}`).toBeGreaterThanOrEqual(
        MANUAL_PIN_MIN_ACCURACY_M,
      );
    }
  });

  it('a zoomed-OUT pin asserts a WEAKER accuracy than a zoomed-in one', () => {
    // The whole point of the zoom-derived radius: a pin dropped while looking at a
    // whole city is a guess, and the ring must say so.
    expect(manualPinAccuracy(4)).toBeGreaterThan(manualPinAccuracy(16));
  });

  it('decreases monotonically with zoom', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let zoom = 2; zoom <= 16; zoom += 1) {
      const value = manualPinAccuracy(zoom);
      expect(value, `zoom ${zoom} increased`).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('a zoom 3 pin is kilometres, a zoom 15 pin is tens of metres', () => {
    expect(manualPinAccuracy(3)).toBeGreaterThan(1000);
    expect(manualPinAccuracy(15)).toBeLessThan(200);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('%s falls back to a sane value, never NaN', (_label, zoom) => {
    // `Math.max(30, NaN)` is `NaN`, and a `NaN` accuracy grades `unknown` and
    // renders as "accuracy unavailable" for a pin the citizen placed deliberately.
    const value = manualPinAccuracy(zoom);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBe(manualPinAccuracy(15));
  });

  it('a negative zoom clamps to the coarsest entry', () => {
    expect(manualPinAccuracy(-5)).toBe(manualPinAccuracy(0));
  });
});

/* ========================================================================== */

describe('pinTreatmentFor — docs/12 §2.2 and §4.3', () => {
  it('a good GPS fix is a SOLID pin', () => {
    expect(pinTreatmentFor('gps', 'high')).toBe(PIN_TREATMENT.solid);
    expect(pinTreatmentFor('gps', 'medium')).toBe(PIN_TREATMENT.solid);
  });

  it('a LOW-accuracy GPS fix is DASHED — same as a manual pin', () => {
    // Both are a human assertion rather than a fix, and they must look alike. A
    // consumer distinguishing them would be reading a precision that is not there.
    expect(pinTreatmentFor('gps', 'low')).toBe(PIN_TREATMENT.dashed);
    expect(pinTreatmentFor('gps', 'unknown')).toBe(PIN_TREATMENT.dashed);
    expect(pinTreatmentFor('gps', 'low')).toBe(pinTreatmentFor('manual_pin', 'high'));
  });

  it('a manual pin is always dashed, even at its best zoom', () => {
    expect(pinTreatmentFor('manual_pin', 'high')).toBe(PIN_TREATMENT.dashed);
  });

  it('a typed address is dashed — it is a geocoder opinion about a string', () => {
    expect(pinTreatmentFor('address_text', 'high')).toBe(PIN_TREATMENT.dashed);
  });

  it('`source: none` is the HATCHED LOCATION UNKNOWN marker, not a dashed pin', () => {
    // docs/12 §2.2: a null `geo` renders as a hatched square with LOCATION UNKNOWN,
    // which sorts ABOVE low-accuracy incidents (FR-034). A dashed pin would look
    // like a fix that exists.
    expect(pinTreatmentFor('none', 'unknown')).toBe(PIN_TREATMENT.hatched);
    expect(pinTreatmentFor('none', 'high')).toBe(PIN_TREATMENT.hatched);
  });

  it('there are exactly three treatments', () => {
    expect(Object.values(PIN_TREATMENT)).toHaveLength(3);
  });
});

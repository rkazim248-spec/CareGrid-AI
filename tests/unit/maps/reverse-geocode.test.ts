import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GEOCODE_TIMEOUT_MS,
  PLACE_NAME_MAX_CHARS,
  geocodeCacheDocId,
  geocodeCacheKey,
  isRetryableGeocodeStatus,
  placeNameSentence,
  resetGeocodeCacheForTests,
  roundTo,
  toReverseGeocodeResult,
} from '@/services/maps/reverse-geocode';

/* ========================================================================== */
/* Fixtures — the shape docs/12 §5.2 requires us to read                       */
/* ========================================================================== */

/** A Google `geocode/json` result with the given component types. */
function googleResult(components: Record<string, string>, placeId = 'place_abc') {
  return {
    place_id: placeId,
    formatted_address: '42 Example Street, Precinct 7, Sample City 500001',
    address_components: Object.entries(components).map(([type, longName]) => ({
      long_name: longName,
      short_name: longName,
      types: [type],
    })),
  };
}

/* ========================================================================== */

describe('the FR-035 discard is STRUCTURAL, not a promise', () => {
  it('the result type has no field for a street address', () => {
    // docs/12 §5.2: `route`, `street_number`, `formatted_address` and `postal_code`
    // are DISCARDED. A comment saying so is a promise; a type with no field is a
    // guarantee a future caller cannot accidentally violate.
    const result = toReverseGeocodeResult(
      googleResult({
        street_number: '42',
        route: 'Example Street',
        postal_code: '500001',
        locality: 'Sample City',
      }),
    );
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(['granularity', 'placeId', 'placeName']);
    // And no discarded value appears anywhere in the serialised result.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Example Street');
    expect(serialised).not.toContain('42');
    expect(serialised).not.toContain('500001');
  });

  it('even a sublocality-only result carries no route', () => {
    const result = toReverseGeocodeResult(
      googleResult({ sublocality: 'Koramangala 5th Block', route: '80ft Road' }),
    );
    expect(JSON.stringify(result)).not.toContain('80ft');
  });
});

/* ========================================================================== */

describe('component precedence follows docs/12 §5.2 exactly', () => {
  it('prefers sublocality — the right granularity for a dispatcher', () => {
    const result = toReverseGeocodeResult(
      googleResult({ sublocality: 'Koramangala 5th Block', locality: 'Bengaluru' }),
    );
    expect(result.placeName).toBe('Koramangala 5th Block');
    expect(result.granularity).toBe('sublocality');
  });

  it('falls back to locality', () => {
    const result = toReverseGeocodeResult(googleResult({ locality: 'Sample City' }));
    expect(result.placeName).toBe('Sample City');
    expect(result.granularity).toBe('locality');
  });

  it('falls back to postal_town when locality is absent', () => {
    const result = toReverseGeocodeResult(googleResult({ postal_town: 'Somewhere' }));
    expect(result.placeName).toBe('Somewhere');
  });

  it('falls back to an administrative area — a city name beats nothing', () => {
    const result = toReverseGeocodeResult(
      googleResult({ administrative_area_level_1: 'Region Name' }),
    );
    expect(result.placeName).toBe('Region Name');
    expect(result.granularity).toBe('area');
  });

  it('prefers the most specific administrative level available', () => {
    // level_3 is more precise than level_1, and a district beats a province.
    const result = toReverseGeocodeResult(
      googleResult({
        administrative_area_level_1: 'Province',
        administrative_area_level_2: 'Division',
        administrative_area_level_3: 'District',
      }),
    );
    expect(result.placeName).toBe('District');
  });

  it('`neighborhood` is accepted as a sublocality synonym', () => {
    const result = toReverseGeocodeResult(googleResult({ neighborhood: 'Old Town' }));
    expect(result.placeName).toBe('Old Town');
    expect(result.granularity).toBe('sublocality');
  });

  it('a result with no usable component is `unknown`, not a crash', () => {
    // A newly built area Google has no record of. docs/12 §5.5: the report still
    // creates.
    const result = toReverseGeocodeResult({ address_components: [] });
    expect(result.placeName).toBeNull();
    expect(result.granularity).toBe('unknown');
    expect(result.placeId).toBeNull();
  });

  it('an entirely empty object is handled', () => {
    expect(() => toReverseGeocodeResult({})).not.toThrow();
    expect(toReverseGeocodeResult({}).placeName).toBeNull();
  });

  it('caps placeName at 90 characters', () => {
    const long = 'A'.repeat(300);
    const result = toReverseGeocodeResult(googleResult({ locality: long }));
    expect(result.placeName).toHaveLength(PLACE_NAME_MAX_CHARS);
    expect(PLACE_NAME_MAX_CHARS).toBe(90);
  });

  it('keeps the place_id, for the "Open in maps" deep link', () => {
    expect(toReverseGeocodeResult(googleResult({ locality: 'X' }, 'p_123')).placeId).toBe('p_123');
  });

  it('first component of a type wins', () => {
    // Google's own ordering rule, and the one a naive loop would get backwards.
    const result = toReverseGeocodeResult({
      address_components: [
        { long_name: 'First', short_name: 'F', types: ['locality'] },
        { long_name: 'Second', short_name: 'S', types: ['locality'] },
      ],
    });
    expect(result.placeName).toBe('First');
  });

  it('falls back to short_name when long_name is missing', () => {
    const result = toReverseGeocodeResult({
      address_components: [{ short_name: 'SHORT', types: ['locality'] }],
    });
    expect(result.placeName).toBe('SHORT');
  });
});

/* ========================================================================== */

describe('the citizen-facing sentence says NEAR, never AT', () => {
  // docs/12 §5.5: in an informal settlement with no official street names, Google
  // returns the nearest NAMED entity, which may be 400 m away on a different road.
  // "At {placeName}" would be a false claim about where the incident is.

  it('prefixes a label with "Near"', () => {
    expect(placeNameSentence('Main Market')).toBe('Near Main Market');
  });

  it('never says "At"', () => {
    expect(placeNameSentence('Main Market')).not.toMatch(/^At /);
    expect(placeNameSentence('Main Market')).not.toContain('At ');
  });

  // brief §10 names the fallback exactly.
  it('falls back to the brief sentence when geocoding failed', () => {
    expect(placeNameSentence(null)).toBe('Location coordinates available');
    expect(placeNameSentence('')).toBe('Location coordinates available');
    expect(placeNameSentence('   ')).toBe('Location coordinates available');
  });

  it('trims a padded label', () => {
    expect(placeNameSentence('  Market  ')).toBe('Near Market');
  });
});

/* ========================================================================== */

describe('the cache key is ~11 m and the doc id is opaque', () => {
  it('rounds to 4 decimal places', () => {
    // docs/12 §5.4: "Coarser than any accuracy we grade, fine enough that two
    // people on the same pavement share a cache entry."
    //
    // Asserted as the KEY FORMAT, not as a memorised string. Two earlier versions
    // of this test hard-coded the expected output and were both wrong: one expected
    // `78.4874` and one expected a 6-character latitude field, while the actual
    // values are `78.4875` and 7 characters. The code was correct throughout and the
    // assertions were the problem — which is the argument for deriving the
    // expectation from the rule rather than from a previous run.
    const key = geocodeCacheKey(17.44781234, 78.48745678);
    expect(key).toBe(`g:${(17.44781234).toFixed(4)}:${(78.48745678).toFixed(4)}`);

    // The format itself: `g:` then two 4-decimal fields, separated by colons.
    expect(key).toMatch(/^g:-?\d+\.\d{4}:-?\d+\.\d{4}$/);
  });

  it('two people on the same pavement share a key', () => {
    // Both points fall inside the same 11 m grid cell at 4 dp.
    const a = geocodeCacheKey(17.44781, 78.48741);
    const b = geocodeCacheKey(17.44779, 78.48744);
    expect(a).toBe(b);
  });

  it('points 20 m apart do NOT share a key', () => {
    const a = geocodeCacheKey(17.4478, 78.4874);
    const b = geocodeCacheKey(17.4480, 78.4874);
    expect(a).not.toBe(b);
  });

  it('the document id is a sha256, NOT the coordinate string', () => {
    // docs/12 §5.4: "the key must not be a coordinate string" — a document id is a
    // readable path in the console and in rules-test output, and
    // `g:17.4478:78.4874` is a precise location in plain text.
    const id = geocodeCacheDocId(17.4478, 78.4874);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain('17.4');
    expect(id).not.toContain('78.4');
  });

  it('the doc id is stable for the same point and differs for another', () => {
    expect(geocodeCacheDocId(17.4478, 78.4874)).toBe(geocodeCacheDocId(17.4478, 78.4874));
    expect(geocodeCacheDocId(17.4478, 78.4874)).not.toBe(geocodeCacheDocId(17.5, 78.5));
  });

  it('handles the equator and negative zero', () => {
    // `Math.round(-0.4 * 100) / 100` is `-0`, and `Object.is(-0, 0)` is false — so
    // without the normalisation, a point on the equator would get a different cache
    // key from 0 degrees.
    expect(geocodeCacheKey(0, 0)).toBe(geocodeCacheKey(-0.00001, -0.00001));
    expect(Object.is(roundTo(-0.00001, 4), 0)).toBe(true);
    expect(Object.is(roundTo(-0, 4), 0)).toBe(true);
  });

  it('roundTo handles a non-finite value without producing NaN in a key', () => {
    expect(roundTo(Number.NaN, 4)).toBe(0);
    expect(roundTo(Number.POSITIVE_INFINITY, 4)).toBe(0);
    expect(geocodeCacheKey(Number.NaN, 67)).not.toContain('NaN');
  });
});

/* ========================================================================== */

describe('the retryable-status table', () => {
  // A quota failure is not a property of the coordinate, so it must not be cached.
  it.each([['OVER_QUERY_LIMIT'], ['UNKNOWN_ERROR'], ['OVER_DAILY_LIMIT'], ['REQUEST_DENIED']])(
    '%s is retryable',
    (status) => {
      expect(isRetryableGeocodeStatus(status)).toBe(true);
    },
  );

  it('ZERO_RESULTS is NOT retryable — it is a fact about the coordinate', () => {
    expect(isRetryableGeocodeStatus('ZERO_RESULTS')).toBe(false);
  });

  it('OK is not retryable', () => {
    expect(isRetryableGeocodeStatus('OK')).toBe(false);
  });
});

/* ========================================================================== */

describe('the documented constants', () => {
  it('the timeout is 8 s, per docs/08 §1.1 via docs/12 §5.1', () => {
    expect(GEOCODE_TIMEOUT_MS).toBe(8_000);
  });
});

/* ========================================================================== */

describe('the cache never fabricates a label', () => {
  beforeEach(() => {
    resetGeocodeCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetGeocodeCacheForTests();
  });

  it('a negative result is a CACHED VALUE, not an absent entry', () => {
    // docs/12 §5.4: "a cache hit must return the same placeName as the original
    // call, **including null results**". A cache that treated null as a miss would
    // re-query Google for every point in a region Google has no data for — the
    // exact case the cache exists for. This asserts the SHAPE: `placeName` is a
    // value on the result, never a marker of presence.
    const empty = toReverseGeocodeResult({ address_components: [] });
    expect(empty.placeName).toBeNull();
    // The field EXISTS and is null — as opposed to the field being absent, which
    // would be how a "no result" became indistinguishable from a miss.
    expect(Object.prototype.hasOwnProperty.call(empty, 'placeName')).toBe(true);
  });

  it('resetGeocodeCacheForTests is callable and idempotent', () => {
    expect(() => {
      resetGeocodeCacheForTests();
      resetGeocodeCacheForTests();
    }).not.toThrow();
  });
});

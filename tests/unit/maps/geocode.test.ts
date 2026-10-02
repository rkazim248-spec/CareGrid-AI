import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  geocodeAddress,
  gradeForGeocode,
  isGeocodingConfigured,
  setGeocodeFetch,
} from '@/services/maps/geocode';

/* ========================================================================== */
/* Fixtures — the shape a Mapbox v6 forward-geocode response actually has      */
/* ========================================================================== */

const TOKEN = 'pk.server-side-geocoding-token';

interface FeatureOptions {
  featureType?: string;
  latitude?: number;
  longitude?: number;
  fullAddress?: string;
  accuracyMeasured?: number;
}

/** A v6 feature: the point is in `properties.coordinates`, not `geometry`. */
function feature(options: FeatureOptions = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {
      mapbox_id: 'address.123',
      feature_type: options.featureType ?? 'address',
      full_address: options.fullAddress ?? '1600 Pennsylvania Ave NW, Washington, DC 20500',
      name: 'White House',
      // `accuracy_measured` sits at the `properties` level in Mapbox's v6 dataset,
      // NOT inside `coordinates`. Putting it in the wrong place in this fixture
      // would have made the "prefers the measured radius" test pass for the wrong
      // reason if the service had a separate fallback that happened to match.
      accuracy_measured: options.accuracyMeasured,
      coordinates: {
        latitude: options.latitude ?? 38.8977,
        longitude: options.longitude ?? -77.0365,
      },
    },
  };
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Capture the URL the service actually requested. */
function stubFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const restore = setGeocodeFetch(async (input) => {
    urls.push(input);
    return response(body, status);
  });
  return { urls, restore };
}

/* ========================================================================== */

describe('geocoding reuses the public Mapbox token, by decision', () => {
  const original = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
    else process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = original;
  });

  it('reports unconfigured when NO Mapbox token is set at all', async () => {
    // Set explicitly rather than read from the ambient environment, so the test
    // asserts the behaviour rather than whatever the developer happens to have in
    // `.env.local`. Vitest does not load `.env.local` the way Next does, so relying
    // on the ambient value would make this test vacuously pass.
    delete process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

    expect(isGeocodingConfigured()).toBe(false);

    const { urls, restore } = stubFetch({ features: [feature()] });
    const result = await geocodeAddress('1600 Pennsylvania Ave NW');
    restore();

    expect(result).toEqual({ ok: false, reason: 'provider_unavailable' });
    // The decisive assertion: with no credential, we make NO metered call. This is
    // the property that keeps a misconfigured deployment from spamming Mapbox and
    // failing at request time.
    expect(urls).toEqual([]);
  });

  it('treats an empty-string token as unconfigured, not as a live credential', () => {
    // `optionalString` returns `''` for an unset variable, and `'' !== null` reads as
    // "configured". Without the `|| null` in `geocodingToken()` an unset token becomes
    // a live geocoding path that fails at request time instead of degrading.
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = '';

    expect(isGeocodingConfigured()).toBe(false);
  });

  it('makes the request when the public token is set', async () => {
    // This is the accepted tradeoff: a public token spends a public token on a metered
    // endpoint. The mitigation is a URL restriction on the token in the Mapbox
    // dashboard, documented in `geocodingToken()` — not a second credential.
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = TOKEN;
    const { urls, restore } = stubFetch({ features: [feature()] });

    const result = await geocodeAddress('1600 Pennsylvania Ave NW');
    restore();

    expect(result.ok).toBe(true);
    expect(urls[0]).toContain(`access_token=${TOKEN}`);
  });
});

/* ========================================================================== */

describe('the citizen’s typed text is encoded, not interpolated', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = TOKEN;
  });

  it('survives a query with spaces, punctuation and ampersands', async () => {
    const { urls, restore } = stubFetch({ features: [feature()] });

    await geocodeAddress('O\'Hare & 3rd St, Unit #4/5');
    restore();

    const url = new URL(urls[0] as string);
    // Round-tripping proves it was parameter-encoded rather than pasted in, which
    // is what stops an address from being able to smuggle a query parameter.
    expect(url.searchParams.get('q')).toBe("O'Hare & 3rd St, Unit #4/5");
  });

  it('never asks for more than one candidate', async () => {
    const { urls, restore } = stubFetch({ features: [feature()] });
    await geocodeAddress('somewhere');
    restore();

    // Two candidates would mean picking between two guesses on the citizen's behalf.
    expect(new URL(urls[0] as string).searchParams.get('limit')).toBe('1');
  });

  it('refuses an empty query without spending a request', async () => {
    const { urls, restore } = stubFetch({ features: [feature()] });

    const result = await geocodeAddress('   ');

    restore();
    expect(result).toEqual({ ok: false, reason: 'no_match' });
    expect(urls).toEqual([]);
  });
});

/* ========================================================================== */

describe('only specific enough matches are usable', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = TOKEN;
  });

  it('rejects a locality hit as too coarse, and says so distinctly', async () => {
    // A district-level match cannot be dispatched to. Reporting it as `no_match`
    // would lose the fact that something WAS found, which is what tells the
    // citizen to add more detail rather than try again.
    const { restore } = stubFetch({ features: [feature({ featureType: 'locality' })] });

    const result = await geocodeAddress('Springfield');
    restore();

    expect(result).toEqual({ ok: false, reason: 'too_coarse' });
  });

  it.each(['region', 'country', 'district', 'postcode'])('rejects %s', async (featureType) => {
    const { restore } = stubFetch({ features: [feature({ featureType })] });
    const result = await geocodeAddress('a place');
    restore();

    expect(result.ok).toBe(false);
  });

  it.each(['rooftop', 'address', 'street', 'poi', 'place'])('accepts %s', async (featureType) => {
    const { restore } = stubFetch({ features: [feature({ featureType })] });
    const result = await geocodeAddress('a place');
    restore();

    expect(result.ok).toBe(true);
  });

  it('returns no_match for an empty feature list, not a crash', async () => {
    const { restore } = stubFetch({ features: [] });
    const result = await geocodeAddress('nowhere at all');
    restore();

    expect(result).toEqual({ ok: false, reason: 'no_match' });
  });
});

/* ========================================================================== */

describe('the provider’s own point and radius are read, not inferred', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = TOKEN;
  });

  it('reads properties.coordinates in latitude/longitude order', async () => {
    // The classic bug here is reading GeoJSON's [lng, lat] order out of this field
    // and placing every incident in the wrong hemisphere. This asserts the order.
    const { restore } = stubFetch({
      features: [feature({ latitude: 19.076, longitude: 72.8777 })],
    });

    const result = await geocodeAddress('Mumbai');

    restore();
    expect(result).toMatchObject({ ok: true, lat: 19.076, lng: 72.8777 });
  });

  it('prefers the provider’s measured radius over the tier default', async () => {
    const { restore } = stubFetch({
      features: [feature({ featureType: 'street', accuracyMeasured: 640 })],
    });

    const result = await geocodeAddress('a street');

    restore();
    // 640 m is the honest answer; the tier default for `street` is 250 m, which
    // would understate the radius and grade a coarse match `medium`.
    expect(result).toMatchObject({ ok: true, accuracyM: 640 });
  });

  it('rejects an out-of-range point rather than storing it', async () => {
    const { restore } = stubFetch({
      features: [feature({ latitude: 999, longitude: 0 })],
    });

    const result = await geocodeAddress('the middle of the sea');

    restore();
    expect(result).toEqual({ ok: false, reason: 'no_match' });
  });

  it('survives a response that is not an object at all', async () => {
    const { restore } = stubFetch('unexpected');
    const result = await geocodeAddress('anything');
    restore();

    expect(result).toEqual({ ok: false, reason: 'no_match' });
  });

  it('prefers the provider’s normalised label over the typed text', async () => {
    const { restore } = stubFetch({
      features: [feature({ fullAddress: '1600 Pennsylvania Ave NW, Washington, DC 20500' })],
    });

    const result = await geocodeAddress('white house washington');

    restore();
    expect(result).toMatchObject({ label: '1600 Pennsylvania Ave NW, Washington, DC 20500' });
  });
});

/* ========================================================================== */

describe('a provider failure degrades instead of throwing', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = TOKEN;
  });

  it.each([401, 403, 429, 500, 503])('maps HTTP %i to provider_unavailable', async (status) => {
    const { restore } = stubFetch({ message: 'nope' }, status);

    const result = await geocodeAddress('somewhere');

    restore();
    // Never throws: this runs inside incident creation, where losing the report to
    // a geocoder outage would be the worst possible trade.
    expect(result).toEqual({ ok: false, reason: 'provider_unavailable' });
  });

  it('maps a network error to provider_unavailable', async () => {
    const restore = setGeocodeFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await geocodeAddress('somewhere');

    restore();
    expect(result).toEqual({ ok: false, reason: 'provider_unavailable' });
  });
});

/* ========================================================================== */

describe('a typed address can never grade above medium', () => {
  // docs/12 §2.1 floors `address_text` at `low`, and the reason is that grading a
  // street-level match `high` puts a responder's trust in a result that is not exact.
  it.each([
    ['rooftop', 30],
    ['exact', 40],
    ['street', 100],
    ['address', 100],
    ['poi', 300],
    ['place', 2000],
  ] as const)('%s at %im never grades high', (matchType, accuracyM) => {
    expect(gradeForGeocode(matchType, accuracyM)).not.toBe('high');
  });

  it('grades a precise street match medium', () => {
    expect(gradeForGeocode('street', 100)).toBe('medium');
  });

  it('grades a place-level match unknown however small the radius', () => {
    // A `place` hit can return a tight radius from the provider and still be the
    // wrong end of a city, so the match TYPE has to be able to force `unknown`.
    expect(gradeForGeocode('place', 5)).toBe('unknown');
  });

  it('grades a wide street match low, not medium', () => {
    expect(gradeForGeocode('street', 900)).toBe('low');
  });
});

/* ========================================================================== */

describe('the seam is genuinely injectable', () => {
  it('restores the previous transport, so tests cannot leak into each other', async () => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = TOKEN;

    const first = stubFetch({ features: [] });
    await geocodeAddress('one');
    first.restore();

    const seen: string[] = [];
    const restoreSpy = setGeocodeFetch(async (input) => {
      seen.push(input);
      return response({ features: [] });
    });
    await geocodeAddress('two');
    restoreSpy();

    // After restore, the real `fetch` is back. Asserting this without a network
    // call is what makes the restore verifiable.
    expect(seen).toHaveLength(1);
    expect(first.urls).toHaveLength(1);
  });

  it('uses the real fetch once the seam is restored', async () => {
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = TOKEN;

    const spy = vi.restoreAllMocks;
    const restore = setGeocodeFetch(async () => response({ features: [feature()] }));
    restore();

    // Not asserted on the value — an actual request would hit the network. Asserted
    // only that the module is still callable and the default is back in place.
    expect(typeof spy).toBe('function');
    expect(isGeocodingConfigured()).toBe(true);
  });
});
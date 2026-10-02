import { describe, expect, it } from 'vitest';

import {
  buildIncidentPayload,
  describeSubmitError,
  toSubmitLocation,
} from '@/features/reporting/submit-report';
import { incidentCreateBodySchema } from '@/validators/incident';
import { ApiError } from '@/lib/api/errors';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const STAGING_A = 'staging/uid_abc123/med_ABCDEFGH2345.jpg';
const STAGING_B = 'staging/uid_abc123/med_ZYXWVUTS6789.webm';

function fixedLocation(overrides: Record<string, unknown> = {}) {
  return {
    source: 'gps' as const,
    lat: 38.8977,
    lng: -77.0365,
    accuracyM: 12,
    accuracyGrade: 'high' as const,
    placeName: null,
    locationText: null,
    ...overrides,
  };
}

/** An `ApiError` built the way `apiFetch` builds one. */
function apiError(status: number, message: string): ApiError {
  return new ApiError({
    status,
    code: status === 0 ? 'NETWORK_FAILURE' : 'REQUEST_FAILED',
    message,
    requestId: 'req_test',
  });
}

/* ========================================================================== */

describe('toSubmitLocation — `none` becomes null, never a zero coordinate', () => {
  it('sends null for a location the citizen declined to share', () => {
    expect(
      toSubmitLocation({
        source: 'none',
        lat: null,
        lng: null,
        accuracyM: null,
        accuracyGrade: 'unknown',
        placeName: null,
      }),
    ).toBeNull();
  });

  it('sends null for null input', () => {
    expect(toSubmitLocation(null)).toBeNull();
  });

  it('NEVER produces { lat: 0, lng: 0 }, which would file the incident in the Gulf of Guinea', () => {
    // Asserted across every source, because the failure mode is a default rather
    // than a specific branch: someone adds `lat ?? 0` and it happens for one path.
    for (const source of ['none', 'gps', 'manual_pin', 'address_text'] as const) {
      const result = toSubmitLocation({
        source,
        lat: null,
        lng: null,
        accuracyM: null,
        accuracyGrade: 'unknown',
        placeName: source === 'address_text' ? 'a real address' : null,
      });
      // `location` is optional on the wire schema, so the return type is nullable
      // AND undefined-able. Both "no location" outcomes are correct here.
      if (result === null || result === undefined) continue;
      expect(result.lat === 0 && result.lng === 0, `${source} produced 0,0`).toBe(false);
    }
  });
});

/* ========================================================================== */

describe('toSubmitLocation — a typed address keeps its text and sends no point', () => {
  it('sends the text with null coordinates rather than discarding the location', () => {
    // FR-035: geocoding is server-side, so the client genuinely has text and no
    // point. Returning null here would throw away the only location information
    // the citizen gave.
    const result = toSubmitLocation({
      source: 'address_text',
      lat: null,
      lng: null,
      accuracyM: 200,
      accuracyGrade: 'low',
      placeName: null,
      locationText: '1600 Pennsylvania Ave NW, Washington',
    });

    expect(result).toEqual({
      lat: null,
      lng: null,
      accuracyM: 200,
      accuracyGrade: 'low',
      source: 'address_text',
      placeName: '1600 Pennsylvania Ave NW, Washington',
    });
  });

  it('sends null when an address_text location somehow has no text at all', () => {
    // The schema would reject this with a 400, but the client must not put an
    // object with nothing in it on the wire either.
    const result = toSubmitLocation({
      source: 'address_text',
      lat: null,
      lng: null,
      accuracyM: 200,
      accuracyGrade: 'low',
      placeName: null,
      locationText: '   ',
    });

    expect(result).toBeNull();
  });

  it('a real fix on an address_text source still sends its coordinates', () => {
    const result = toSubmitLocation({
      source: 'address_text',
      lat: 38.8977,
      lng: -77.0365,
      accuracyM: 120,
      accuracyGrade: 'medium',
      placeName: 'Washington DC',
    });

    expect(result).toMatchObject({ lat: 38.8977, lng: -77.0365, source: 'address_text' });
  });
});

/* ========================================================================== */

describe('toSubmitLocation — the wire schema accepts everything it produces', () => {
  // The property that matters: a 400 on submit means a citizen loses their report
  // to a shape mismatch. Every branch above is fed through the real schema.
  const cases = [
    { name: 'gps fix', value: fixedLocation() },
    {
      name: 'gps fix with a label',
      value: fixedLocation({ placeName: 'Near the metro gate' }),
    },
    {
      name: 'a manual pin',
      value: fixedLocation({
        source: 'manual_pin',
        accuracyM: 900,
        accuracyGrade: 'low',
      }),
    },
    {
      name: 'a pin dropped at city zoom, graded unknown',
      value: fixedLocation({
        source: 'manual_pin',
        accuracyM: 4000,
        accuracyGrade: 'unknown',
      }),
    },
    {
      name: 'a typed address with no point',
      value: {
        source: 'address_text',
        lat: null,
        lng: null,
        accuracyM: 200,
        accuracyGrade: 'low',
        placeName: '1600 Pennsylvania Ave NW',
      },
    },
    { name: 'declined location', value: null },
  ] as const;

  it.each(cases)('$name passes incidentCreateBodySchema', ({ value }) => {
    const location = toSubmitLocation(value);
    const parsed = incidentCreateBodySchema.safeParse({
      text: 'a car has crashed on the service road',
      language: 'en',
      location,
      peopleAffected: null,
      media: [],
    });

    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });
});

/* ========================================================================== */

describe('a nullable accuracyM never becomes a precise-looking fix', () => {
  it('falls back to the schema ceiling, which grades as a wide area', () => {
    // A device can hand back a fix with no radius. The schema requires a number, so
    // something has to be chosen: the 100 km ceiling is chosen because it cannot
    // read as precision, and `accuracyGrade` carries the real story.
    const result = toSubmitLocation({
      source: 'gps',
      lat: 38.8977,
      lng: -77.0365,
      accuracyM: null,
      accuracyGrade: 'unknown',
      placeName: null,
    });

    expect(result).toMatchObject({ accuracyM: 100_000, accuracyGrade: 'unknown' });
  });
});

/* ========================================================================== */

describe('buildIncidentPayload', () => {
  it('trims the text, because trailing whitespace would count toward the minimum', () => {
    const payload = buildIncidentPayload({
      text: '   a car has crashed on the service road   ',
      language: 'en',
      location: null,
      peopleAffected: null,
      media: [],
    });

    expect(payload.text).toBe('a car has crashed on the service road');
  });

  it('sends staging paths and display names, and nothing else', () => {
    // Never `evidenceIds`: the server owns those, and a client-supplied id is a
    // claim about evidence that was never verified.
    const payload = buildIncidentPayload({
      text: 'a car has crashed on the service road',
      language: 'en',
      location: null,
      peopleAffected: 3,
      media: [
        { storagePath: STAGING_A, displayName: 'crash.jpg' },
        { storagePath: STAGING_B, displayName: 'note.webm' },
      ],
    });

    expect(payload.media).toEqual([
      { storagePath: STAGING_A, displayName: 'crash.jpg' },
      { storagePath: STAGING_B, displayName: 'note.webm' },
    ]);
    expect(payload).not.toHaveProperty('evidenceIds');
    expect(payload).not.toHaveProperty('triage');
    expect(payload).not.toHaveProperty('role');
  });

  it('a text-only report sends an empty media array, not undefined', () => {
    const payload = buildIncidentPayload({
      text: 'a car has crashed on the service road',
      language: 'en',
      location: null,
      peopleAffected: null,
      media: [],
    });

    expect(payload.media).toEqual([]);
    expect(incidentCreateBodySchema.safeParse(payload).success).toBe(true);
  });
});

/* ========================================================================== */

describe('describeSubmitError always says whether the draft survived', () => {
  // The single most important property: a citizen must never be told their report
  // was lost when it is sitting in the form, and must never be told it is safe when
  // it is not. `POST /api/incidents` writes in one batch, so almost everything is
  // recoverable.
  it.each([0, 400, 429, 500, 502, 503])('HTTP %i is recoverable', (status) => {
    const described = describeSubmitError(apiError(status, 'boom'));
    expect(described.recoverable).toBe(true);
  });

  it('an expired session says the text is still here and points at signing in', () => {
    for (const status of [401, 403]) {
      const described = describeSubmitError(apiError(status, 'nope'));
      expect(described.recoverable).toBe(false);
      expect(described.message).toMatch(/still here/i);
    }
  });

  it('a rate limit says to wait rather than to retry now', () => {
    // "Please try again" on a 429 is the advice that produced the rate limit.
    const described = describeSubmitError(apiError(429, 'slow down'));
    expect(described.message).toMatch(/wait a moment/i);
    expect(described.message).not.toMatch(/try again/i);
  });

  it('being offline is named as offline', () => {
    const described = describeSubmitError(apiError(0, 'no network'));
    expect(described.message).toMatch(/offline/i);
  });

  it("passes the server's own message through for a 400", () => {
    // The server already writes validation messages for people, and it knows which
    // file or field is wrong. Replacing it with a generic sentence loses that.
    const described = describeSubmitError(
      apiError(400, 'A report can carry at most 3 photos.'),
    );
    expect(described.message).toBe('A report can carry at most 3 photos.');
  });

  it('an unexpected error still reassures about the draft', () => {
    const described = describeSubmitError(new TypeError('boom'));
    expect(described.recoverable).toBe(true);
    expect(described.message).toMatch(/still here/i);
  });
});
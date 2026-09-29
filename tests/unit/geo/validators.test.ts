import { describe, expect, it } from 'vitest';

import {
  accuracyMetresField,
  duplicateDecisionBodySchema,
  geoCellsSchema,
  geoInputSchema,
  latLngSchema,
  latitudeField,
  longitudeField,
} from '@/validators/geo';
import { buildGeoCells, GEO_CELLS_PER_INCIDENT } from '@/lib/geo/geohash';

/* ========================================================================== */

describe('latitudeField and longitudeField — brief §16', () => {
  it.each([
    [0],
    [17.44],
    [90],
    [-90],
    [0.000001],
    [-0.000001],
  ])('accepts latitude %s', (value) => {
    expect(latitudeField.safeParse(value).success).toBe(true);
  });

  it.each([
    [91, 'above 90'],
    [-91, 'below -90'],
    [500, 'brief §16: latitude 500'],
    [90.0001, 'just above 90'],
  ])('rejects latitude %s (%s)', (value) => {
    expect(latitudeField.safeParse(value).success).toBe(false);
  });

  it.each([[0], [67], [180], [-180], [179.999]])('accepts longitude %s', (value) => {
    expect(longitudeField.safeParse(value).success).toBe(true);
  });

  it.each([[181], [-181], [360], [180.0001]])('rejects longitude %s', (value) => {
    expect(longitudeField.safeParse(value).success).toBe(false);
  });

  // The three a naive `.min().max()` chain mishandles.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s', (_label, value) => {
    // Zod's `z.number()` rejects NaN but ACCEPTS Infinity. `.finite()` is stated
    // explicitly so the schema is right for the right reason, rather than right by
    // accident because `Infinity <= 90` happens to be false.
    expect(latitudeField.safeParse(value).success).toBe(false);
    expect(longitudeField.safeParse(value).success).toBe(false);
  });

  it.each([
    ['a numeric string', '17.44'],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['a boolean', true],
  ])('rejects %s', (_label, value) => {
    expect(latitudeField.safeParse(value).success).toBe(false);
  });

  it('names the field in the error, so the message is actionable', () => {
    // The error is shown to a citizen in the form, so "Latitude must be between -90
    // and 90." rather than "Invalid input".
    const result = latitudeField.safeParse(500);
    expect(result.success).toBe(false);
    expect(JSON.stringify((result as { error: unknown }).error)).toContain('90');
  });
});

/* ========================================================================== */

describe('latLngSchema', () => {
  it('accepts a real coordinate', () => {
    expect(latLngSchema.safeParse({ lat: 17.44, lng: 67.0 }).success).toBe(true);
  });

  it.each([
    ['latitude 500', { lat: 500, lng: 67 }],
    ['longitude 200', { lat: 17.44, lng: 200 }],
    ['NaN latitude', { lat: Number.NaN, lng: 67 }],
    ['a null coordinate', { lat: null, lng: null }],
    ['a missing longitude', { lat: 17.44 }],
    ['strings', { lat: '17.44', lng: '67' }],
  ])('rejects %s', (_label, value) => {
    expect(latLngSchema.safeParse(value).success).toBe(false);
  });

  it('is .strict(), so an extra field is a rejection', () => {
    // brief §31 and docs/12 GEO-3. A silently-ignored extra field is how a
    // client-supplied value becomes server-ignored-but-client-assumed-stored.
    expect(latLngSchema.safeParse({ lat: 17.44, lng: 67, accuracyM: 10 }).success).toBe(false);
  });
});

/* ========================================================================== */

describe('geoInputSchema — docs/12 §2.3', () => {
  const valid = { lat: 17.44, lng: 67.0, accuracyM: 35, source: 'gps' as const };

  it('accepts a valid client geo', () => {
    expect(geoInputSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a null accuracy — "unavailable" is a real state', () => {
    // brief §9: "If accuracy is unavailable: Accuracy unavailable". Refusing a null
    // would force a fake number into the document.
    expect(geoInputSchema.safeParse({ ...valid, accuracyM: null }).success).toBe(true);
  });

  it('accepts a typed address, 3-200 chars', () => {
    expect(geoInputSchema.safeParse({ ...valid, address: 'Main Market' }).success).toBe(true);
    expect(geoInputSchema.safeParse({ ...valid, address: 'ab' }).success).toBe(false);
    expect(geoInputSchema.safeParse({ ...valid, address: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects `source: none` from a client', () => {
    // `none` means the citizen chose to CONTINUE WITHOUT LOCATION, and is produced
    // by the server when there is no `geo` object at all. A client sending
    // `source: 'none'` with coordinates is asserting a contradiction, and `none` is
    // also the value that makes the map render LOCATION UNKNOWN — so accepting it
    // with a lat/lng would produce a document that displays as unlocated while
    // carrying coordinates.
    expect(geoInputSchema.safeParse({ ...valid, source: 'none' }).success).toBe(false);
  });

  it('rejects a client-supplied `accuracyGrade`', () => {
    // docs/12 §2.2: grading is a communication device whose whole value is that it
    // was DERIVED. A client claiming `high` with a 900 m fix would make the marker
    // solid and the warning disappear.
    expect(geoInputSchema.safeParse({ ...valid, accuracyGrade: 'high' }).success).toBe(false);
  });

  it('rejects a client-supplied `capturedAt`', () => {
    // A client claiming a fix was captured now, when the browser may have returned a
    // cached one from 30 s ago or a device whose clock is years off, asserts
    // something it cannot know.
    expect(geoInputSchema.safeParse({ ...valid, capturedAt: Date.now() }).success).toBe(false);
  });

  // docs/12 GEO-3, FR-036. The single most important rejection in this file.
  it('rejects a client-supplied `geoCells`', () => {
    const result = geoInputSchema.safeParse({ ...valid, geoCells: buildGeoCells(17.44, 67.0) });
    expect(result.success).toBe(false);
    // And the error NAMES the offending field, so a developer who reads the 400
    // learns why rather than guessing.
    expect(JSON.stringify((result as { error: unknown }).error)).toContain('geoCells');
  });

  it('rejects a client-supplied `placeName`', () => {
    // That is the SERVER's reverse geocode (FR-035, server-side only). A client
    // asserting "Karachi" would let a report claim a district it is not in, and
    // `docs/09 §4.1` requires a reverse-geocoded label for the AI audit trail.
    expect(geoInputSchema.safeParse({ ...valid, placeName: 'Karachi' }).success).toBe(false);
  });

  it('rejects a negative accuracy', () => {
    expect(geoInputSchema.safeParse({ ...valid, accuracyM: -1 }).success).toBe(false);
  });

  it('accepts accuracyM 0 — a stationary device with a good fix is legitimate', () => {
    // `.nonnegative()`, not `.positive()`. Rejecting 0 would push every such report
    // to the `unknown` grade for no reason.
    expect(geoInputSchema.safeParse({ ...valid, accuracyM: 0 }).success).toBe(true);
  });
});

/* ========================================================================== */

describe('accuracyMetresField', () => {
  it.each([[0], [1], [35], [1000], [999_999]])('accepts %s', (value) => {
    expect(accuracyMetresField.safeParse(value).success).toBe(true);
  });

  it('rejects a negative, a NaN, and an implausibly large value', () => {
    expect(accuracyMetresField.safeParse(-1).success).toBe(false);
    expect(accuracyMetresField.safeParse(Number.NaN).success).toBe(false);
    expect(accuracyMetresField.safeParse(2_000_000).success).toBe(false);
  });
});

/* ========================================================================== */

describe('geoCellsSchema — server-side only, FR-036', () => {
  it('accepts a server-built 9-cell array', () => {
    const cells = buildGeoCells(17.44, 67.0);
    expect(cells).toHaveLength(GEO_CELLS_PER_INCIDENT);
    expect(geoCellsSchema.safeParse(cells).success).toBe(true);
  });

  it('caps at 10 — the Firestore per-array-element INDEX limit', () => {
    // Deliberately 10, not 9. The schema encodes the platform limit; the builder
    // produces the true 3x3 block. Both are correct and they are different numbers.
    expect(geoCellsSchema.safeParse(new Array(10).fill('t7pehw')).success).toBe(true);
    expect(geoCellsSchema.safeParse(new Array(11).fill('t7pehw')).success).toBe(false);
  });

  it('requires precision-6 strings', () => {
    expect(geoCellsSchema.safeParse(['t7p']).success).toBe(false);
    expect(geoCellsSchema.safeParse(['t7pehwx']).success).toBe(false);
    expect(geoCellsSchema.safeParse([123456]).success).toBe(false);
  });

  it('accepts an absent array, because GEO-2 says absent not empty', () => {
    // docs/12 GEO-2: "geoCells is absent (not [], not [null]) when geo is null. An
    // empty array is a lie that a query can match." The schema describes the field
    // when present; whether it is present is decided by the incident service.
    expect(geoCellsSchema.safeParse([]).success).toBe(true);
  });
});

/* ========================================================================== */

describe('duplicateDecisionBodySchema — brief §27, §38', () => {
  const valid = { candidateIncidentId: 'a'.repeat(20), decision: 'same_incident' as const };

  it('accepts a same-incident answer', () => {
    expect(duplicateDecisionBodySchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a different-incident answer', () => {
    expect(
      duplicateDecisionBodySchema.safeParse({ ...valid, decision: 'different_incident' }).success,
    ).toBe(true);
  });

  it('has NO merge option', () => {
    // brief §27: "do not delete their report. Instead create a relationship." The
    // vocabulary is the enforcement — a citizen cannot express "merge" because the
    // string does not exist.
    for (const attempt of ['merge', 'merged', 'overwrite', 'delete', 'confirm_merge']) {
      expect(
        duplicateDecisionBodySchema.safeParse({ ...valid, decision: attempt }).success,
        `"${attempt}" must not be accepted`,
      ).toBe(false);
    }
  });

  it('requires a well-formed 20-character incidentId', () => {
    expect(
      duplicateDecisionBodySchema.safeParse({ ...valid, candidateIncidentId: 'short' }).success,
    ).toBe(false);
    expect(
      duplicateDecisionBodySchema.safeParse({
        ...valid,
        candidateIncidentId: `${'a'.repeat(19)}!`,
      }).success,
    ).toBe(false);
  });

  // brief §38: "Never trust client-provided role, client-provided ownership,
  // client-provided duplicate decision". The decision is trusted as an ANSWER; what
  // it must not be able to carry is an identity or a privilege.
  it.each([
    ['a role', { role: 'dispatcher' }],
    ['a uid', { uid: 'someone-else' }],
    ['a mergedIntoId', { mergedIntoId: 'b'.repeat(20) }],
    ['a status', { status: 'closed' }],
    ['a verdict', { decision: 'confirmed_duplicate' }],
    ['a score', { score: 1 }],
  ])('refuses to carry %s', (_label, extra) => {
    expect(duplicateDecisionBodySchema.safeParse({ ...valid, ...extra }).success).toBe(false);
  });

  it('caps the optional note at 500 chars', () => {
    expect(duplicateDecisionBodySchema.safeParse({ ...valid, note: 'same crash' }).success).toBe(true);
    expect(
      duplicateDecisionBodySchema.safeParse({ ...valid, note: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});

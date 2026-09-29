/**
 * ============================================================================
 * CareGrid AI — coordinate validation
 * ============================================================================
 *
 * brief §16, docs/17, docs/12 §2.3. The Zod boundary for anything carrying a
 * coordinate.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS `.strict()` AND WHY GEOHASHES ARE REFUSED
 * ---------------------------------------------------------------------------
 * Two rules, and both are load-bearing:
 *
 * | Rule | Why |
 * | --- | --- |
 * | `lat`/`lng` in range, finite | brief §16. `latitude: 500` must never be stored, and neither must `NaN`. |
 * | **`geoCells` is NOT an accepted input** | docs/12 GEO-3, FR-036: "Computed **server-side only**. A client-supplied `geoCells` is rejected by the Zod schema (`.strict()`)". |
 *
 * The second is the interesting one. A client that could choose its own cells
 * would choose cells that match nothing (hiding its own incident from every map and
 * duplicate query) or cells that match a dense cluster of unrelated ones (flooding
 * every viewport query in that area with its document). `.strict()` is what makes
 * the extra field a **400** rather than a silently-ignored one.
 *
 * ---------------------------------------------------------------------------
 * WHY `lat`/`lng` AND NOT `latitude`/`longitude`
 * ---------------------------------------------------------------------------
 * brief §15 and §16 propose `{ latitude, longitude, accuracyMeters, source,
 * address, capturedAt }` under a `location` key. `docs/07 §4.1` and `docs/12 §2.3`
 * specify `geo: { lat, lng, accuracyM, accuracyGrade, source, placeName }`, and
 * `types/domain.ts` already implements that from Phase 3. The specification wins,
 * for the same reason as in Phase 5: the existing codebase and the database
 * document already use the documented names, and a second shape would mean
 * translating between them at every boundary.
 */


import { z } from 'zod';

/**
 * A finite latitude in [-90, 90].
 *
 * **`.finite()` is explicit, not implied by the range.** Zod's `z.number()`
 * rejects `NaN` but ACCEPTS `Infinity`, and a bare `.min().max()` chain happens to
 * reject it only because `Infinity <= 90` is false. Stating `.finite()` makes the
 * intent visible at the schema, and makes the schema correct if the range is ever
 * widened to include a sentinel.
 */
export const latitudeField = z.number().finite().min(-90, 'Latitude must be between -90 and 90.').max(90, 'Latitude must be between -90 and 90.');

/** A finite longitude in [-180, 180]. */
export const longitudeField = z.number().finite().min(-180, 'Longitude must be between -180 and 180.').max(180, 'Longitude must be between -180 and 180.');

/**
 * A browser-reported accuracy radius, in metres.
 *
 * **`.nonnegative()`, not just `.positive()`.** `accuracy: 0` is a real and valid
 * value for a stationary device with a good fix, and rejecting it would push every
 * such report to the `unknown` grade for no reason. A NEGATIVE accuracy is a broken
 * sensor and is refused here as well as in `gradeAccuracy`, so the invariant holds
 * at both the boundary and the computation.
 */
export const accuracyMetresField = z
  .number()
  .finite()
  .nonnegative('Accuracy cannot be negative.')
  .max(1_000_000, 'Accuracy is implausibly large; the fix may be invalid.');

/**
 * A `lat`/`lng` pair.
 *
 * Exported separately from the full `geo` object because the manual-pin flow, the
 * geolocation hook and the reverse-geocode call all need just the point, and a
 * schema that demanded `source` and `accuracyGrade` for a bare coordinate would make
 * each of them construct a fake source.
 */
export const latLngSchema = z
  .object({
    lat: latitudeField,
    lng: longitudeField,
  })
  .strict();

export type LatLngInput = z.infer<typeof latLngSchema>;

/**
 * The `geo` object as submitted by a client. `docs/12 §2.3`.
 *
 * **`accuracyGrade` is NOT accepted from a client.** It is *computed* from
 * `accuracyM` by `gradeAccuracy()` on the server. A client-supplied grade would let
 * a report claim `high` accuracy with a 900 m fix, and `docs/12 §2.2` is explicit
 * that grading is a communication device whose whole value is that it was derived.
 *
 * `capturedAt` is likewise server-assigned: a client claiming a fix was captured
 * now, when it may have cached one from an hour ago (the browser's `maximumAge`),
 * would be asserting something it cannot know.
 */
export const geoInputSchema = z
  .object({
    lat: latitudeField,
    lng: longitudeField,
    accuracyM: accuracyMetresField.nullable(),
    source: z.enum(['gps', 'manual_pin', 'address_text']),
    /** A typed address, 3-200 chars. `docs/12 §2.1`. Null when not typed. */
    address: z.string().trim().min(3).max(200).nullable().optional(),
  })
  .strict();

export type GeoInput = z.infer<typeof geoInputSchema>;

/**
 * A client's answer to "is this the same emergency?".
 *
 * **Not a merge instruction.** brief §27: if the citizen says "this is the same
 * emergency", do **not** delete their report — create a relationship and preserve
 * the original for auditability. The vocabulary is therefore deliberately narrow:
 * there is no `'merge'`, and no `'overwrite'`.
 *
 * `.strict()` so a client cannot smuggle a role, an owner, or a
 * `mergedIntoId` into the same payload that carries this decision. brief §38: "Never
 * trust client-provided ... client-provided duplicate decision" — which is
 * satisfied structurally, by the decision being a field of a typed object that
 * cannot carry anything else.
 */
export const duplicateDecisionBodySchema = z
  .object({
    candidateIncidentId: z
      .string()
      .regex(/^[A-Za-z0-9]{20}$/, 'An incidentId looks like 20 letters and digits.'),
    decision: z.enum(['same_incident', 'different_incident']),
    /** Optional free text. Capped, and never rendered as HTML. */
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type DuplicateDecisionBody = z.infer<typeof duplicateDecisionBodySchema>;

/**
 * A `geoCells` array, for the **server-side** path and for tests.
 *
 * Present in this file but NOT reachable from any client body — a `validate.ts`
 * helper or a `.passthrough()` would be the mistake. It exists so the incident
 * service has one place that knows the shape, and so a test can assert a
 * server-built array satisfies the schema the document is validated against.
 *
 * `max(10)` rather than `max(9)`: the schema encodes the Firestore
 * per-array-element **index limit** (FR-036), which is 10, while
 * `GEO_CELLS_PER_INCIDENT` is 9 (the true 3x3 block — see `lib/geo/geohash.ts`'s
 * header on why the specification's "exactly 10" is an arithmetic error). The two
 * numbers are deliberately different and both are correct.
 */
export const geoCellsSchema = z.array(z.string().length(6)).max(10);

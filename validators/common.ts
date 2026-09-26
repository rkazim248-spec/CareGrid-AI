/**
 * ============================================================================
 * CareGrid AI — shared validation primitives
 * ============================================================================
 *
 * The reusable field validators every request schema is built from. docs/17 §2.1
 * names this file; it is the reason `validators/incident.ts` is a table of
 * business rules rather than forty lines of `.min()` and `.regex()`.
 *
 * ---------------------------------------------------------------------------
 * WHY PURE, AND WHY THAT IS ENFORCED
 * ---------------------------------------------------------------------------
 * This file imports `zod`, `config/`, and `types/` — and nothing else. No
 * Firestore, no `process.env`, no React, no `next/*`. That is what lets the SAME
 * schema run in a React Hook Form for instant inline feedback and again on the
 * server as the authority (docs/17 §0 rule 1 and rule 5). A schema that could
 * reach a database would have to be duplicated, and the copy would be the one
 * nobody keeps in sync.
 *
 * ---------------------------------------------------------------------------
 * THE ISSUE TOKENS ARE THE CONTRACT
 * ---------------------------------------------------------------------------
 * `issue` in an API error is a machine token from a CLOSED vocabulary, never a
 * rendered sentence — `too_small`, `invalid_enum_value`, `too_big`,
 * `invalid_format`, `unrecognized_keys`, `custom`. The client maps a token to a
 * sentence in the user's language (docs/17 §12). That is what makes the envelope
 * localisable without a server change, and it is why a schema's `message` is
 * allowed to be English here: the message is the FALLBACK, and the token is what
 * code branches on.
 */

import { z } from 'zod';

/* ========================================================================== */
/* Strings                                                                    */
/* ========================================================================== */

/**
 * A trimmed string with length bounds.
 *
 * Trim happens BEFORE the bounds are checked, so `"  hi  "` is 2 characters and
 * not 8. A field that counts whitespace as content lets a user fill a
 * 20-character minimum with padding, and the bound stops meaning anything.
 */
export function trimmedString(min: number, max: number, message?: string) {
  return z
    .string({ message: message ?? 'This field is required.' })
    .trim()
    .min(min, message ?? `Use at least ${min} characters.`)
    .max(max, message ?? `Keep it under ${max} characters.`);
}

/**
 * A bounded, non-empty string that a form should show as free text.
 *
 * `maxLength` is set so the UI can render a live counter from the schema rather
 * than from a second hard-coded number in a component (docs/04 §5).
 */
export function boundedText(min: number, max: number) {
  return z.string().trim().min(min).max(max);
}

/** An email, lowercased before validation so case never splits an identity. */
export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .email('That does not look like an email address.');

/** An E.164 phone number, e.g. `+919876543210`. docs/17 §2.1. */
export const phoneField = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Use the international format, starting with + and the country code.');

/** An IANA timezone, e.g. `Asia/Kolkata`. Length-bounded, not enumerated. */
export const timezoneField = z.string().trim().min(1).max(64);

/* ========================================================================== */
/* Numbers                                                                    */
/* ========================================================================== */

/**
 * A bounded integer, with an explicit `Number.isFinite` guard.
 *
 * The guard is the point. In Zod, `.max()` on a coerced `NaN` PASSES, because
 * every comparison with `NaN` is false — so `?limit=abc` would sail through a
 * `.min(1).max(100)` and reach a Firestore query as `NaN`. docs/17 §14,
 * anti-pattern 23, and the reason this is a factory rather than a chain.
 *
 * A body number arriving as a string is a BUG and is not coerced: only a query
 * string, where everything is a string by construction, is.
 */
export function boundedInt(min: number, max: number) {
  return z
    .number({ message: 'Enter a number.' })
    .int('Enter a whole number.')
    .refine((value) => Number.isFinite(value), 'Enter a number.')
    .min(min, `Must be at least ${min}.`)
    .max(max, `Must be at most ${max}.`);
}

/* ========================================================================== */
/* Identifiers                                                                */
/* ========================================================================== */

/**
 * Identifiers.
 *
 * A Firestore auto-ID: exactly 20 characters of `[A-Za-z0-9]`.
 *
 * Exact length is what makes this a useful check rather than a formality. A
 * `:id` of the wrong length is a client bug or a truncation, and answering 400
 * says so; answering 404 would say "this incident does not exist" and send
 * someone looking for a record that was never lost (docs/17 §5.55).
 */
export function firestoreId(field = 'id') {
  return z
    .string()
    .regex(
      /^[A-Za-z0-9]{20}$/,
      `${field} must be 20 letters or digits with no spaces or symbols.`,
    );
}

/** A media id: `med_` + 2-32 Crockford base32 characters. docs/15 §3. */
export const mediaIdField = z
  .string()
  .regex(/^med_[A-Za-z0-9]{2,32}$/, 'Must be med_ followed by at least 2 characters.');

/** An incident report id: `rep_` + Crockford base32. */
export const reportIdField = z
  .string()
  .regex(/^rep_[A-Za-z0-9]{2,32}$/, 'Must be rep_ followed by at least 2 characters.');

/** A dispatch id: `dsp_` + Crockford base32. */
export const dispatchIdField = z
  .string()
  .regex(/^dsp_[A-Za-z0-9]{2,32}$/, 'Must be dsp_ followed by at least 2 characters.');

/**
 * The Crockford base32 alphabet, minus I, L, O and U.
 *
 * Excluded because those four are misread as `1` and `0` when read aloud, and
 * a reference is read aloud on a radio. Declared ONCE here so a generator in
 * `lib/incidents/reference.ts` and a validator cannot disagree about which
 * characters are legal (docs/30 D-30-7).
 */
export const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;

/** A citizen-facing incident reference: `CG-` + 6 Crockford base32 characters. */
export const referenceField = z
  .string()
  .regex(
    new RegExp(`^CG-[${BASE32_ALPHABET}]{6}$`),
    'Must be CG- followed by 6 characters.',
  );

/** A geohash at precision 6. docs/07 §9.2. */
export const geohash6Field = z
  .string()
  .regex(/^[0-9b-hjkmnp-z]{6}$/, 'Must be 6 lowercase geohash characters.');

/** A request id as produced by `lib/server/http.ts`. */
export const requestIdField = z
  .string()
  .regex(/^req_[A-Za-z0-9]{12}$/, 'Must be req_ followed by 12 characters.');

/* ========================================================================== */
/* Timestamps                                                                 */
/* ========================================================================== */

/**
 * ISO-8601 WITH a timezone offset, normalised to a `Date`.
 *
 * A bare `2026-09-26T10:00:00` is rejected on purpose. Without an offset its
 * meaning depends on the server's locale, and "when did this happen" in an
 * incident report is not a question with a safe default. `Z` and `+00:00` are
 * both accepted, and the value is converted once, here, so a service never has
 * to reason about a string.
 */
export const isoInstantField = z
  .string()
  .datetime({ offset: true, message: 'Use an ISO-8601 timestamp with a timezone, e.g. 2026-09-26T10:00:00Z.' })
  .transform((value) => new Date(value));

/**
 * A `YYYY-MM-DD` calendar date, for analytics ranges. docs/17 §2.1.
 *
 * A DATE and an INSTANT are different questions. `from` and `to` on an analytics
 * query name days in `APP_TIMEZONE`; parsing them as instants would silently
 * shift every bucket by the deployment's offset.
 */
export const isoDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.');

/* ========================================================================== */
/* Location                                                                   */
/* ========================================================================== */

/**
 * A coordinate pair, range-checked.
 *
 * The range check is not pedantry. `lat: 947` renders as a marker at an
 * impossible place rather than as an error, and a fabricated coordinate on a
 * real emergency report sends a responder to the wrong place. Out of range is
 * `400`, at the edge (docs/17 §3).
 */
export const coordinateField = z.object({
  lat: z
    .number({ message: 'Enter a latitude.' })
    .gte(-90, 'Latitude must be between -90 and 90.')
    .lte(90, 'Latitude must be between -90 and 90.'),
  lng: z
    .number({ message: 'Enter a longitude.' })
    .gte(-180, 'Longitude must be between -180 and 180.')
    .lte(180, 'Longitude must be between -180 and 180.'),
});

/* ========================================================================== */
/* Reason                                                                     */
/* ========================================================================== */

/**
 * An audit reason. 10 characters is the documented floor (FR-133).
 *
 * Short enough that nobody skips it, long enough that "test" and "asdf" is not
 * a record. Capped at 280 so it fits a log line and a UI tooltip without
 * truncation.
 */
export const reasonField = trimmedString(
  10,
  280,
  'Write at least 10 characters so this is understandable later.',
);

/* ========================================================================== */
/* Composition helpers                                                        */
/* ========================================================================== */

/**
 * A `.strict()` object, and the only way one is built in this project.
 *
 * An unknown key in a request body is REJECTED, not ignored. Three reasons, in
 * order of importance:
 *
 *   1. **`role` cannot ride along.** `assertNoRoleInBody()` also rejects it, but
 *      that is one function a future route could forget to call. A strict schema
 *      is a property of the TYPE, not a line in a handler.
 *   2. **Typos fail loudly.** `{ displayname: '.' }` is rejected instead of
 *      silently creating a user with no name.
 *   3. **It is a version boundary.** Adding a field is an API change, and a
 *      strict schema makes an old client fail visibly rather than half-work.
 *
 * Response schemas deliberately do NOT use this: a newer server must not break
 * an older cached client, so an unknown response key is dropped (docs/17 §1.2).
 */
export function strictObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

/**
 * Collapse a list of Zod issues to one per field, keeping the FIRST.
 *
 * A form wants one message next to an input. A field with three issues produces
 * one line, and the other two are still available in the array for anyone who
 * wants them. This is a CLIENT-side concern and lives in the client, not here.
 */
export function firstIssuePerField(
  issues: ReadonlyArray<{ field: string; issue: string }>,
): Array<{ field: string; issue: string }> {
  const seen = new Set<string>();
  const out: Array<{ field: string; issue: string }> = [];
  for (const entry of issues) {
    if (seen.has(entry.field)) continue;
    seen.add(entry.field);
    out.push(entry);
  }
  return out;
}

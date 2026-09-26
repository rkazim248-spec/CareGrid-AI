/**
 * ============================================================================
 * CareGrid AI — query-string schemas
 * ============================================================================
 *
 * The shared pagination and filter primitives. docs/17 §9 owns the policy; this
 * file owns the mechanics, so twenty list routes do not each re-derive what a
 * cursor is.
 *
 * ---------------------------------------------------------------------------
 * THE ONE CLAMP IN THE SYSTEM
 * ---------------------------------------------------------------------------
 * docs/17 §4.1: `limit > max` on a READ-ONLY LIST route is CLAMPED to `max`, and
 * the effective value is echoed to the client. Everywhere else it is a `400`.
 *
 * This is the only clamp, and `tests/unit/api/validation.test.ts` fails if a
 * second `.clamp()` or a `|| default` appears in a schema. The reason it is
 * worth a test: two clamps means a client can no longer predict what it asked
 * for, and a silent clamp on a WRITE path is data loss.
 *
 * The echoed value is not a nicety. A dispatcher who typed `limit=500` and got
 * 25 rows with no explanation concludes the queue is empty, which is a worse
 * failure than an error.
 */

import { z } from 'zod';

/** FR-121. The default page size. */
export const DEFAULT_PAGE_SIZE = 25;

/** FR-121. The hard ceiling for any list route. */
export const MAX_PAGE_SIZE = 100;

/**
 * The page size, with the single documented clamp.
 *
 * A non-integer, `NaN`, or `≤ 0` is a `400`, never repaired. A `limit=0` is a
 * caller bug, and defaulting it to 25 would hide the bug behind a page of data.
 */
export const limitField = z
  .string()
  .trim()
  .transform((raw) => Number(raw))
  .refine((value) => Number.isFinite(value), 'Enter a number.')
  .refine((value) => Number.isInteger(value), 'Enter a whole number.')
  .refine((value) => value > 0, 'Must be at least 1.')
  .transform((value) => Math.min(MAX_PAGE_SIZE, value));

/**
 * An opaque pagination cursor.
 *
 * Opaque to the client BY CONTRACT: it is base64url of a server-generated
 * fingerprint of the sort key, the filters, and the direction. Capped at 512
 * characters because a cursor is a server-issued value — a longer one is either
 * a bug or an attempt to smuggle a filter into the next page.
 */
export const cursorField = z
  .string()
  .trim()
  .max(512, 'That page reference is not valid.')
  .optional();

/**
 * A `true`/`false` query flag.
 *
 * `"1"` and `"0"` are accepted because a URL written by hand uses them, and
 * anything else is a `400` rather than a truthy coercion — `?verified=yes`
 * becoming `true` is how a "show only unverified" filter silently inverts.
 */
export const booleanField = z
  .string()
  .trim()
  .transform((raw) => {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return null;
  })
  .refine((value): value is boolean => value !== null, 'Use true or false.');

/**
 * A repeatable enum filter, as a comma list.
 *
 * `?status=new&status=old` and `?status=new,old` both reach this as an array,
 * because `parseSearchParams` collects repeats and the schema splits commas.
 * The dedupe matters: a caller that sends both forms gets 12 unique values, not
 * 12 with duplicates, and the cap below is on unique values.
 */
export function enumListField<T extends readonly [string, ...string[]]>(
  values: T,
  maxItems = 12,
) {
  return z
    .array(z.enum(values))
    .max(maxItems, `Choose at most ${maxItems}.`)
    .transform((items) => [...new Set(items)]);
}

/**
 * The sort direction, per endpoint. Never free text: an unknown sort key is a
 * missing index, and Firestore's answer to that is an `unauthenticated` error
 * that looks like a permissions problem.
 */
export const sortDirectionField = z.enum(['asc', 'desc']);

/**
 * A bounded integer arriving as a QUERY STRING.
 *
 * Every value in a URL is a string, so the coercion happens here rather than in
 * the body schema. A body number arriving as a string is a BUG and is rejected by
 * `boundedInt` with `invalid_type` — never coerced (docs/17 §2.4).
 *
 * Every intermediate is an explicit `refine`, never `.pipe()`, because a piped
 * `z.number()` reports `expected number, received NaN` for `?limit=abc`, which is
 * not a sentence anyone can act on.
 */
export function boundedIntFromQuery(min: number, max: number) {
  return z
    .string()
    .trim()
    .transform((raw) => Number(raw))
    .refine((value) => Number.isFinite(value), 'Enter a number.')
    .refine((value) => Number.isInteger(value), 'Enter a whole number.')
    .refine((value) => value >= min, `Must be at least ${min}.`)
    .refine((value) => value <= max, `Must be at most ${max}.`);
}

/**
 * A free-text search term.
 *
 * Bounded to three tokens (docs/17 §9, D-17-13). An unbounded search string is
 * a denial-of-service surface: a 60 KB `q` is a regex the database has to read
 * and a response nobody wanted.
 */
export const searchTermField = z
  .string()
  .trim()
  .min(1, 'Type something to search for.')
  .max(60, 'Keep the search under 60 characters.')
  .refine(
    (value) => value.split(/\s+/).filter(Boolean).length <= 3,
    'Use at most three words.',
  );

/**
 * The pagination pair, for a list route.
 *
 * `strictObject` so an unknown filter is a 400 rather than a silently ignored
 * parameter — a filter a client believes is applied and is not is worse than no
 * filter, because the results LOOK filtered (docs/17 §9).
 */
export const paginationShape = {
  limit: limitField.optional(),
  cursor: cursorField,
} as const;

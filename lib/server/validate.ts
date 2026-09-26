/**
 * ============================================================================
 * CareGrid AI — request validation
 * ============================================================================
 *
 * The one place a raw HTTP request becomes typed data. Everything a route
 * handler receives has been through here: the body, the query string, AND the
 * path parameters. Nothing downstream re-reads the raw request (docs/17 rule 4,
 * docs/06 §3.9).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE AND NOT A `.parse()` IN EACH ROUTE
 * ---------------------------------------------------------------------------
 * Four properties, none of which a route can be trusted to remember:
 *
 *   1. **Size is checked before the body is read.** A 4 MB body must cost one
 *      length comparison, not a 4 MB allocation and a `JSON.parse`. The
 *      Vercel platform cap of 4.5 MB is never the limit we want to hit, so the
 *      default here is 1 MB and a route can lower it (docs/17 §10).
 *   2. **Invalid JSON is a validation error, not a 500.** `JSON.parse` throwing
 *      is the single most common way a hand-written handler returns an HTML
 *      error page to a JSON client.
 *   3. **Field paths are dotted and index-aware.** `location.lat` and
 *      `media[1].sizeBytes`, so a form can put each message next to its input
 *      instead of showing one blob.
 *   4. **`Content-Type` is checked, not trusted.** A body arriving as
 *      `text/plain` with a JSON payload is still parsed — the field schema is
 *      the real contract. A `multipart/form-data` body on a JSON route is
 *      refused with `415`, because that IS a different contract (docs/17 §15
 *      anti-pattern 7).
 *
 * ---------------------------------------------------------------------------
 * PARAMS ARE VALIDATED TOO, AND IT IS NOT A SMALL DETAIL
 * ---------------------------------------------------------------------------
 * docs/17 §5.55: a `:id` that does not match its pattern is a **400**, not a
 * 404. A 404 says "this does not exist"; a 400 says "you sent nonsense". The
 * distinction is what lets a client tell a typo from a deleted record, and
 * getting it backwards makes a broken link look like missing data.
 */

import 'server-only';

import { type z } from 'zod';
import type { ZodError } from 'zod';

import { AppError } from '@/lib/server/errors';
import type { ApiErrorDetail } from '@/lib/api/envelope';

/**
 * `ApiErrorDetail` is declared ONCE, in `lib/api/envelope.ts`, derived from the
 * Zod schema beside it. This module used to declare a second, hand-written copy —
 * and a contract defined in two places is two contracts, and a change to one is
 * a bug in the other. Re-exported so `lib/server/route.ts` can keep importing it
 * from here.
 */
export type { ApiErrorDetail };

/** The 1 MB default. docs/17 §10. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Hard ceiling, whatever a route asks for.
 *
 * A route can lower `maxBytes` but not raise it past this. Evidence bytes never
 * travel through a function at all (uploads go direct to Storage, docs/15), so
 * nothing legitimate in this system needs a large JSON body, and a ceiling that
 * a route could raise is not a ceiling.
 */
export const ABSOLUTE_MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;

/* ========================================================================== */
/* Body                                                                       */
/* ========================================================================== */

/**
 * Read and validate a JSON body.
 *
 * An EMPTY body is `undefined` rather than a parse error, because a `POST` with
 * no body is legitimate for some routes and it is the SCHEMA that decides
 * whether that is acceptable — not the transport. A route that requires a body
 * declares one, and `.strict()` plus a required field produces the 400.
 */
export async function parseJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const maxBytes = clampMaxBytes(opts.maxBytes);

  // 1. Declared type, if there is one. Only `multipart/form-data` is refused:
  //    it is a genuinely different content model, and accepting it here would
  //    mean parsing a multipart body as JSON and failing confusingly.
  const contentType = req.headers.get('content-type') ?? '';
  if (/^\s*multipart\/form-data/i.test(contentType)) {
    throw new AppError({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'This endpoint accepts a JSON body, not a file upload.',
    });
  }

  // 2. Declared length, when the client sent one. Free, and it rejects the
  //    overwhelming majority of oversized requests before a byte is read.
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw tooLarge(maxBytes);
    }
  }

  // 3. Read the text. A body that turns out to be over the limit is caught by
  //    the byte-length check below, which is the authoritative one: a
  //    `Content-Length` header is a claim by the client, and this function
  //    exists precisely because client claims are not trusted.
  const text = await req.text();

  if (text.trim() === '') return undefined as z.output<S>;

  if (byteLength(text) > maxBytes) {
    throw tooLarge(maxBytes);
  }

  // 4. Parse. Wrapped, because a syntax error here is a 400 and not a 500.
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The request body was not valid JSON.',
      details: [{ field: 'body', issue: 'invalid_json' }],
      cause: error,
    });
  }

  return parseWithSchema(raw, schema, 'body');
}

/* ========================================================================== */
/* Query string                                                               */
/* ========================================================================== */

/**
 * Validate a query string.
 *
 * `URLSearchParams` loses the distinction between `?a=1&a=2` and a single `a`,
 * and it turns every value into a string. The coercion rules in docs/17 §2.4
 * are therefore applied by the SCHEMA, not here: a schema field declared as
 * `z.coerce.number()` receives the raw string and validates the result, and a
 * field declared as `z.string()` receiving `"3"` stays a string. Deciding that
 * in this function would mean guessing the schema's intent, and a guess that is
 * wrong in one direction is a type confusion bug.
 *
 * What this function owns is the REPEATED-KEY rule: `?status=new&status=old`
 * and `?status=new,old` both arrive as `['new','old']` here, and are handed to
 * the schema as an array for any key that appeared more than once. A schema
 * declaring `z.string()` for that key then fails with `invalid_type`, which is
 * the correct answer for a scalar that was sent twice with different values.
 */
export function parseSearchParams<S extends z.ZodType>(
  url: URL,
  schema: S,
): z.output<S> {
  const seen = new Map<string, string[]>();
  for (const [key, value] of url.searchParams) {
    const list = seen.get(key);
    if (list) list.push(value);
    else seen.set(key, [value]);
  }

  const raw: Record<string, unknown> = {};
  for (const [key, values] of seen) {
    raw[key] = values.length === 1 ? (values[0] ?? '') : values;
  }

  return parseWithSchema(raw, schema, 'query');
}

/* ========================================================================== */
/* Route parameters                                                           */
/* ========================================================================== */

/**
 * Validate Next.js dynamic route params.
 *
 * Next hands these over as `Record<string, string | string[]> | undefined` —
 * the array form happens for a repeatable catch-all like `[...slug]`, and a
 * schema for `:id` receiving `['a','b']` must fail rather than silently take
 * the first element. The schema's own `z.string()` does that.
 */
export function parseParams<S extends z.ZodType>(
  params: Record<string, string | string[] | undefined>,
  schema: S,
): z.output<S> {
  return parseWithSchema(params, schema, 'params');
}

/* ========================================================================== */
/* Zod issue formatting                                                       */
/* ========================================================================== */

/**
 * Flatten a `ZodError` into `{ field, issue }` pairs.
 *
 * `issue` is Zod's own machine token — `too_small`, `invalid_enum_value`,
 * `unrecognized_keys`, `custom` — never a rendered sentence, so the CLIENT
 * decides how to phrase it. That is what makes the envelope localisable without
 * a server change (docs/17 §12).
 */
export function formatZodIssues(error: ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => ({
    field: formatFieldPath(issue.path),
    issue: issue.message === '' ? issue.code : issue.message,
  }));
}

/**
 * A dotted, index-aware field path.
 *
 * `['media', 1, 'sizeBytes']` becomes `media[1].sizeBytes`, with the index
 * ONE-BASED because that is what the field's label says (docs/17 §11.2). A
 * zero-based index in an error message is a bug report.
 */
export function formatFieldPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return 'form';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment + 1}]`;
      continue;
    }
    out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/* ========================================================================== */
/* Internals                                                                  */
/* ========================================================================== */

/**
 * The one place a Zod failure becomes an `AppError`.
 *
 * A `superRefine` cross-field failure is reported with the machine code
 * `invalid_combination` rather than the author's message, for the same reason
 * `issue` is a token and not a sentence.
 */
function parseWithSchema<S extends z.ZodType>(raw: unknown, schema: S, where: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const error = parsed.error;
  const details = formatZodIssues(error).map((detail) =>
    detail.field === 'form' ? { field: where, issue: detail.issue } : detail,
  );

  throw new AppError({
    code: 'VALIDATION_FAILED',
    message: firstIssueSentence(error),
    details,
    cause: error,
  });
}

/**
 * The one-line summary. It names the FIRST field rather than counting
 * everything: "Check your email address" is actionable, "7 problems" is not.
 */
function firstIssueSentence(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Check the highlighted fields and try again.';
  const issue = first.message === '' ? 'that value is not valid.' : first.message;
  if (first.path.length === 0) return issue;
  return `Check ${first.path.join(' ')}: ${issue}`;
}

function tooLarge(maxBytes: number): AppError {
  return new AppError({
    code: 'REQUEST_TOO_LARGE',
    message: `That request is larger than this endpoint accepts (${maxKb(maxBytes)} KB).`,
    details: [{ field: 'body', issue: 'too_big' }],
  });
}

function clampMaxBytes(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_BODY_BYTES;
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_MAX_BODY_BYTES;
  return Math.min(ABSOLUTE_MAX_BODY_BYTES, Math.floor(requested));
}

function maxKb(bytes: number): string {
  return String(Math.round(bytes / 1024));
}

/**
 * UTF-8 byte length, not `.length`.
 *
 * `.length` counts UTF-16 code units, so a body of 900 multi-byte characters
 * measures 900 and a body of 1.2 MB of emoji measures 2.4 MB in the wire and
 * passes a limit that exists to bound memory. The real cost is bytes.
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

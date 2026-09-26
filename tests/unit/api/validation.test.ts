import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ABSOLUTE_MAX_BODY_BYTES,
  DEFAULT_MAX_BODY_BYTES,
  formatFieldPath,
  formatZodIssues,
  parseJsonBody,
  parseParams,
  parseSearchParams,
} from '@/lib/server/validate';
import { AppError } from '@/lib/server/errors';

/**
 * ============================================================================
 * The validation boundary
 * ============================================================================
 *
 * The properties asserted here are the ones a route cannot be trusted to
 * remember, which is why they live in one place (docs/17):
 *
 *   1. Size is checked BEFORE the body is read, and before any I/O.
 *   2. Invalid JSON is a 400, not a 500.
 *   3. `Content-Type` is checked, not trusted — except `multipart/form-data`,
 *      which really is a different contract.
 *   4. Unknown keys are rejected (`.strict()`), because `role` cannot ride along.
 *   5. Field paths are dotted and index-aware, ONE-BASED.
 *   6. A param failing its pattern is a 400, not a 404.
 *
 * Every failure path asserts the ERROR CODE, not the message. The message is
 * copy and is allowed to change; the code is the contract the client branches on.
 */

function jsonRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request('https://caregrid.test/api/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

/**
 * Run `fn` and return the `AppError` it threw.
 *
 * Takes a THUNK, not a promise, because `parseSearchParams` and `parseParams`
 * throw synchronously. Passing the call itself would let the throw escape before
 * this function was ever entered, which is a test bug that looks like a product
 * bug.
 */
function codeOf(fn: () => unknown): {
  code: string;
  status: number;
  message: string;
  details: ReadonlyArray<{ field: string; issue: string }>;
} {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) {
      return { code: error.code, status: error.status, message: error.message, details: error.details };
    }
    throw error;
  }
  throw new Error('expected the parse to throw, and it did not');
}

async function codeOfAsync(promise: Promise<unknown>): Promise<{
  code: string;
  status: number;
  message: string;
  details: ReadonlyArray<{ field: string; issue: string }>;
}> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return { code: error.code, status: error.status, message: error.message, details: error.details };
    }
    throw error;
  }
  throw new Error('expected the parse to throw, and it did not');
}


/* ========================================================================== */
/* Body                                                                        */
/* ========================================================================== */

describe('parseJsonBody', () => {
  const schema = z.object({ name: z.string().min(2), count: z.number().int() }).strict();

  it('returns the parsed value on the happy path', async () => {
    const parsed = await parseJsonBody(jsonRequest({ name: 'ok', count: 2 }), schema);
    expect(parsed).toEqual({ name: 'ok', count: 2 });
  });

  it('treats an EMPTY body as undefined, not as a parse error', async () => {
    // A `POST` with no body is legitimate for some routes, and it is the SCHEMA
    // that decides whether that is acceptable — not the transport.
    const parsed = await parseJsonBody(
      new Request('https://caregrid.test/api/x', { method: 'POST', body: '' }),
      schema.optional(),
    );
    expect(parsed).toBeUndefined();
  });

  it('turns invalid JSON into VALIDATION_FAILED, never a 500', async () => {
    // The single most common way a hand-written handler returns an HTML error
    // page to a JSON client.
    const result = await codeOfAsync(parseJsonBody(jsonRequest('{"name": '), schema));
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.status).toBe(400);
    expect(result.details).toEqual([{ field: 'body', issue: 'invalid_json' }]);
  });

  it('rejects an unknown key, so `role` cannot ride along', async () => {
    // The whole reason a request schema is `.strict()`: `role` is a property of
    // the TYPE, not a line in a handler someone could forget.
    const result = await codeOfAsync(parseJsonBody(jsonRequest({ name: 'ok', count: 1, role: 'admin' }), schema));
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.status).toBe(400);
  });

  it('rejects a body above the 1 MB default with 413 REQUEST_TOO_LARGE', async () => {
    // 413 and not 400 because the client can act on it: send a smaller payload.
    const oversized = { name: 'x'.repeat(DEFAULT_MAX_BODY_BYTES + 1024), count: 1 };
    const result = await codeOfAsync(parseJsonBody(jsonRequest(oversized), schema));
    expect(result.code).toBe('REQUEST_TOO_LARGE');
    expect(result.status).toBe(413);
    expect(result.details[0]?.field).toBe('body');
  });

  it('refuses a per-route ceiling ABOVE the absolute maximum', async () => {
    // A route that can raise the ceiling does not have one. Evidence bytes never
    // travel through a function in this system (uploads go direct to Storage), so
    // nothing legitimate needs a large JSON body.
    const oversized = { name: 'x'.repeat(ABSOLUTE_MAX_BODY_BYTES + 1024), count: 1 };
    const result = await codeOfAsync(
      parseJsonBody(jsonRequest(oversized), schema, { maxBytes: 64 * 1024 * 1024 }),
    );
    expect(result.code).toBe('REQUEST_TOO_LARGE');
  });

  it('honours a per-route ceiling BELOW the maximum', async () => {
    const result = await codeOfAsync(
      parseJsonBody(jsonRequest({ name: 'x'.repeat(4096), count: 1 }), schema, { maxBytes: 1024 }),
    );
    expect(result.code).toBe('REQUEST_TOO_LARGE');
  });

  it('measures UTF-8 BYTES, not UTF-16 code units', async () => {
    // `.length` counts code units, so 900 emoji measure 900 and a body of 2.4 MB
    // of emoji would pass a limit that exists to bound memory. The real cost is
    // bytes. This is the assertion that would fail with a naive `.length`.
    const emoji = { name: '\u{1F3E0}'.repeat(400), count: 1 };
    const result = await codeOfAsync(parseJsonBody(jsonRequest(emoji), schema, { maxBytes: 1024 }));
    expect(result.code).toBe('REQUEST_TOO_LARGE');
  });

  it('rejects a multipart body with 415, because that IS a different contract', async () => {
    const request = new Request('https://caregrid.test/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=xyz' },
      body: '--xyz--',
    });
    const result = await codeOfAsync(parseJsonBody(request, schema));
    expect(result.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(result.status).toBe(415);
  });

  it('does NOT trust Content-Type: a text/plain body with JSON is still parsed', async () => {
    // The field schema is the real contract. Trusting the header to decide
    // whether to parse is docs/17 §15 anti-pattern 7.
    const request = new Request('https://caregrid.test/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'ok', count: 3 }),
    });
    await expect(parseJsonBody(request, schema)).resolves.toEqual({ name: 'ok', count: 3 });
  });

  it('rejects an oversized declared Content-Length without reading the body', async () => {
    // A 4 MB body must cost one length comparison, not a 4 MB allocation.
    const request = new Request('https://caregrid.test/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '99999999' },
      body: JSON.stringify({ name: 'ok', count: 1 }),
    });
    const result = await codeOfAsync(parseJsonBody(request, schema, { maxBytes: 1024 }));
    expect(result.code).toBe('REQUEST_TOO_LARGE');
  });

  it('does not trust a LYING Content-Length — the byte count is authoritative', async () => {
    // The header is a claim by the client, and this function exists precisely
    // because client claims are not trusted.
    const request = new Request('https://caregrid.test/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '10' },
      body: JSON.stringify({ name: 'x'.repeat(8192), count: 1 }),
    });
    const result = await codeOfAsync(parseJsonBody(request, schema, { maxBytes: 1024 }));
    expect(result.code).toBe('REQUEST_TOO_LARGE');
  });
});

/* ========================================================================== */
/* Query                                                                       */
/* ========================================================================== */

describe('parseSearchParams', () => {
  it('rejects an unknown query parameter rather than ignoring it', async () => {
    // A filter a client believes is applied and is not is WORSE than no filter,
    // because the results look filtered.
    const schema = z.object({ limit: z.coerce.number().optional() }).strict();
    const url = new URL('https://caregrid.test/api/x?limit=10&sort=asc');
    const result = codeOf(() => parseSearchParams(url, schema));
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.status).toBe(400);
  });

  it('collapses a repeated key into an array so the schema decides', async () => {
    const schema = z.object({ status: z.array(z.enum(['new', 'closed'])) });
    const url = new URL('https://caregrid.test/api/x?status=new&status=closed');
    expect(parseSearchParams(url, schema)).toEqual({ status: ['new', 'closed'] });
  });

  it('fails a scalar field that was sent twice with different values', async () => {
    // A duplicate scalar is ambiguous, and the schema is what decides it is
    // ambiguous — not a guess made here.
    const schema = z.object({ sort: z.string() });
    const url = new URL('https://caregrid.test/api/x?sort=asc&sort=desc');
    const result = codeOf(() => parseSearchParams(url, schema));
    expect(result.code).toBe('VALIDATION_FAILED');
  });

  it('reports a query failure against the parameter name, not `form`', async () => {
    // A field path of `form` on a query parameter would send a developer looking
    // in the request body.
    const schema = z.object({ limit: z.coerce.number() }).strict();
    const url = new URL('https://caregrid.test/api/x?limit=abc');
    const result = codeOf(() => parseSearchParams(url, schema));
    expect(result.details[0]?.field).toBe('limit');
  });
});

/* ========================================================================== */
/* Params                                                                      */
/* ========================================================================== */

describe('parseParams', () => {
  const idSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9]{20}$/) });

  it('accepts a well-formed id', () => {
    expect(parseParams({ id: 'a'.repeat(20) }, idSchema)).toEqual({ id: 'a'.repeat(20) });
  });

  it('returns 400, NOT 404, for an id of the wrong shape', () => {
    // docs/17 §5.55. A 404 says "this does not exist"; a 400 says "you sent
    // nonsense". The distinction is what lets a client tell a typo from a
    // deleted record — getting it backwards makes a broken link look like
    // missing data.
    const result = codeOf(() => parseParams({ id: 'too-short' }, idSchema));
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.status).toBe(400);
  });

  it('fails an id that arrived as an array (a repeatable catch-all)', () => {
    // A schema for `:id` receiving `['a','b']` must FAIL, not silently take the
    // first element.
    const result = codeOf(() => parseParams({ id: ['a', 'b'] }, idSchema));
    expect(result.code).toBe('VALIDATION_FAILED');
  });

  it('accepts an undefined segment, so an optional param works', () => {
    const schema = z.object({ id: z.string().optional() });
    expect(parseParams({ id: undefined }, schema)).toEqual({ id: undefined });
  });
});

/* ========================================================================== */
/* Issue formatting                                                            */
/* ========================================================================== */

describe('formatFieldPath', () => {
  it('renders a one-based index, because the label says "item 1"', () => {
    // A zero-based index in an error message is a bug report. docs/17 §11.2.
    expect(formatFieldPath(['media', 0, 'sizeBytes'])).toBe('media[1].sizeBytes');
    expect(formatFieldPath(['media', 1, 'sizeBytes'])).toBe('media[2].sizeBytes');
  });

  it('renders a nested object path with dots', () => {
    expect(formatFieldPath(['location', 'lat'])).toBe('location.lat');
    expect(formatFieldPath(['notifPrefs', 'sms'])).toBe('notifPrefs.sms');
  });

  it('renders an empty path as `form`', () => {
    expect(formatFieldPath([])).toBe('form');
  });
});

describe('formatZodIssues', () => {
  it('reports every issue, not only the first', () => {
    // docs/17 §0 rule 9. A client that fixes one field at a time and a half is
    // a bad experience on a form with eight fields.
    const schema = z.object({ a: z.string().min(3), b: z.number() });
    const parsed = schema.safeParse({ a: '', b: 'x' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issues = formatZodIssues(parsed.error);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.map((i) => i.field)).toContain('a');
    expect(issues.map((i) => i.field)).toContain('b');
  });
});

/* ========================================================================== */
/* The single clamp                                                            */
/* ========================================================================== */

describe('there is exactly ONE clamp in the system (docs/17 §4.1)', () => {
  it('the limit field clamps above the maximum instead of failing', async () => {
    // The documented exception: a READ-ONLY LIST route clamps, and the effective
    // value is echoed. Everywhere else an over-max is a 400. Two clamps would
    // mean a client can no longer predict what it asked for.
    const { limitField, MAX_PAGE_SIZE } = await import('@/validators/query');
    expect(limitField.parse('500')).toBe(MAX_PAGE_SIZE);
    expect(limitField.parse('25')).toBe(25);
  });

  it('the limit field REJECTS rather than repairing a non-integer or non-positive', async () => {
    const { limitField } = await import('@/validators/query');
    for (const bad of ['abc', '0', '-1', '1.5', 'NaN', 'Infinity', '1,000']) {
      expect(limitField.safeParse(bad).success, `limit=${bad} should be rejected`).toBe(false);
    }
  });
});

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */


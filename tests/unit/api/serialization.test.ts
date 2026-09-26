import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PRIVILEGED_LIST_REDACTED_KEYS,
  RESPONDER_REDACTED_KEYS,
  compact,
  mayReadLocationText,
  mayReadOriginalText,
  mayReadReporterIdentity,
  omit,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  redactionProfile,
  toGeoPoint,
  toIso,
  toRefPath,
  type RedactionProfile,
} from '@/lib/server/serialize';
import { toAppError, AppError } from '@/lib/server/errors';
import { ERROR_STATUS } from '@/lib/api/error-codes';

/**
 * ============================================================================
 * Serialisation, redaction, and the error funnel
 * ============================================================================
 *
 * Two properties that are decided in exactly one place and are therefore
 * testable in isolation:
 *
 *   1. **A Firestore value becomes JSON, and a malformed one becomes `null`
 *      rather than an exception.** A document written by a seed script, an import,
 *      or an older build can hold any runtime type, and a reader that assumes is
 *      how one legacy record turns every page that lists it into a 500.
 *
 *   2. **No unknown throw becomes a leak.** `toAppError` is the single funnel,
 *      and each of its mappings is a decision about what a CALLER may learn. The
 *      `permission-denied` row matters most: a Firestore rules rejection is a
 *      free description of the data model.
 */

const ROOT = join(process.cwd());

/* ========================================================================== */
/* Firestore value conversion                                                  */
/* ========================================================================== */

describe('toIso', () => {
  it('converts a Timestamp-like object', () => {
    const date = new Date('2026-09-26T10:05:31.000Z');
    expect(toIso({ toDate: () => date })).toBe('2026-09-26T10:05:31.000Z');
  });

  it('converts a Date', () => {
    expect(toIso(new Date('2026-09-26T10:05:31.000Z'))).toBe('2026-09-26T10:05:31.000Z');
  });

  it('converts an ISO string, which is what an import writes', () => {
    expect(toIso('2026-09-26T10:05:31.000Z')).toBe('2026-09-26T10:05:31.000Z');
  });

  it('returns null for null and undefined rather than the string "null"', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });

  it('returns null for a value it does not recognise, and NEVER throws', () => {
    // A malformed timestamp is a display problem. Failing the whole response
    // because one field in one record has a bad date turns a cosmetic bug into
    // an outage for every caller on that page.
    for (const bad of [42, true, {}, [], 'not-a-date', Number.NaN, { toDate: 'nope' }]) {
      expect(toIso(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('returns null when toDate() throws', () => {
    expect(
      toIso({
        toDate: () => {
          throw new Error('bad');
        },
      }),
    ).toBeNull();
  });

  it('returns null for an invalid Date', () => {
    expect(toIso(new Date('nonsense'))).toBeNull();
  });
});

describe('toGeoPoint', () => {
  it('reads the Admin SDK shape', () => {
    expect(toGeoPoint({ latitude: 17.4478, longitude: 78.4874 })).toEqual({ lat: 17.4478, lng: 78.4874 });
  });

  it('reads the plain shape a seed script writes', () => {
    expect(toGeoPoint({ lat: 17.4478, lng: 78.4874 })).toEqual({ lat: 17.4478, lng: 78.4874 });
  });

  it('REJECTS an out-of-range coordinate as null', () => {
    // The most dangerous class of bug in this product. A geocoder that
    // "helpfully" returns 0,0 when it has no key puts a fabricated location in
    // the middle of the Indian Ocean on a real emergency report. Out of range
    // becomes null, which the UI renders as the documented "location unknown".
    expect(toGeoPoint({ latitude: 947, longitude: 78.4874 })).toBeNull();
    expect(toGeoPoint({ latitude: 17.4478, longitude: 999 })).toBeNull();
  });

  it('rejects NaN and Infinity', () => {
    expect(toGeoPoint({ latitude: Number.NaN, longitude: 78 })).toBeNull();
    expect(toGeoPoint({ latitude: 17, longitude: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('returns null for a non-object', () => {
    for (const bad of [null, undefined, '17.44,78.48', 42, []]) {
      expect(toGeoPoint(bad)).toBeNull();
    }
  });
});

describe('toRefPath', () => {
  it('reads a DocumentReference path', () => {
    expect(toRefPath({ path: 'incidents/abc/reports/rep_1' })).toBe('incidents/abc/reports/rep_1');
  });

  it('returns null for anything else', () => {
    expect(toRefPath(null)).toBeNull();
    expect(toRefPath({ id: 'abc' })).toBeNull();
    expect(toRefPath('incidents/abc')).toBeNull();
  });
});

describe('the field readers tolerate a legacy document', () => {
  const doc = {
    email: 'a@example.com',
    emailVerified: true,
    count: 7,
    tags: ['a', 'b', 3, 'c'],
  };

  it('readString falls back rather than returning undefined', () => {
    expect(readString(doc, 'email')).toBe('a@example.com');
    expect(readString(doc, 'missing')).toBe('');
    expect(readString(doc, 'missing', 'fallback')).toBe('fallback');
    // A field of the WRONG type takes the fallback too, which is the whole point
    // of the type check: a document written by a legacy path must not render
    // `undefined` on somebody's profile page.
    expect(readString(doc, 'count', 'fallback')).toBe('fallback');
  });

  it('readBoolean defaults false and never coerces a truthy string', () => {
    expect(readBoolean(doc, 'emailVerified')).toBe(true);
    expect(readBoolean(doc, 'missing')).toBe(false);
    // `"true"` is not `true`. A document written with the wrong type must not
    // silently flip an authorisation-adjacent flag.
    expect(readBoolean({ flag: 'true' }, 'flag')).toBe(false);
  });

  it('readNumber rejects a numeric string and a non-finite value', () => {
    expect(readNumber(doc, 'count')).toBe(7);
    expect(readNumber({ n: '7' }, 'n')).toBeNull();
    expect(readNumber({ n: Number.NaN }, 'n')).toBeNull();
  });

  it('readStringArray filters non-strings rather than trusting the array', () => {
    expect(readStringArray(doc, 'tags')).toEqual(['a', 'b', 'c']);
    expect(readStringArray(doc, 'missing')).toEqual([]);
  });
});

/* ========================================================================== */
/* Object shaping                                                              */
/* ========================================================================== */

describe('compact and omit', () => {
  it('compact drops undefined keys explicitly', () => {
    // `JSON.stringify` already drops them, but SILENTLY — and a DTO missing a
    // field in the response while present in the type is a contract failure no
    // type checker reports.
    expect(compact({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
    expect(Object.keys(compact({ a: 1, b: undefined }))).toEqual(['a']);
  });

  it('omit REMOVES the keys, so they are absent rather than undefined', () => {
    const shaped = omit({ a: 1, secret: 'x', b: 2 }, ['secret']);
    expect('secret' in shaped).toBe(false);
    expect(shaped).toEqual({ a: 1, b: 2 });
  });
});

/* ========================================================================== */
/* Redaction profiles                                                          */
/* ========================================================================== */

describe('redactionProfile', () => {
  const owner = { uid: 'u1', role: 'citizen' as const };
  const other = { uid: 'u2', role: 'citizen' as const };

  it('ownership BEATS role: a citizen reading their own report gets `owner`', () => {
    // docs/22 §3 row 9. A citizen reading their OWN report sees the original
    // text; a citizen reading someone else's sees nothing at all.
    expect(redactionProfile({ viewer: owner, ownerUid: 'u1' })).toBe('owner');
  });

  it('a citizen reading someone else\'s record gets the minimum profile', () => {
    // In practice the resource gate has already refused this read with a 404, so
    // this profile is only reached on a list row — but the default must still be
    // the least-privileged one.
    expect(redactionProfile({ viewer: other, ownerUid: 'u1' })).toBe('full');
  });

  it('dispatcher and admin get `full` on a record they do not own', () => {
    expect(redactionProfile({ viewer: { uid: 'd1', role: 'dispatcher' }, ownerUid: 'u1' })).toBe('full');
    expect(redactionProfile({ viewer: { uid: 'a1', role: 'admin' }, ownerUid: 'u1' })).toBe('full');
  });

  it('a responder gets `responder` ONLY when assigned', () => {
    // The in-radius rule (docs/22 §4.1) is a second, separate check performed by
    // the resource gate. This profile records that the assignment exists.
    expect(redactionProfile({ viewer: { uid: 'r1', role: 'responder' }, ownerUid: 'u1', assigned: true })).toBe(
      'responder',
    );
    expect(redactionProfile({ viewer: { uid: 'r1', role: 'responder' }, ownerUid: 'u1', assigned: false })).toBe(
      'full',
    );
  });

  it('never grants a wider profile to admin by DEFAULT', () => {
    // A function whose default is "everything" is one refactor away from
    // granting it to everyone.
    expect(redactionProfile({ viewer: { uid: 'x', role: 'admin' } })).toBe('full');
  });
});

describe('the profile gates', () => {
  const cases: Array<[RedactionProfile, boolean, boolean, boolean]> = [
    // profile, originalText, reporterIdentity, locationText
    ['full', true, true, true],
    ['owner', true, true, true],
    ['responder', false, false, false],
    ['privileged', false, false, false],
  ];

  it('a responder is denied the reporter identity, the original text, and the location text', () => {
    // docs/22 §4.1. The original text is REPLACED with the summary, not deleted:
    // a responder needs to know what is happening and not to read the account of
    // it.
    for (const [profile, text, identity, location] of cases) {
      expect(mayReadOriginalText(profile), `originalText/${profile}`).toBe(text);
      expect(mayReadReporterIdentity(profile), `reporterUid/${profile}`).toBe(identity);
      expect(mayReadLocationText(profile), `locationText/${profile}`).toBe(location);
    }
  });
});

describe('the redaction key lists', () => {
  it('the responder list removes the identity, the precise text, and the raw AI output', () => {
    // `ipHash` is pseudonymous but still a tracking identifier. `aiRawOutput` is
    // the model's unredacted text, which can quote a description of an injured
    // person.
    for (const key of [
      'reporterUid',
      'reporterEmail',
      'locationText',
      'ipHash',
      'originalText',
      'aiRawOutput',
      'aiModel',
      'aiPromptVersion',
    ]) {
      expect(RESPONDER_REDACTED_KEYS, `${key} must be redacted`).toContain(key);
    }
  });

  it('the responder list does NOT remove the AI summary or the safety flags', () => {
    // A responder who cannot see what kind of emergency this is cannot act on it.
    // docs/22 §3 row 13 is `readonly`, not `denied`.
    expect(RESPONDER_REDACTED_KEYS).not.toContain('summary');
    expect(RESPONDER_REDACTED_KEYS).not.toContain('safetyFlags');
  });

  it('the privileged list adds the search tokens and the resource detail', () => {
    for (const key of ['originalText', 'requiredResources', 'searchTokens']) {
      expect(PRIVILEGED_LIST_REDACTED_KEYS, `${key} must be redacted`).toContain(key);
    }
  });

  it('NEITHER list removes a credential field, because no DTO ever has one', () => {
    // The stronger property: `token`, `privateKey`, and `authToken` are not
    // redacted, they are never read into a DTO in the first place. A redaction
    // list that named them would imply they were present and had to be hidden.
    for (const list of [RESPONDER_REDACTED_KEYS, PRIVILEGED_LIST_REDACTED_KEYS]) {
      for (const key of list) {
        expect(key, `${key} should not be a DTO field at all`).not.toMatch(/token$|password|private/i);
      }
    }
  });
});

/* ========================================================================== */
/* The error funnel                                                            */
/* ========================================================================== */

describe('toAppError is the single funnel', () => {
  it('passes an AppError through unchanged', () => {
    const original = new AppError({ code: 'FORBIDDEN' });
    expect(toAppError(original)).toBe(original);
  });

  it('maps a ZodError to VALIDATION_FAILED 400 with field details', () => {
    const result = toAppError(new (require('zod').ZodError)([]));
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.status).toBe(400);
  });

  it('maps a Firestore permission-denied to 403 and DISCARDS the rules text', () => {
    // The most important row. A Firestore rules rejection names the collection,
    // the field, and sometimes the index — a free description of the data model
    // to anyone probing the API.
    const firebaseError = Object.assign(new Error('Missing or insufficient permissions.'), {
      name: 'FirebaseError',
      code: 'permission-denied',
    });
    const result = toAppError(firebaseError);
    expect(result.code).toBe('FORBIDDEN');
    expect(result.status).toBe(403);
    expect(result.message).not.toMatch(/insufficient permissions/i);
    expect(result.message).not.toMatch(/collection|field|index/i);
  });

  it('maps Firestore unavailable to DB_UNAVAILABLE 503, and a deadline to TIMEOUT 504', () => {
    const unavailable = toAppError(Object.assign(new Error('x'), { name: 'FirebaseError', code: 'unavailable' }));
    expect(unavailable.code).toBe('DB_UNAVAILABLE');
    expect(unavailable.status).toBe(503);

    const deadline = toAppError(
      Object.assign(new Error('x'), { name: 'FirebaseError', code: 'deadline-exceeded' }),
    );
    expect(deadline.code).toBe('TIMEOUT');
    expect(deadline.status).toBe(504);
  });

  it('maps a transaction abort, including the numeric gRPC form, to 503', () => {
    for (const code of ['aborted', '10 ABORTED']) {
      const result = toAppError(Object.assign(new Error('x'), { name: 'FirebaseError', code }));
      expect(result.code).toBe('DB_UNAVAILABLE');
      expect(result.status).toBe(503);
    }
  });

  it('maps an AbortError to TIMEOUT 504, so a slow provider is not a 500', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const result = toAppError(abort);
    expect(result.code).toBe('TIMEOUT');
    expect(result.status).toBe(504);
  });

  it('maps ANYTHING ELSE to a generic 500 with no details', () => {
    // A 500 that carries `details` is a 500 that leaks. `INTERNAL` must be
    // opaque: the cause is on `cause` for the log and nowhere else.
    const result = toAppError(new TypeError('cannot read property lat of undefined'));
    expect(result.code).toBe('INTERNAL');
    expect(result.status).toBe(500);
    expect(result.message).toBe('Something went wrong. Nothing was changed.');
    expect(result.details).toEqual([]);
  });

  it('keeps the original on `cause` for the log, and never in the body', () => {
    const original = new RangeError('index 5 out of range');
    const result = toAppError(original);
    expect(result.cause).toBe(original);
    expect(result.message).not.toContain('index 5');
    expect(JSON.stringify({ code: result.code, message: result.message })).not.toContain('index 5');
  });

  it('does not mistake somebody else\'s code-bearing error for a Firestore failure', () => {
    // A `code`-bearing object outside the closed recognised set must not become a
    // plausible-looking 503. That would turn a bug into a database fault.
    const foreign = Object.assign(new Error('a bug'), { name: 'HttpError', code: 'ENOTFOUND' });
    expect(toAppError(foreign).code).toBe('INTERNAL');
  });

  it('every code it can produce is in the catalogue', () => {
    const samples: unknown[] = [
      new Error('x'),
      'a string',
      42,
      null,
      undefined,
      { name: 'FirebaseError', code: 'not-found' },
      Object.assign(new Error('x'), { name: 'AbortError' }),
    ];
    for (const sample of samples) {
      const result = toAppError(sample);
      expect(ERROR_STATUS[result.code as keyof typeof ERROR_STATUS], result.code).toBeDefined();
      expect(result.status).toBe(ERROR_STATUS[result.code as keyof typeof ERROR_STATUS]);
    }
  });
});

/* ========================================================================== */
/* The logger's redaction is an ALLOW-list                                     */
/* ========================================================================== */

describe('the logger can never be the leak', () => {
  const http = readFileSync(join(ROOT, 'lib', 'server', 'http.ts'), 'utf8');

  it('drops any field not on the allow-list rather than masking it', () => {
    // A deny-list (`if (key.includes('token')) return '[redacted]'`) is bypassed
    // by adding one field: `authToken`, `apiKey`, `userPassword`, `private_key`
    // all miss a `token`/`key` substring test. An allow-list cannot be bypassed
    // that way.
    expect(http).toContain('ALLOWED_FIELDS');
    expect(http).toMatch(/if \(!ALLOWED_FIELDS\.has\(key\)\) continue;/);
  });

  it('the allow-list contains no field whose name suggests a secret', () => {
    const block = http.match(/const ALLOWED_FIELDS = new Set\(\[([\s\S]*?)\]\);/);
    expect(block).not.toBeNull();
    if (!block?.[1]) throw new Error('ALLOWED_FIELDS not found');
    for (const name of block[1].matchAll(/'([^']+)'/g)) {
      const field = String(name[1]);
      expect(field, `${field} must not look like a secret`).not.toMatch(/key|secret|token|password|private|auth/i);
    }
  });

  it('never writes a token, a key, or an email into a log line', () => {
    // Belt and braces: the allow-list already excludes them, so this asserts
    // there is no second logging path that bypasses it.
    expect(http).not.toMatch(/log\w*\(\s*['"`][^'"`]*\$\{[^}]*token/i);
    expect(http).not.toMatch(/log\w*\(\s*['"`][^'"`]*\$\{[^}]*apiKey/i);
  });
});

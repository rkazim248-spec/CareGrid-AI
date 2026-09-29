import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MEDIA,
  ALLOWED_MEDIA_TYPES,
  FINAL_PATH_RE,
  MEDIA_ID_ALPHABET,
  MEDIA_ID_RE,
  MEDIA_LIMITS,
  STAGING_PATH_RE,
  looksLikePathEscape,
  mediaIdOk,
  quarantinePathFor,
  stagingPathFor,
  finalPathFor,
  validateMediaPath,
} from '@/validators/upload';
import { safeDownloadName } from '@/services/uploads/evidence-storage';
import { generateMediaId } from '@/services/uploads/sign-upload';

const UID = 'abc123XYZ_-';
const MEDIA = 'med_ABCDEFGH2345';

/* ========================================================================== */

describe('the allow-list is exactly the six documented values', () => {
  it('is six, and no more', () => {
    expect(ALLOWED_MEDIA_TYPES).toHaveLength(6);
    expect([...ALLOWED_MEDIA_TYPES].sort()).toEqual([
      'audio/mp4',
      'audio/mpeg',
      'audio/webm',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('carries the documented caps — 5 MB images, 15 MB audio (docs/15 §7.1)', () => {
    for (const [type, entry] of Object.entries(ALLOWED_MEDIA)) {
      expect(entry.maxBytes, type).toBe(entry.kind === 'image' ? 5_242_880 : 15_728_640);
    }
  });

  it('the SVG and HTML refusals are structural, not a special case', () => {
    // They are absent from the table, which is the whole mechanism. There is no
    // denylist to keep in step with the allowlist, so it cannot drift.
    expect(ALLOWED_MEDIA_TYPES).not.toContain('image/svg+xml');
    expect(ALLOWED_MEDIA_TYPES).not.toContain('text/html');
  });
});

/* ========================================================================== */

describe('mediaId', () => {
  it('accepts the documented shape', () => {
    expect(MEDIA_ID_RE.test(MEDIA)).toBe(true);
    expect(MEDIA_ID_RE.test('med_ABCDEFGH234')).toBe(false);
    expect(MEDIA_ID_RE.test('med_ABCDEFGH23456')).toBe(false);
  });

  it('rejects lowercase base32, which the alphabet excludes', () => {
    expect(mediaIdOk('med_abcdefgh2345')).toBe(false);
  });

  it('excludes the 0/1/8/9 that base32 leaves out, and keeps the letters', () => {
    // RFC 4648 base32 is `A-Z` + `2-7`. The digits 0, 1, 8 and 9 never appear —
    // they are the ones a human misreads as letters when copying an id out of a
    // console listing. I, L and O *are* symbols and must be accepted.
    for (const bad of ['0', '1', '8', '9']) {
      expect(MEDIA_ID_ALPHABET, `base32 must not contain ${bad}`).not.toContain(bad);
    }
    for (const good of ['I', 'L', 'O']) {
      expect(MEDIA_ID_ALPHABET, `base32 must contain ${good}`).toContain(good);
    }
    expect(mediaIdOk('med_ABCDEFGH23I5')).toBe(true);
    expect(mediaIdOk('med_ABCDEFGH2315')).toBe(false);
  });

  it('generates ids that satisfy its own regex — the loop is closed', () => {
    // Phase 4's lesson: an assertion helper that derives its alphabet from the
    // same private constant proves nothing. This generates from the REAL generator
    // and checks against the REAL regex, so a change to either that breaks the
    // other fails here.
    for (let i = 0; i < 500; i += 1) {
      expect(mediaIdOk(generateMediaId()), `iteration ${i}`).toBe(true);
    }
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateMediaId()));
    expect(ids.size).toBe(1000);
  });
});

/* ========================================================================== */

describe('the path contract — the three legal shapes and nothing else', () => {
  it('accepts a staging path for its own uid', () => {
    const path = stagingPathFor(UID, MEDIA, 'jpg');
    expect(path).toBe(`staging/${UID}/${MEDIA}.jpg`);
    expect(STAGING_PATH_RE.test(path)).toBe(true);
    expect(validateMediaPath(path, UID)).toEqual({
      shape: 'staging',
      uid: UID,
      mediaId: MEDIA,
      ext: 'jpg',
    });
  });

  it('accepts a final path under reports/ and supplements/', () => {
    const incidentId = 'a'.repeat(20);
    const reportId = 'rpt123';
    for (const sub of ['reports', 'supplements'] as const) {
      const path = finalPathFor(incidentId, reportId, MEDIA, 'png', sub);
      expect(FINAL_PATH_RE.test(path), path).toBe(true);
      expect(validateMediaPath(path, UID)).toMatchObject({ shape: 'final', incidentId, sub, reportId });
    }
  });

  it('accepts a quarantine path', () => {
    const path = quarantinePathFor(MEDIA, 'webm');
    expect(validateMediaPath(path, UID)).toMatchObject({ shape: 'quarantine', mediaId: MEDIA, ext: 'webm' });
  });
});

/* ========================================================================== */

describe('a CLIENT FILENAME CAN NEVER BE A PATH — docs/15 §3.5', () => {
  // This is the load-bearing claim of the whole path design. Each case is a real
  // filename shape a citizen or an attacker would produce.

  it.each([
    ['a camera filename', 'IMG_20260926_101530.jpg'],
    ['a name with spaces', 'my accident photo.jpg'],
    ['a Windows path', 'C:\\Users\\me\\photo.jpg'],
    ['a name with a slash', 'photos/fire.jpg'],
    ['a name with unicode', '🔥 fire 🔥.jpg'],
    ['a 300-character name', `${'a'.repeat(300)}.jpg`],
    ['a name with a null byte', 'evil\0.jpg'],
    ['a name with a newline', 'evil\n.jpg'],
  ])('rejects %s', (_label, name) => {
    expect(validateMediaPath(name, UID), name).toBeNull();
  });

  it('a path traversal is rejected even with a valid-looking id', () => {
    expect(validateMediaPath(`staging/${UID}/../../../etc/passwd`, UID)).toBeNull();
    expect(validateMediaPath(`staging/${UID}/%2e%2e%2f%2e%2e%2fetc`, UID)).toBeNull();
  });

  it('a doubled slash and a leading slash are rejected', () => {
    expect(validateMediaPath(`staging//${UID}/${MEDIA}.jpg`, UID)).toBeNull();
    expect(validateMediaPath(`/staging/${UID}/${MEDIA}.jpg`, UID)).toBeNull();
  });

  it('a backslash is a traversal, because Windows and GCS treat it as a separator', () => {
    // `a\..\b` matches none of the three regexes, so this is defence in depth —
    // but it is the case a naive `includes('..')` check alone would miss, because
    // it has no forward slash at all.
    expect(looksLikePathEscape('a\\..\\b')).toBe(true);
  });

  it('a malformed percent-escape is a rejection, not a crash', () => {
    expect(looksLikePathEscape('staging/%zz/x')).toBe(true);
  });
});

/* ========================================================================== */

describe('OWNERSHIP IS A SEGMENT COMPARISON, NOT A PREFIX', () => {
  it('a uid cannot claim another uid\'s uploads', () => {
    const alicePath = stagingPathFor('alice', MEDIA, 'jpg');
    // Bob asking for Alice's path. This must be `null`.
    expect(validateMediaPath(alicePath, 'bob')).toBeNull();
  });

  it('a uid that is a PREFIX of the owner cannot claim it', () => {
    // The bug a `startsWith` would have. `abc` must not own `abcdef`'s uploads.
    expect(validateMediaPath(stagingPathFor('abcdef', MEDIA, 'jpg'), 'abc')).toBeNull();
  });

  it('and a uid that is an EXTENSION of the owner cannot either', () => {
    expect(validateMediaPath(stagingPathFor('abc', MEDIA, 'jpg'), 'abcdef')).toBeNull();
  });

  it('the owner is accepted', () => {
    expect(validateMediaPath(stagingPathFor('abcdef', MEDIA, 'jpg'), 'abcdef')).not.toBeNull();
  });
});

/* ========================================================================== */

describe('validateMediaPath returns null rather than throwing', () => {
  // A validator that throws cannot be used in a `for` loop over a report's media
  // array without every iteration being wrapped, and a forgotten wrapper turns
  // one bad item into a rejected report. docs/15 §5.3 requires per-item drop.

  it.each([
    ['a non-string', 42 as unknown as string],
    ['an empty string', ''],
    ['an absurdly long string', 'a'.repeat(2000)],
    ['undefined', undefined as unknown as string],
  ])('handles %s', (_label, value) => {
    expect(() => validateMediaPath(value, UID)).not.toThrow();
    expect(validateMediaPath(value, UID)).toBeNull();
  });
});

/* ========================================================================== */

describe('the count limits are stated once (docs/15 §7.1)', () => {
  it('three images and one clip means a TOTAL of three, not four', () => {
    // The constraint is real and easy to get wrong in a validator: a report with
    // audio may carry at most two images. Stating `maxTotalPerReport` is what
    // stops a validator and a UI disagreeing about whether a fourth item fits.
    expect(MEDIA_LIMITS.maxImagesPerReport).toBe(3);
    expect(MEDIA_LIMITS.maxAudioPerReport).toBe(1);
    expect(MEDIA_LIMITS.maxTotalPerReport).toBe(3);
  });

  it('the audio duration cap is the documented 120 s', () => {
    expect(MEDIA_LIMITS.maxAudioDurationSec).toBe(120);
  });
});

/* ========================================================================== */

describe('safeDownloadName cannot inject a header', () => {
  it('strips a CR and an LF, which is response splitting', () => {
    // The name is client-influenced (it is the citizen's filename) and it lands
    // in a `Content-Disposition` header. A CRLF here is a header injection.
    const result = safeDownloadName('photo\r\nSet-Cookie: admin=1.jpg');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
  });

  it('strips a quote, which would end the filename parameter early', () => {
    expect(safeDownloadName('a".jpg')).not.toContain('"');
  });

  it('strips a backslash and a forward slash', () => {
    expect(safeDownloadName('a\\b/c.jpg')).not.toContain('\\');
    expect(safeDownloadName('a\\b/c.jpg')).not.toContain('/');
  });

  it('strips control characters', () => {
    expect(safeDownloadName('a bc.jpg')).toBe('abc.jpg');
  });

  it('falls back to a name rather than returning an empty header value', () => {
    expect(safeDownloadName('')).toBe('evidence');
    expect(safeDownloadName(' ')).toBe('evidence');
  });

  it('caps the length', () => {
    expect(safeDownloadName(`${'a'.repeat(500)}.jpg`).length).toBeLessThanOrEqual(100);
  });

  it('leaves a legitimate name recognisable', () => {
    // The point of keeping the name at all is that a dispatcher sees "accident.jpg"
    // rather than "med_A2F3K9QZ7M4C.jpg". A sanitiser that destroys legibility
    // has defeated its own purpose.
    expect(safeDownloadName('road accident photo.jpg')).toBe('road accident photo.jpg');
  });
});

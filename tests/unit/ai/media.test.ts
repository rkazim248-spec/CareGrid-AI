/**
 * ============================================================================
 * Evidence image validation — `services/ai/media.ts`
 * ============================================================================
 *
 * brief §11: "Do NOT trust client-provided MIME types alone. Validate file type,
 * file size, file extension, content type. Reject unsupported files."
 *
 * The suite's organising claim is that the SIGNATURE decides and the other two
 * signals must agree with it. Every case below is a file that a validator
 * trusting the declared type or the extension would have accepted.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_IMAGE_SIGNATURES,
  ImageValidationError,
  MAX_IMAGE_BYTES,
  REJECTED_IMAGE_FORMATS,
  decodeBase64,
  encodeBase64,
  fitImagesToBudget,
  splitDataUrl,
  validateImage,
  type ValidatedImage,
} from '@/services/ai/media';

/** Minimal real file prefixes. Enough for a signature check, which is all we do. */
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];// An SVG is built from TEXT in the rejection test rather than from a byte
// constant, because an SVG is a text file — that is the entire point of the test.
const ZIP_HEADER = [0x50, 0x4b, 0x03, 0x04];
const GIF_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

function bytes(prefix: readonly number[], total = 64): Uint8Array {
  const out = new Uint8Array(total);
  out.set(prefix, 0);
  return out;
}

const base64Of = (b: Uint8Array): string => encodeBase64(b);

/* ========================================================================== */
/* Accepted formats                                                             */
/* ========================================================================== */

describe('accepted formats, decided by their byte signature', () => {
  it.each([
    ['PNG', PNG_HEADER, 'image/png', 'photo.png'],
    ['JPEG', JPEG_HEADER, 'image/jpeg', 'photo.jpg'],
    ['WebP', WEBP_HEADER, 'image/webp', 'photo.webp'],
  ])('accepts a real %s', (_name, header, mimeType, fileName) => {
    const image = validateImage({ data: bytes(header), fileName });
    expect(image.mimeType).toBe(mimeType);
    expect(image.byteLength).toBe(64);
    expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts every JPEG marker variant, not only the JFIF/EXIF family', () => {
    // `FF D8 FF` is the correct check. The first version of this table masked the
    // fourth byte to 0xF0, which accepts only `Exx` and therefore rejects a
    // DQT-first JPEG (0xDB) and an Adobe-encoded one (0xEE) — both real encodings.
    // A test that only tried E0 and E1 would have passed on the broken signature.
    for (const marker of [0xe0, 0xe1, 0xdb, 0xc0, 0xc4, 0xee, 0xfe]) {
      const header = [0xff, 0xd8, 0xff, marker, 0x00, 0x10];
      expect(
        validateImage({ data: bytes(header), fileName: 'p.jpg' }).mimeType,
        `JPEG marker 0x${marker.toString(16)} was rejected`,
      ).toBe('image/jpeg');
    }
  });

  it('accepts a WebP with ANY file-length field, because the length varies', () => {
    // The bug this table's `tail` note describes. Bytes 4-7 of a RIFF container
    // are the payload size, so a signature spanning them either hard-codes a
    // length or masks it to zeros — and both reject every real photograph, whose
    // size is never zero. The first version of this table did exactly that.
    for (const sizeBytes of [
      [0x00, 0x00, 0x00, 0x00],
      [0x10, 0x00, 0x00, 0x00],
      [0xff, 0xff, 0x00, 0x00],
      [0x9a, 0x3f, 0x01, 0x00],
    ]) {
      const header = [0x52, 0x49, 0x46, 0x46, ...sizeBytes, 0x57, 0x45, 0x42, 0x50];
      expect(
        validateImage({ data: bytes(header), fileName: 'p.webp' }).mimeType,
        `WebP with length ${sizeBytes.join(',')} was rejected`,
      ).toBe('image/webp');
    }
  });

  it('rejects a RIFF file that is NOT WebP', () => {
    // `RIFF` alone is a container for WAV and AVI too. The tail is what
    // distinguishes them, and a validator that stopped at `RIFF` would accept an
    // audio file as evidence.
    const wav = [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
    expect(() => validateImage({ data: bytes(wav), fileName: 'a.webp' })).toThrow(ImageValidationError);
  });

  it('rejects a RIFF file too short to carry its tail', () => {
    // Reading past the end would compare `undefined` against a byte; the length
    // check has to come first.
    expect(() => validateImage({ data: bytes([0x52, 0x49, 0x46, 0x46], 6), fileName: 'a.webp' })).toThrow(
      ImageValidationError,
    );
  });

  it('accepts a data URL and reads the declared type from it', () => {
    const url = `data:image/png;base64,${base64Of(bytes(PNG_HEADER))}`;
    const image = validateImage({ data: url });
    expect(image.mimeType).toBe('image/png');
  });
});

/* ========================================================================== */
/* Rejections — the cases a trusting validator would accept                     */
/* ========================================================================== */

describe('rejects what a MIME-type or extension check would have accepted', () => {
  it('rejects an SVG, which is a text file that can contain <script>', () => {
    // The most important rejection in this file. `<?xml v` is plain text, so an
    // extension check sees `.svg`, a naive type check sees `image/svg+xml`, and
    // only the signature reveals it is not one of ours.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(() => validateImage({ data: svg, fileName: 'evidence.svg' })).toThrow(ImageValidationError);
    expect(() => validateImage({ data: svg, fileName: 'evidence.svg' })).toThrow(/only png, jpeg and webp/i);
  });

  it('names SVG in the rejection reasons, so the decision is on the record', () => {
    expect(REJECTED_IMAGE_FORMATS.svg).toMatch(/script/i);
    expect(Object.keys(REJECTED_IMAGE_FORMATS).length).toBeGreaterThan(3);
  });

  it('rejects a ZIP renamed to .jpg — the classic polyglot', () => {
    expect(() =>
      validateImage({ data: bytes(ZIP_HEADER), fileName: 'innocent.jpg', declaredMimeType: 'image/jpeg' }),
    ).toThrow(ImageValidationError);
  });

  it('rejects a GIF, which is on the rejected list for a reason', () => {
    expect(() => validateImage({ data: bytes(GIF_HEADER), fileName: 'funny.gif' })).toThrow(
      ImageValidationError,
    );
  });

  it('rejects an empty file', () => {
    expect(() => validateImage({ data: new Uint8Array(0) })).toThrow(/empty/i);
  });

  it('rejects a file shorter than any signature', () => {
    expect(() => validateImage({ data: bytes([0xff, 0xd8]) })).toThrow(ImageValidationError);
  });
});

/* ========================================================================== */
/* The three signals must agree                                                 */
/* ========================================================================== */

describe('the declared type and the extension must AGREE with the signature', () => {
  it('rejects a declared type that contradicts the bytes', () => {
    // The signature is the fact; a contradiction is a rejection, not a correction.
    // Accepting either when they disagree is how a polyglot gets in.
    expect(() =>
      validateImage({ data: bytes(PNG_HEADER), declaredMimeType: 'image/jpeg', fileName: 'a.png' }),
    ).toThrow(/really image\/png but was declared as image\/jpeg/i);
  });

  it('tolerates the image/jpg alias, which browsers and filesystems disagree about', () => {
    // `image/jpg` is not a registered type, so rejecting it fails a legitimate
    // report for a naming detail.
    expect(validateImage({ data: bytes(JPEG_HEADER), declaredMimeType: 'image/jpg', fileName: 'a.jpg' }).mimeType)
      .toBe('image/jpeg');
  });

  it('rejects an extension that contradicts the bytes', () => {
    // A reviewer reading the filename is a real control: `.png` containing JPEG
    // bytes is mis-decoded by anything that trusts the extension.
    expect(() => validateImage({ data: bytes(JPEG_HEADER), fileName: 'evidence.png' })).toThrow(
      /filename says "\.png"/i,
    );
  });

  it('accepts a missing or extensionless name', () => {
    // A `File` from a camera capture often has no name, and an absent name is not
    // evidence of anything.
    expect(validateImage({ data: bytes(PNG_HEADER) }).fileName).toBe('image');
    expect(validateImage({ data: bytes(PNG_HEADER), fileName: 'capture' }).fileName).toBe('capture');
  });

  it('strips a directory component from the name', () => {
    // A Windows path in a name must not become part of the recorded filename.
    expect(validateImage({ data: bytes(PNG_HEADER), fileName: 'C:\\Users\\me\\a.png' }).fileName).toBe('a.png');
  });
});

/* ========================================================================== */
/* Size                                                                        */
/* ========================================================================== */

describe('size is checked on the DECODED length, before base64', () => {
  it('accepts a file at exactly the ceiling', () => {
    const big = bytes(PNG_HEADER, 1000);
    expect(validateImage({ data: big, fileName: 'a.png' }, 1000).byteLength).toBe(1000);
  });

  it('rejects a file one byte over', () => {
    expect(() => validateImage({ data: bytes(PNG_HEADER, 1001), fileName: 'a.png' }, 1000)).toThrow(
      /the limit is/i,
    );
  });

  it('names the size in megabytes, so the error is actionable', () => {
    // 7 MB against a 5 MB ceiling. An earlier version of this test used 2 MB,
    // which is UNDER the limit — it passed for the wrong reason on a run where
    // the assertion happened to be skipped.
    expect(() => validateImage({ data: bytes(PNG_HEADER, 7 * 1024 * 1024), fileName: 'a.png' })).toThrow(
      /the limit is 5 mb/i,
    );
  });

  it('accepts a file just UNDER the ceiling, so the bound is not off by one', () => {
    expect(() => validateImage({ data: bytes(PNG_HEADER, 4 * 1024 * 1024), fileName: 'a.png' })).not.toThrow();
  });

  it('reports the wrong format BEFORE the size, so the error names the real problem', () => {
    // A 40 MB file that is really a zip should be reported as the wrong format.
    // Checking size first would tell a user to make the file smaller when making
    // it smaller cannot help.
    const hugeBogus = bytes(ZIP_HEADER, 40 * 1024 * 1024);
    expect(() => validateImage({ data: hugeBogus, fileName: 'a.jpg' })).toThrow(/only png, jpeg and webp/i);
  });

  it('has a documented default ceiling', () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });
});

/* ========================================================================== */
/* Base64 helpers                                                               */
/* ========================================================================== */

describe('base64 helpers round-trip', () => {
  it('encodes and decodes', () => {
    const original = bytes(PNG_HEADER, 128);
    expect(decodeBase64(encodeBase64(original))).toEqual(original);
  });

  it('handles the high byte values a PNG signature contains', () => {
    // 0x89 is not valid ASCII, which is the case a naive `charCodeAt`/`fromCharCode`
    // round trip gets wrong.
    expect(decodeBase64(encodeBase64(new Uint8Array([0, 127, 128, 200, 255])))).toEqual(
      new Uint8Array([0, 127, 128, 200, 255]),
    );
  });

  it('splitDataUrl handles a bare base64 string and a malformed one', () => {
    expect(splitDataUrl('abc')).toEqual({ declaredMime: null, data: 'abc' });
    expect(splitDataUrl('data:image/png;base64,XYZ')).toEqual({ declaredMime: 'image/png', data: 'XYZ' });
  });
});

/* ========================================================================== */
/* The inline budget                                                            */
/* ========================================================================== */

describe('the inline budget drops from the END and records it', () => {
  const image = (name: string, bytesLong: number): ValidatedImage => ({
    mimeType: 'image/png',
    base64: 'A'.repeat(Math.ceil(bytesLong / 0.75)),
    sha256: 'x'.repeat(64),
    byteLength: bytesLong,
    fileName: name,
  });

  it('keeps everything when it fits', () => {
    const result = fitImagesToBudget([image('a.png', 1000), image('b.png', 1000)], 10_000);
    expect(result.kept).toHaveLength(2);
    expect(result.droppedFileNames).toEqual([]);
  });

  it('drops the LAST image first, because the first is the one that matters', () => {
    const result = fitImagesToBudget([image('a.png', 6000), image('b.png', 6000)], 8000);
    expect(result.kept.map((i) => i.fileName)).toEqual(['a.png']);
    expect(result.droppedFileNames).toEqual(['b.png']);
  });

  it('records every drop, because silent truncation is a lie', () => {
    // docs/09 §4.2: "Dropping is logged, never silent." A model that saw one of
    // three photos must not appear to have seen three.
    const result = fitImagesToBudget(
      [image('a.png', 5000), image('b.png', 5000), image('c.png', 5000)],
      6000,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.droppedFileNames).toEqual(['b.png', 'c.png']);
  });

  it('never returns ZERO images when it was given some', () => {
    // "The model saw nothing" is worse than "the model saw a big one": with no
    // image at all the report is triaged as text-only and the caller cannot tell
    // that evidence existed. The caller is told either way, which is the property
    // that matters — but returning an empty list when images were supplied would
    // be a silent lie about the evidence.
    const result = fitImagesToBudget([image('huge.png', 20_000_000)], 1000);
    expect(result.kept).toHaveLength(1);
  });

  it('handles an empty input', () => {
    expect(fitImagesToBudget([], 1000)).toEqual({ kept: [], droppedFileNames: [] });
  });
});

/* ========================================================================== */
/* The signature table itself                                                   */
/* ========================================================================== */

describe('the signature table', () => {
  it('declares the extensions for each accepted format', () => {
    for (const signature of ACCEPTED_IMAGE_SIGNATURES) {
      expect(signature.extensions.length).toBeGreaterThan(0);
      expect(signature.bytes.length).toBeGreaterThan(0);
      expect(signature.mimeType.startsWith('image/')).toBe(true);
    }
  });

  it('lists JPEG with both spellings, because both are in the wild', () => {
    const jpeg = ACCEPTED_IMAGE_SIGNATURES.find((s) => s.mimeType === 'image/jpeg');
    expect(jpeg?.extensions).toEqual(['jpg', 'jpeg']);
  });
});

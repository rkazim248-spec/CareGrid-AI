/**
 * ============================================================================
 * CareGrid AI — the media sniffer
 * ============================================================================
 *
 * docs/15 §5.2. `detectMediaType()`. **PURE** — no network, no Admin SDK, no clock,
 * no randomness. It takes bytes and returns what they are.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE MOST IMPORTANT FUNCTION IN PHASE 5
 * ---------------------------------------------------------------------------
 * Everything else in the upload chain checks a CLAIM: the size the client said, the
 * content type the client declared, the filename the client chose. This one reads
 * the bytes. A citizen attaching a photo is not an attacker; a modified client is,
 * and the only input an attacker fully controls is the file content.
 *
 * So the rule is docs/15 §5.3's, and it has a direction that is easy to get
 * backwards: **the SNIFFED type wins.** The declared type is never stored, never
 * trusted, and a disagreement is a hard failure for that media item.
 *
 * ---------------------------------------------------------------------------
 * WHAT A MATCH PROVES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * docs/15 §5.4 answers this at length and the answer is the honest position, so it
 * is restated here rather than left to the reader:
 *
 * | A match proves | A match does NOT prove |
 * | --- | --- |
 * | The first bytes are not a PE, ELF, Mach-O, shebang, ZIP, RAR, 7z or gzip | That the file is complete — a truncated JPEG with a valid SOI passes |
 * | It is unlikely to be an HTML or SVG document | That it contains ONLY image data. Polyglots are real |
 * | The declared `contentType` is not a deliberate lie about the container | That the image is not a decompression bomb |
 * | It will not be sniffed as HTML, given `nosniff` | That the content is benign in any other sense |
 *
 * The residual polyglot risk is accepted for five specific reasons, all of which
 * are properties of the STACK rather than of this function: the object is served
 * from `firebasestorage.googleapis.com` and not from our origin; it is served with
 * the SNIFFED content type plus `nosniff`; it is rendered through `<img>`, which
 * does not execute script; downloads go through a signed URL with
 * `Content-Disposition: attachment`; and SVG and HTML are not in the allow-list at
 * all, which removes the two formats where a payload would actually run.
 *
 * What would close it properly is a real decoder that re-encodes (`sharp`), and
 * docs/02 §6 rejects that dependency. Recorded as residual risk RR-10.
 *
 * ---------------------------------------------------------------------------
 * WHY `audio/webm` READS 64 KiB AND NOT 4 KiB
 * ---------------------------------------------------------------------------
 * docs/15 §5.2.4 states the honest limitation plainly: a real WebM's `Segment` and
 * `Tracks` elements frequently sit beyond a 4 KiB window, especially for a
 * 120-second Opus recording, so a 4 KiB scan rejects a legitimate voice note.
 *
 * The trade the document makes is: "reject a valid 90-second voice note" is a
 * worse failure for this product than "accept a video-only WebM and let `<audio>`
 * fail to play it". A citizen whose emergency report depends on their voice note
 * must never lose it to a sniffing window. So this reads 64 KiB, and when the
 * fourCC scan is still inconclusive it returns `confidence: 'inconclusive'`
 * rather than a hard refusal — which the caller records as `scanStatus: 'pending'`
 * so a human can look.
 */

import {
  ALLOWED_MEDIA,
  MEDIA_LIMITS,
  type AllowedMediaType,
  type MediaKind,
} from '@/validators/upload';

/* ========================================================================== */
/* The result                                                                   */
/* ========================================================================== */

/**
 * What the bytes are.
 *
 * `confidence: 'inconclusive'` is a first-class outcome, not a near-miss. It means
 * "the header is consistent with this container but I could not confirm the track
 * type", and the consequence is a *pending* scan status rather than a rejection.
 *
 * `quarantined` is separate from `null` and is deliberately a different branch: an
 * executable or an archive is MOVED to `quarantine/` and audited, not merely
 * refused. A `415` would imply a reasonable mistake; a quarantine is a statement
 * that something arrived that should never have been stored.
 */
export type Detected =
  | {
      readonly contentType: AllowedMediaType;
      readonly kind: MediaKind;
      readonly confidence: 'exact' | 'inconclusive';
      readonly width: number | null;
      readonly height: number | null;
      /** Populated only for `audio/mp4` and `audio/webm` where the container carries it. */
      readonly durationSec: number | null;
    }
  | { readonly quarantined: true; readonly reason: string };

/* ========================================================================== */
/* Byte helpers                                                                  */
/* ========================================================================== */

/** Does `buf` start with `prefix`? */
function starts(buf: Uint8Array, prefix: readonly number[]): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

/** The four ASCII bytes at `offset`, or `null`. `RIFF`/`WEBP`/`IHDR`/`ftyp` checks. */
function chunk(buf: Uint8Array, offset: number): string | null {
  if (buf.length < offset + 4) return null;
  return String.fromCharCode(buf[offset] as number, buf[offset + 1] as number, buf[offset + 2] as number, buf[offset + 3] as number);
}

/** Index of the first occurrence of four ASCII bytes, or -1. */
function findChunk(buf: Uint8Array, needle: string, from = 0): number {
  const target = [needle.charCodeAt(0), needle.charCodeAt(1), needle.charCodeAt(2), needle.charCodeAt(3)];
  for (let i = from; i + 4 <= buf.length; i += 1) {
    if (buf[i] === target[0] && buf[i + 1] === target[1] && buf[i + 2] === target[2] && buf[i + 3] === target[3]) {
      return i;
    }
  }
  return -1;
}

/** Every distinct four-character code in the buffer, from a set of candidates. */
function findFourCCs(buf: Uint8Array, candidates: readonly string[]): string[] {
  const found: string[] = [];
  for (const candidate of candidates) {
    if (findChunk(buf, candidate) !== -1) found.push(candidate);
  }
  return found;
}

/** Big-endian uint32. */
function be32(buf: Uint8Array, offset: number): number | null {
  if (buf.length < offset + 4) return null;
  return (
    ((buf[offset] as number) * 0x1000000) +
    ((buf[offset + 1] as number) << 16) +
    ((buf[offset + 2] as number) << 8) +
    (buf[offset + 3] as number)
  );
}

/** Little-endian uint16/uint24/uint32. */
function le16(buf: Uint8Array, offset: number): number | null {
  if (buf.length < offset + 2) return null;
  return (buf[offset] as number) | ((buf[offset + 1] as number) << 8);
}

function le24(buf: Uint8Array, offset: number): number | null {
  if (buf.length < offset + 3) return null;
  return (
    (buf[offset] as number) |
    ((buf[offset + 1] as number) << 8) |
    ((buf[offset + 2] as number) << 16)
  );
}

function le32(buf: Uint8Array, offset: number): number | null {
  if (buf.length < offset + 4) return null;
  return (
    (buf[offset] as number) +
    (buf[offset + 1] as number) * 0x100 +
    (buf[offset + 2] as number) * 0x10000 +
    (buf[offset + 3] as number) * 0x1000000
  );
}

function validImageDimensions(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width <= MEDIA_LIMITS.maxImageDimension &&
    height <= MEDIA_LIMITS.maxImageDimension &&
    width * height <= MEDIA_LIMITS.maxImageMegapixels * 1_000_000
  );
}

/* ========================================================================== */
/* Executable and archive signatures — §6                                        */
/* ========================================================================== */

/**
 * The unambiguous "never store this" signatures.
 *
 * These are checked BEFORE the media signatures, and that ordering is the point: a
 * polyglot whose first bytes are a ZIP is a ZIP. A file that matches both a media
 * header and one of these is refused, because the media header can be a prefix
 * anyone can write and `PK\x03\x04` cannot be accidental.
 *
 * Every entry here is checked at offset 0 with no mask, and every one of them is
 * architecturally impossible in a real photo or voice note.
 */
const DANGEROUS_SIGNATURES: readonly (readonly [string, readonly number[]])[] = [
  // Windows PE / DOS
  ['Windows executable', [0x4d, 0x5a]], // MZ
  // ELF
  ['Linux executable', [0x7f, 0x45, 0x4c, 0x46]],
  // Mach-O, both endiannesses
  ['macOS executable', [0xcf, 0xfa, 0xed, 0xfe]],
  ['macOS executable (little-endian)', [0xce, 0xfa, 0xed, 0xfe]],
  // shebang
  ['script', [0x23, 0x21]], // #!
  // Archives. "The delivery vehicle for everything on this list."
  ['archive', [0x50, 0x4b, 0x03, 0x04]], // PK\x03\x04 zip
  ['archive', [0x50, 0x4b, 0x05, 0x06]], // PK\x05\x06 empty zip
  ['archive', [0x52, 0x61, 0x72, 0x21]], // Rar!
  ['archive', [0x37, 0x7a, 0xbc, 0xaf]], // 7z
  ['archive', [0x1f, 0x8b]], // gzip
  ['archive', [0x42, 0x5a, 0x68]], // bzip2
  ['archive', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]], // xz
  // Java class
  ['executable', [0xca, 0xfe, 0xba, 0xbe]], // Mach-O fat / Java class
];

/* ========================================================================== */
/* Format-specific checks                                                        */
/* ========================================================================== */

/**
 * JPEG: `FF D8 FF` plus a valid marker follows. docs/15 §5.2.1.
 *
 * The three-byte SOI check alone is a WEAK discriminator — §5.2.1's secondary
 * check exists because a real JPEG's fourth byte is a marker and anything else
 * means this is something wearing a JPEG header. And this is exactly the trap
 * Phase 4's own test suite fell into: masking the fourth byte to `0xF0` accepts
 * only the `Exx` family and rejects DQT-first, SOF-first and Adobe-encoded JPEGs,
 * all of which are real. So the marker set is enumerated rather than masked.
 */
const JPEG_VALID_MARKERS: readonly number[] = [
  0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef,
  0xdb, // DQT
  0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, // SOF0-SOF15
  0xfe, // COM
];

function jpegLooksReal(buf: Uint8Array): boolean {
  if (buf.length < 5) return false;
  const fourth = buf[3] as number;
  if (!JPEG_VALID_MARKERS.includes(fourth)) return false;
  // §5.2.1: "Reject if the buffer starts FF D8 FF but contains no FF D9 anywhere in
  // the first 4 KiB AND the object is smaller than 512 bytes - that is a 3-byte
  // header pretending to be a photo."
  // The size half of that condition is the CALLER's knowledge, so what is checked
  // here is the marker byte. A 5-byte buffer with a valid marker is caught by the
  // 512-byte rule in `finalize-upload.ts`.
  return true;
}

/** JPEG SOF dimensions, parsed from the marker segments before the image scan. */
function jpegDimensions(buf: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    while (buf[offset] === 0xff) offset += 1;
    const marker = buf[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00 || marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLength = be16(buf, offset);
    if (segmentLength === null || segmentLength < 2 || offset + segmentLength > buf.length) return null;

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      const height = be16(buf, offset + 3);
      const width = be16(buf, offset + 5);
      if (width === null || height === null || !validImageDimensions(width, height)) return null;
      return { width, height };
    }

    offset += segmentLength;
  }
  return null;
}

function be16(buf: Uint8Array, offset: number): number | null {
  if (buf.length < offset + 2) return null;
  return ((buf[offset] as number) << 8) | (buf[offset + 1] as number);
}

/** PNG: signature + IHDR + dimensions within the caps. docs/15 §5.2.2. */
function pngDimensions(buf: Uint8Array): { width: number; height: number } | null {
  if (chunk(buf, 12) !== 'IHDR') return null;
  const width = be32(buf, 16);
  const height = be32(buf, 20);
  if (width === null || height === null) return null;
  return { width, height };
}

function pngLooksReal(buf: Uint8Array): { width: number; height: number } | null {
  const dimensions = pngDimensions(buf);
  if (dimensions === null) return null;
  const { width, height } = dimensions;
  // §5.2.2: "Both must be > 0 and <= MAX_IMAGE_DIMENSION". A zero dimension is a
  // crafted header, and a 60 000 x 60 000 PNG inside 5 MB is the decompression
  // bomb the §5.4 table names.
  if (!validImageDimensions(width, height)) return null;
  // §5.2.2: "Reject if the first 4 KiB contains neither IEND nor at least one IDAT".
  // A PNG whose first chunk is IHDR and which has no IDAT in the window is a
  // header, not a picture.
  if (findChunk(buf, 'IDAT') === -1 && findChunk(buf, 'IEND') === -1) return null;
  return dimensions;
}

/** WebP: RIFF + WEBP + a valid subformat, animated rejected. docs/15 §5.2.3. */
function webpLooksReal(buf: Uint8Array): boolean {
  if (chunk(buf, 8) !== 'WEBP') return false;
  const sub = chunk(buf, 12);
  if (sub === 'VP8 ' || sub === 'VP8L') return true;
  if (sub === 'VP8X') {
    // "animated WebP is unbounded CPU to decode and pointless as emergency
    // evidence" — §5.2.3. A still WebP is VP8X too (extended), so the check is
    // for the ANIM chunk specifically rather than for VP8X itself.
    return findChunk(buf, 'ANIM') === -1 && findChunk(buf, 'ANMF') === -1;
  }
  // A RIFF container that is not WebP: WAVE, AVI , and friends. This is the check
  // that stops a renamed audio file.
  return false;
}

/** WebP dimensions from the VP8, VP8L or VP8X image chunk. */
function webpDimensions(buf: Uint8Array): { width: number; height: number } | null {
  const riffSize = le32(buf, 4);
  if (riffSize === null || riffSize + 8 > buf.length) return null;

  const riffEnd = riffSize + 8;
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const type = chunk(buf, offset);
    const size = le32(buf, offset + 4);
    if (type === null || size === null) return null;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + size;
    if (dataEnd > riffEnd) return null;

    let width: number | null = null;
    let height: number | null = null;
    if (type === 'VP8X' && size >= 10) {
      const widthMinusOne = le24(buf, dataOffset + 4);
      const heightMinusOne = le24(buf, dataOffset + 7);
      if (widthMinusOne !== null && heightMinusOne !== null) {
        width = widthMinusOne + 1;
        height = heightMinusOne + 1;
      }
    } else if (type === 'VP8 ' && size >= 10) {
      if (
        buf[dataOffset + 3] === 0x9d &&
        buf[dataOffset + 4] === 0x01 &&
        buf[dataOffset + 5] === 0x2a
      ) {
        const rawWidth = le16(buf, dataOffset + 6);
        const rawHeight = le16(buf, dataOffset + 8);
        if (rawWidth !== null && rawHeight !== null) {
          width = rawWidth & 0x3fff;
          height = rawHeight & 0x3fff;
        }
      }
    } else if (type === 'VP8L' && size >= 5 && buf[dataOffset] === 0x2f) {
      const b1 = buf[dataOffset + 1] as number;
      const b2 = buf[dataOffset + 2] as number;
      const b3 = buf[dataOffset + 3] as number;
      const b4 = buf[dataOffset + 4] as number;
      width = 1 + b1 + ((b2 & 0x3f) << 8);
      height = 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10);
    }
    if (width !== null && height !== null) {
      return validImageDimensions(width, height) ? { width, height } : null;
    }

    offset = dataEnd + (size & 1);
  }
  return null;
}

/** EBML header, version 01, and the `webm` DocType. §5.2.4. */
function isWebm(buf: Uint8Array): boolean {
  if (!starts(buf, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  if (buf.length > 6 && (buf[4] as number) !== 0x01) return false;
  // The DocType element id is `42 82` followed by a length and the string. A
  // `matroska` DocType is REJECTED — a broader container is a broader surface.
  const docTypeOffset = findBytes(buf, [0x42, 0x82]);
  if (docTypeOffset === -1) return false;
  const declared = chunk(buf, docTypeOffset + 3);
  return declared === 'webm';
}

/** Index of the first occurrence of a byte sequence, or -1. */
function findBytes(buf: Uint8Array, needle: readonly number[], from = 0): number {
  for (let i = from; i + needle.length <= buf.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (buf[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

/** ISO-BMFF audio brands. §5.2.5. Video brands are listed so they can be refused. */
const AUDIO_BRANDS: ReadonlySet<string> = new Set(['M4A ', 'M4B ', 'mp42', 'mp41', 'isom', 'iso2', 'iso6']);
const VIDEO_BRANDS: ReadonlySet<string> = new Set(['isof', 'iso5', 'avc1', 'mp44', '3gp4', '3gp5', 'qt  ', 'M4V ', 'dash']);

/** MP3: an ID3v2 tag or a raw frame header. §5.2.6. */
function looksLikeMp3(buf: Uint8Array): boolean {
  // Shape 1: ID3v2. A syncsafe size whose high bits are set is invalid.
  if (starts(buf, [0x49, 0x44, 0x33])) {
    if (buf.length < 10) return false;
    const major = buf[3] as number;
    if (major !== 0x03 && major !== 0x04) return false;
    // §5.2.6: "Reject FF FF - the classic marker of a JPEG whose first two bytes
    // were shifted; a strong polyglot signal."
    if (buf[4] === 0xff && buf[5] === 0xff) return false;
    return true;
  }
  // Shape 2: a raw MPEG audio frame. The second byte's top three bits are 111, and
  // the layer bits must indicate Layer III.
  if (buf.length < 2) return false;
  if ((buf[0] as number) !== 0xff) return false;
  const second = buf[1] as number;
  if ((second & 0xe0) !== 0xe0) return false;
  const layer = (second >> 1) & 0x03;
  return layer === 0x01; // Layer III
}

/* ========================================================================== */
/* The detector                                                                  */
/* ========================================================================== */

/**
 * What are these bytes?
 *
 * The order is deliberate and is the security-relevant part:
 *
 *   1. **Dangerous signatures first.** A polyglot is defined by its first bytes.
 *      Checking media formats first would let `PK\x03\x04<html>` reach the
 *      allow-list logic on the strength of a header someone chose to write.
 *   2. **Images before audio.** An image and an audio file have disjoint
 *      signatures, so the order is not load-bearing — but images are the common
 *      case and this keeps the hot path first.
 *   3. **Everything else is `null`**, which the caller turns into a `415`. The
 *      function does not decide the error code; the route does, because only the
 *      route knows the request context.
 */
export function detectMediaType(buf: Uint8Array): Detected | null {
  if (buf.length === 0) return null;

  /* --- 1. never store these ------------------------------------------- */
  for (const [label, signature] of DANGEROUS_SIGNATURES) {
    if (starts(buf, signature)) {
      return { quarantined: true, reason: `the file begins with a ${label} signature` };
    }
  }

  /* --- 2. image/jpeg --------------------------------------------------- */
  if (starts(buf, [0xff, 0xd8, 0xff]) && jpegLooksReal(buf)) {
    const dimensions = jpegDimensions(buf);
    if (dimensions === null) return null;
    return { contentType: 'image/jpeg', kind: 'image', confidence: 'exact', ...dimensions, durationSec: null };
  }

  /* --- 3. image/png ---------------------------------------------------- */
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const dimensions = pngLooksReal(buf);
    // Out-of-range dimensions are a REJECTION, not an inconclusive: §5.2.2's own
    // code returns null for them, and it is right. A 60 000px PNG inside 5 MB is
    // the decompression bomb, and "we could not confirm it is safe" is not a
    // reason to store it.
    if (dimensions === null) return null;
    return {
      contentType: 'image/png',
      kind: 'image',
      confidence: 'exact',
      width: dimensions.width,
      height: dimensions.height,
      durationSec: null,
    };
  }

  /* --- 4. image/webp --------------------------------------------------- */
  if (starts(buf, [0x52, 0x49, 0x46, 0x46]) && webpLooksReal(buf)) {
    const dimensions = webpDimensions(buf);
    if (dimensions === null) return null;
    return { contentType: 'image/webp', kind: 'image', confidence: 'exact', ...dimensions, durationSec: null };
  }

  /* --- 5. audio/webm --------------------------------------------------- */
  // Read over the whole sniff window (64 KiB by default) because the track
  // elements routinely sit beyond 4 KiB. See the file header.
  if (isWebm(buf)) {
    const fourCCs = findFourCCs(buf, [
      'A_OPUS', 'A_VORBIS',
      'V_VP8', 'V_VP9', 'V_AV1',
    ]);
    const hasVideo = fourCCs.some((code) => code.startsWith('V_'));
    const hasAudio = fourCCs.some((code) => code.startsWith('A_'));
    if (hasVideo) {
      // Video-only OR muxed. Both rejected: FR scope excludes video, and a muxed
      // file is a video file that happens to carry a track.
      return null;
    }
    if (hasAudio) {
      return { contentType: 'audio/webm', kind: 'audio', confidence: 'exact', width: null, height: null, durationSec: null };
    }
    // Inconclusive. Accepted as `audio/webm` with a pending scan, which is the
    // trade docs/15 §5.2.4 makes explicitly: "reject a valid 90-second voice
    // note" is worse than "accept a video-only WebM and let <audio> fail to play
    // it".
    return { contentType: 'audio/webm', kind: 'audio', confidence: 'inconclusive', width: null, height: null, durationSec: null };
  }

  /* --- 6. audio/mp4 ---------------------------------------------------- */
  // `ftyp` is at offset 4, not 0 — the first box is usually `free` or `moov`.
  if (chunk(buf, 4) === 'ftyp') {
    const brand = chunk(buf, 8);
    if (brand !== null && AUDIO_BRANDS.has(brand)) {
      return { contentType: 'audio/mp4', kind: 'audio', confidence: 'exact', width: null, height: null, durationSec: null };
    }
    if (brand !== null && VIDEO_BRANDS.has(brand)) return null;
    // An unknown brand in an ISO-BMFF container. §5.2.5's honest limitation says
    // we can only assert "this is an ISO-BMFF file of an accepted brand", so an
    // unknown brand is a refusal rather than a guess.
    return null;
  }

  /* --- 7. audio/mpeg --------------------------------------------------- */
  if (looksLikeMp3(buf)) {
    return { contentType: 'audio/mpeg', kind: 'audio', confidence: 'exact', width: null, height: null, durationSec: null };
  }

  /* --- 8. everything else --------------------------------------------- */
  return null;
}

/**
 * Is this detected type one we are allowed to store?
 *
 * A separate function from `detectMediaType` because the two answer different
 * questions and the caller asks both. The sniffer says what the bytes are; this
 * says whether the product accepts that. Keeping them apart means a future
 * seventh format is a change to `ALLOWED_MEDIA` and nothing else, and it means
 * the sniffer — which is the part that has to be right for SECURITY reasons — has
 * no dependency on the product's allow-list at all.
 */
export function isAllowedDetected(detected: Detected): detected is Exclude<Detected, { quarantined: true }> {
  return !('quarantined' in detected) && detected.contentType in ALLOWED_MEDIA;
}

/** The per-kind byte cap, from the allow-list. Used by finalize and by the client. */
export function maxBytesFor(contentType: AllowedMediaType): number {
  return ALLOWED_MEDIA[contentType].maxBytes;
}

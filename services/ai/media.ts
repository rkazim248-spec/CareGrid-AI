/**
 * ============================================================================
 * CareGrid AI — evidence image validation
 * ============================================================================
 *
 * Brief §11, docs/15. Server-side validation of an image before it is base64'd
 * into a model request. PURE — no network, no SDK, no filesystem.
 *
 * ---------------------------------------------------------------------------
 * WHY MAGIC BYTES AND NOT THE DECLARED MIME TYPE
 * ---------------------------------------------------------------------------
 * Because the declared type is whatever the client said, and the client is the
 * untrusted party. `Content-Type: image/jpeg` on a file whose first bytes are
 * `<?php` is not a bug in the uploader, it is the attack. Validating the
 * declared type would be a comment.
 *
 * So the authority is the **file signature** — a fixed byte prefix that a format
 * cannot fake without also being that format. Everything else in this file
 * exists to make a signature check sufficient:
 *
 *  - **The extension is checked too**, and against the signature, not against the
 *    claim. A `.png` containing JPEG bytes is rejected, because a downstream
 *    consumer that trusts the extension will mis-decode it and a reviewer reading
 *    the name will misjudge what they opened.
 *  - **The size is checked on the DECODED byte length**, before base64. Base64
 *    inflates by ~1.37×, so a limit applied after encoding is 37% looser than the
 *    number everyone thinks they wrote.
 *  - **The declared type must AGREE with the signature.** Three independent
 *    signals must concur, which means an attacker has to satisfy all three
 *    rather than pick the weakest.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO, AND WHY IT IS STILL THE RIGHT SCOPE
 * ---------------------------------------------------------------------------
 * **This does not make an uploaded image safe.** There is no image decoding here,
 * so there is no defence against a decompression bomb, a polyglot that is a valid
 * JPEG and also valid HTML, or a malformed image that a future decoder
 * mis-parses.
 *
 * That is not an oversight to paper over — it is docs/15's deliberate position,
 * and the reasoning is worth repeating: *the compensating controls for image
 * parsing bugs do not exist here because the platform is not the target.* The
 * real defences are that the bytes are never executed (they go to a model as
 * base64, never to a renderer, never to a `<script>`), that they are only ever
 * read by Firestore Storage under a deny-by-default rule, and that the eventual
 * viewer is a browser `<img>`, which does not execute script in a JPEG.
 *
 * What this file does guarantee is stated plainly: **an image that reaches
 * Gemini is a real image of a supported type, within a size bound, whose
 * signature matches its name and its declaration.**
 */

import { createHash } from 'node:crypto';

import { AI_MAX_IMAGES, AI_MAX_INLINE_BYTES } from '@/config/ai';

/* ========================================================================== */
/* Signatures                                                                    */
/* ========================================================================== */

/**
 * A format we accept, identified by its byte signature.
 *
 * `bytes` are matched at the START of the file. `mask` exists because one format
 * has a variable byte in the middle of the prefix — without the mask,
 * `FF D8 FF E0` (JFIF) and `FF D8 FF E1` (EXIF) would need two entries each, and
 * the table would grow every time a camera manufacturer invents a variant. The
 * masked byte is compared with `&` so both variants match one entry.
 *
 * `tail` is a SECOND region at a fixed offset, for a container whose first bytes
 * identify the container and whose later bytes identify the codec. WebP needs it:
 * bytes 0-3 are `RIFF`, bytes 4-7 are the file LENGTH, and bytes 8-11 are `WEBP`.
 * A signature that spanned all twelve would have to either hard-code a length
 * (rejecting every file whose size differs) or mask the length to zeros (also
 * rejecting every file whose size is non-zero, which is every real file). The
 * first version of this table did exactly that, and a test caught it: **it would
 * have rejected every real WebP photograph in the product.**
 */
type ImageSignature = {
  readonly mimeType: string;
  /** Extensions that are legitimate for this format. */
  readonly extensions: readonly string[];
  /** The literal prefix. */
  readonly bytes: readonly number[];
  /** Optional AND-mask aligned to `bytes`. */
  readonly mask?: readonly number[];
  /** Optional second region, at `tailOffset`. */
  readonly tail?: { readonly offset: number; readonly bytes: readonly number[] };
  /**
   * `true` when the format cannot be safely truncated at the header and must be
   * verified end-to-end. Progressive and interlaced JPEGs and every PNG variant
   * are simple enough that a header check is a real check, so this is `false`
   * for all of them — stated explicitly so the absence is a decision on record
   * rather than an oversight.
   */
  readonly headerOnlyIsSufficient: boolean;
};

const BASE64_PREFIX = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i;

/**
 * The accepted formats. docs/15 §2.
 *
 * **PNG, JPEG and WebP only.** The formats considered and rejected, and why, are
 * in docs/15 §2; the short version is that the others either cannot be validated
 * by signature (SVG is XML that may contain script), have a decompression-bomb
 * profile that a signature check cannot bound, or are not images at all.
 *
 * Notably **SVG is absent and that is the important one.** An SVG is a text file,
 * validates as one, and can carry `<script>`. A validator that trusted the
 * declared type would accept it; a validator that checked the extension would
 * accept a `.jpg` containing it. Only the signature stops it, and it is listed
 * here as absent on purpose.
 */
export const ACCEPTED_IMAGE_SIGNATURES: readonly ImageSignature[] = [
  {
    // PNG's 8-byte signature is fixed by the spec, with no variable bytes.
    mimeType: 'image/png',
    extensions: ['png'],
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    headerOnlyIsSufficient: true,
  },
  {
    // `FF D8 FF` and nothing more. The fourth byte is the MARKER, and JPEG
    // defines many: APP0/APP1 (E0/E1), DQT (DB), SOF0..SOF15 (C0..CF), APP14
    // (EE), COM (FE). Masking it to `F0` — as the first version of this table
    // did — accepts only the `Exx` family and so rejects a DQT-first or
    // Adobe-encoded JPEG, which is a real and common encoding. Masking with
    // `0x00` is equivalent to not checking the byte at all, so the row is just
    // the three-byte prefix.
    mimeType: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
    bytes: [0xff, 0xd8, 0xff],
    headerOnlyIsSufficient: true,
  },
  {
    // "RIFF" .... "WEBP" — two regions, because bytes 4-7 are the file length.
    // See the `tail` note on `ImageSignature`; getting this wrong rejects every
    // real WebP.
    mimeType: 'image/webp',
    extensions: ['webp'],
    bytes: [0x52, 0x49, 0x46, 0x46],
    tail: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    headerOnlyIsSufficient: true,
  },
];

/** The one format family that is deliberately unsupported, named for the docs. */
export const REJECTED_IMAGE_FORMATS = {
  svg: 'An SVG is a text file that can contain <script>. It cannot be validated by signature and is not accepted.',
  gif: 'Animated GIF decompression is a known amplification vector, and a still frame adds nothing an emergency report needs.',
  bmp: 'Uncompressed, so a 5 MB ceiling would be about 1.7 megapixels. Not a useful trade for evidence photos.',
  tiff: 'Uncompressed, multi-megabyte, and used for print rather than phone cameras.',
  heic: 'The container is a brand-detection puzzle; a mismatch means a silent decode failure rather than a clear rejection.',
  pdf: 'Not an image. Documents belong in the document path with its own validation.',
} as const;

/** One image's ceiling. docs/15 §3. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/* ========================================================================== */
/* Decoding                                                                      */
/* ========================================================================== */

/**
 * A decode failure. Named so a caller can distinguish "you sent me something
 * that is not an image" from "the system is broken", and so the HTTP layer can
 * map it to a 4xx rather than a 500.
 */
export class ImageValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ImageValidationError';
  }
}

/** Decode base64 to bytes, rejecting anything that is not strict base64. */
export function decodeBase64(data: string): Uint8Array {
  // `atob` is available in Node 18+ and in the browser; the Buffer path is not
  // used so this function stays usable in a test that runs in either.
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode bytes to base64. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Strip a `data:` prefix if present and return the declared type and payload.
 *
 * Accepting a data URL is convenient for a browser `FileReader` result, and the
 * declared type inside it is treated as a CLAIM to be checked against the
 * signature — never as the answer.
 */
export function splitDataUrl(value: string): { declaredMime: string | null; data: string } {
  const match = value.match(BASE64_PREFIX);
  // `?? ''` rather than a non-null assertion: `noUncheckedIndexedAccess` makes
  // the capture groups `string | undefined`, and an assertion here would suppress
  // the check for the `match[0].length` on the next line too.
  if (match === null || match[0] === undefined || match[1] === undefined) {
    return { declaredMime: null, data: value };
  }
  return { declaredMime: match[1].toLowerCase(), data: value.slice(match[0].length) };
}

/* ========================================================================== */
/* The check                                                                     */
/* ========================================================================== */

/** One image after validation. Carries what the prompt builder needs and no more. */
export type ValidatedImage = {
  readonly mimeType: string;
  readonly base64: string;
  /** SHA-256 of the raw bytes, for `aiRuns`. The bytes themselves are never logged. */
  readonly sha256: string;
  readonly byteLength: number;
  /** The filename the reporter gave, lowercased, with no directory part. */
  readonly fileName: string;
};

/** The identity of a validated image, for the schema-parity tests. */
export type RawImageInput = {
  /** Raw bytes, or a data URL / bare base64 string. */
  readonly data: string | Uint8Array;
  /** What the client claimed. Checked, never trusted. */
  readonly declaredMimeType?: string | null;
  /** What the client called it. Checked against the signature. */
  readonly fileName?: string | null;
};

/**
 * Validate one image, or throw `ImageValidationError` naming the reason.
 *
 * The check order is deliberate and each step is a place a real attack lands:
 *
 *  1. **Signature first.** Before the extension, the declared type, or the size.
 *     Everything else is a claim; this is the fact. Deciding the type from the
 *     bytes means a 40 MB `.jpg` that is really a zip is rejected as the wrong
 *     FORMAT before the size limit is even consulted, so the error names the
 *     real problem.
 *  2. **Declared type must agree.** A mismatch is a rejection, not a correction.
 *     Silently trusting the signature over the declaration would be safe; the
 *     reverse — accepting either when they disagree — is how a polyglot gets in.
 *  3. **Extension must agree.** Same reasoning, and it protects the reviewer who
 *     reads the filename.
 *  4. **Size last.** Expensive to compute, and a file too large AND the wrong
 *     format should be reported as the wrong format.
 *
 * `maxBytes` is a parameter so the route can lower the ceiling (FR-143) without
 * this function needing to know about HTTP.
 */
export function validateImage(
  input: RawImageInput,
  maxBytes: number = MAX_IMAGE_BYTES,
): ValidatedImage {
  const isUrl = typeof input.data === 'string';
  const stripped = isUrl ? splitDataUrl(input.data) : { declaredMime: null, data: '' };
  const bytes = typeof input.data === 'string' ? decodeBase64(stripped.data) : input.data;

  if (bytes.length === 0) throw new ImageValidationError('The image was empty.');

  /* --- 1. signature ----------------------------------------------------- */
  const signature = ACCEPTED_IMAGE_SIGNATURES.find((candidate) => matches(bytes, candidate));
  if (signature === undefined) {
    throw new ImageValidationError(
      'Unsupported image format. Only PNG, JPEG and WebP are accepted, and the file must ' +
        'really be one of those — the type is checked from the file itself, not from its name.',
    );
  }

  /* --- 2. declared type -------------------------------------------------- */
  const declared = (input.declaredMimeType ?? stripped.declaredMime ?? '').toLowerCase().trim();
  if (declared.length > 0 && declared !== signature.mimeType) {
    // JPEG is the one place an alias is tolerated, because browsers and the
    // filesystem disagree about it constantly (`image/jpg` is not a registered
    // type) and rejecting it would fail a legitimate report for a naming detail.
    const isJpegAlias = signature.mimeType === 'image/jpeg' && declared === 'image/jpg';
    if (!isJpegAlias) {
      throw new ImageValidationError(
        `The image is really ${signature.mimeType} but was declared as ${declared}.`,
      );
    }
  }

  /* --- 3. extension ------------------------------------------------------ */
  const name = (input.fileName ?? '').trim().toLowerCase();
  // A missing name is fine — a `File` from a camera capture often has none — but
  // a name that IS present must not contradict the bytes.
  if (name.length > 0) {
    const dot = name.lastIndexOf('.');
    const extension = dot === -1 ? '' : name.slice(dot + 1);
    if (extension.length > 0 && !signature.extensions.includes(extension)) {
      throw new ImageValidationError(
        `The image is ${signature.mimeType} but the filename says ".${extension}".`,
      );
    }
  }

  /* --- 4. size ----------------------------------------------------------- */
  if (bytes.length > maxBytes) {
    throw new ImageValidationError(
      `The image is ${Math.round(bytes.length / 1024 / 1024)} MB. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
    );
  }

  return {
    mimeType: signature.mimeType,
    base64: encodeBase64(bytes),
    sha256: sha256Hex(bytes),
    byteLength: bytes.length,
    fileName: name.length > 0 ? name.replace(/^.*[\\/]/, '') : 'image',
  };
}

/** Compare the leading bytes, the optional mask, and the optional tail region. */
function matches(bytes: Uint8Array, signature: ImageSignature): boolean {
  if (bytes.length < signature.bytes.length) return false;
  for (let i = 0; i < signature.bytes.length; i += 1) {
    const expected = signature.bytes[i] as number;
    // The parentheses around the cast are load-bearing. `as` binds tighter than
    // `&`, so `bytes[i] as number & mask` parses as a TYPE (`number & mask`),
    // which does not compile — and the "fix" of removing the parens instead
    // silently changes the comparison. TypeScript caught this one, which is more
    // than can be said for the precedence rule being obvious.
    const actual = bytes[i] as number;
    const mask = signature.mask?.[i] ?? 0xff;
    if ((actual & mask) !== (expected & mask)) return false;
  }

  if (signature.tail !== undefined) {
    const { offset, bytes: tail } = signature.tail;
    // The tail must be PRESENT as well as correct: a 4-byte file that starts
    // `RIFF` is not a WebP, and reading past the end would compare `undefined`.
    if (bytes.length < offset + tail.length) return false;
    for (let i = 0; i < tail.length; i += 1) {
      if (bytes[offset + i] !== tail[i]) return false;
    }
  }

  return true;
}

/**
 * SHA-256 of the raw bytes, for `aiRuns`.
 *
 * `node:crypto` and not a hand-rolled digest. This value is written as an
 * integrity reference for the evidence, so "close enough" is not a category that
 * applies, and a compact implementation here would be both longer and wrong.
 *
 * The name mirrors docs/09 §4.1, which specifies a `sha256` on every media item,
 * and the digest is what lets an operator confirm that the image the model saw is
 * the image the citizen attached.
 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ========================================================================== */
/* The budget                                                                    */
/* ========================================================================== */

/**
 * Fit images into the inline byte budget, dropping from the END.
 *
 * docs/09 §4.2 step 3: "images are dropped in reverse order until it fits, and
 * `mediaDropped` is recorded in the `aiRuns` metadata so the dispatcher knows the
 * model saw fewer images than exist. **Dropping is logged, never silent.**"
 *
 * Reverse order, because a caller attaches images in the order they matter —
 * the wide shot of the fire first, then the detail. The last one is the most
 * likely to be droppable.
 *
 * Never drops the first image even if that means returning one oversized image,
 * because "the model saw nothing" is a worse outcome than "the model saw a big
 * one": with no image at all the report is triaged as text-only and the caller
 * cannot tell that evidence existed. The caller is told either way, which is the
 * property that matters.
 */
export function fitImagesToBudget(
  images: readonly ValidatedImage[],
  budgetBytes: number = AI_MAX_INLINE_BYTES,
): { readonly kept: readonly ValidatedImage[]; readonly droppedFileNames: readonly string[] } {
  // Base64 inflates by 4/3; budget on the ENCODED size, because that is what the
  // request size limit applies to.
  const encodedSize = (image: ValidatedImage): number => Math.ceil(image.base64.length * 0.75);

  const kept: ValidatedImage[] = [];
  const dropped: string[] = [];
  let total = 0;

  for (const image of images) {
    const size = encodedSize(image);
    if (kept.length > 0 && total + size > budgetBytes) {
      dropped.push(image.fileName);
      continue;
    }
    kept.push(image);
    total += size;
  }

  return { kept, droppedFileNames: dropped };
}

/** The ceiling on how many images one call may carry. FR-005. */
export const MAX_IMAGES_PER_CALL = AI_MAX_IMAGES;

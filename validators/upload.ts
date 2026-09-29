/**
 * ============================================================================
 * CareGrid AI — the media allow-list and the storage-path contract
 * ============================================================================
 *
 * docs/15 §3 and §5. **The single source for every media rule in this product.**
 *
 * ---------------------------------------------------------------------------
 * WHY ONE FILE OWNS ALL OF IT
 * ---------------------------------------------------------------------------
 * Six values, and the specification says so explicitly: "That is the entire list.
 * `config.app` and `validators/upload.ts` share one constant, `ALLOWED_MEDIA`, so
 * the API validation, the Storage rules, the client pre-check, and this table
 * cannot drift."
 *
 * The drift this prevents is not theoretical. There are four places that must
 * agree about what a legal upload is:
 *
 *   1. `POST /api/uploads/sign`  — what it will sign a PUT for
 *   2. `POST /api/uploads/finalize` — what it will accept as already uploaded
 *   3. `storage.rules` — what Storage will permit (enforced by Firebase, from
 *      `contentType.matches(...)` and `request.resource.size`)
 *   4. the client pre-check — what it offers in a file picker
 *
 * A seventh value in any one of them is a value the others will not know about.
 * The server-side three are the controls; the client-side one is UX (docs/15
 * §8.1, step 1), which is why a client that offers a seventh type still gets it
 * refused rather than stored.
 *
 * ---------------------------------------------------------------------------
 * WHY `ext` IS SERVER-DERIVED AND NEVER THE CLIENT'S
 * ---------------------------------------------------------------------------
 * docs/15 §3.1: the extension in a Storage path is "**server-derived from the
 * sniffed type**. Never taken from the client's filename."
 *
 * A client that chose the extension chooses the destination, and a `.jpg` that is
 * really an SVG is the specific attack that `docs/15 §6` calls "the single most
 * important decision in this document". Deriving `ext` from the SNIFFED type also
 * makes a mislabelled file *work* rather than fail — docs/15 §6: "ACCEPT, but the
 * extension is corrected. The path extension is derived from the sniffed type, so
 * a mislabelled file lands as `.jpg`. No failure." That is the friendly AND the
 * correct behaviour, and it falls out of deriving rather than validating.
 */

import { z } from 'zod';

import { strictObject } from '@/validators/common';

/* ========================================================================== */
/* The allow-list — docs/15 §5.1                                                */
/* ========================================================================== */

/** `image` or `audio`. Never anything else, including `video`. */
export type MediaKind = 'image' | 'audio';

/**
 * The six permitted content types, and nothing else.
 *
 * `maxBytes` is per FILE and comes from docs/15 §7.1: 5 MiB for an image (FR-005)
 * and 15 MiB for an audio clip (FR-006). `maxPerReport` is 3 images and 1 audio
 * clip, and the TOTAL is capped at 3 as well.
 *
 * The signature columns are NOT here. `sig` is a single fixed prefix and two of
 * these formats need more than that — WebP is a RIFF container with a form type
 * at offset 8, and MP3 has two accepted shapes. docs/15 §5.1 marks those `null`
 * and the real work is in `services/uploads/sniff.ts`, which reads the whole
 * header rather than a prefix. Putting a partial `sig` here would be worse than
 * nothing: it would look like the check and would not be the check.
 */
export const ALLOWED_MEDIA = {
  'image/jpeg': { kind: 'image', ext: 'jpg', maxBytes: 5_242_880, maxPerReport: 3 },
  'image/png': { kind: 'image', ext: 'png', maxBytes: 5_242_880, maxPerReport: 3 },
  'image/webp': { kind: 'image', ext: 'webp', maxBytes: 5_242_880, maxPerReport: 3 },
  'audio/webm': { kind: 'audio', ext: 'webm', maxBytes: 15_728_640, maxPerReport: 1 },
  'audio/mp4': { kind: 'audio', ext: 'm4a', maxBytes: 15_728_640, maxPerReport: 1 },
  'audio/mpeg': { kind: 'audio', ext: 'mp3', maxBytes: 15_728_640, maxPerReport: 1 },
} as const satisfies Record<string, { kind: MediaKind; ext: string; maxBytes: number; maxPerReport: number }>;

export type AllowedMediaType = keyof typeof ALLOWED_MEDIA;

/** Every permitted type, as a runtime array. For iteration and validation. */
export const ALLOWED_MEDIA_TYPES = Object.keys(ALLOWED_MEDIA) as readonly AllowedMediaType[];

/** Every permitted IMAGE type. The file picker filters on this. */
export const ALLOWED_IMAGE_TYPES = ALLOWED_MEDIA_TYPES.filter(
  (type) => ALLOWED_MEDIA[type].kind === 'image',
);

/** Every permitted AUDIO type. */
export const ALLOWED_AUDIO_TYPES = ALLOWED_MEDIA_TYPES.filter(
  (type) => ALLOWED_MEDIA[type].kind === 'audio',
);

/** Every extension the server may put in a path. Derived, so it cannot drift. */
export const ALLOWED_MEDIA_EXTENSIONS = ALLOWED_MEDIA_TYPES.map(
  (type) => ALLOWED_MEDIA[type].ext,
);

/**
 * The count limits. docs/15 §7.1.
 *
 * `maxTotal` is 3, which is the same as the image limit — and that is a real
 * constraint, not a coincidence. Three images and one audio clip is four items,
 * so a report with any audio may carry at most two images. Stating it as one
 * number rather than leaving it to be inferred is what stops a validator and a
 * UI from disagreeing about whether a fourth item is allowed.
 */
export const MEDIA_LIMITS = {
  maxImagesPerReport: 3,
  maxAudioPerReport: 1,
  /** docs/15 §7.1, "Max total media items: 3". */
  maxTotalPerReport: 3,
  maxAudioDurationSec: 120,
  /** docs/15 §9.1. Also read from the PNG/WEBP header. */
  maxImageDimension: 12_000,
  /** docs/15 §9.1: 12 000 x 12 000 AND at most 40 megapixels. */
  maxImageMegapixels: 40,
} as const;

/* ========================================================================== */
/* mediaId — docs/15 §4                                                         */
/* ========================================================================== */

/**
 * RFC 4648 base32, uppercased. 32 symbols: `A-Z` plus `2-7`.
 *
 * docs/15 §4. EXPORTED rather than kept private, and that is a change of intent:
 * the alphabet has to be identical in the two places that need it — the generator
 * in `sign-upload.ts`, and the test that asserts a generated id matches
 * `MEDIA_ID_RE`. A test that re-derives the alphabet from the same private
 * constant proves nothing, and a second alphabet is how `MEDIA_ID_RE` and the
 * generator come to disagree.
 *
 * **The digits are `2`-`7`, not `0`-`9`, and that is the whole point of choosing
 * base32.** `0`, `1`, `8` and `9` are the digits a human most often misreads as
 * letters when an id is copied out of a Storage console listing or read aloud, so
 * they simply do not appear. Note that `I`, `L` and `O` *are* in the alphabet —
 * they are real symbols here, and the regex `[A-Z2-7]` accepts them. An earlier
 * draft of this comment claimed otherwise; the correction is recorded because a
 * "human-friendly" alphabet that silently rejects valid ids is worse than the
 * ambiguity it claims to prevent.
 */
export const MEDIA_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** `med_` + 12 base32 characters. docs/15 §3.1, §4. */
export const MEDIA_ID_RE = /^med_[A-Z2-7]{12}$/;

/** 60 bits of entropy across 100 000 objects is a ~4e-1 collision probability. */
export const MEDIA_ID_BODY_LENGTH = 12;

/** Is this a well-formed media id? Used by the rules and by every path check. */
export function mediaIdOk(value: string): boolean {
  return MEDIA_ID_RE.test(value);
}

/* ========================================================================== */
/* The path contract — docs/15 §3.1 and §3.4                                   */
/* ========================================================================== */

/**
 * The three legal path shapes, as regexes.
 *
 * Written out in full rather than assembled from a builder, because a regex built
 * from interpolated parts is one edit away from an unescaped `.` — and an
 * unescaped dot in a path validator accepts `med_XABCDEFGHIJ$` where it should
 * require a literal. The `EXT` alternation is a literal list of the six derived
 * extensions, not a pattern.
 *
 * ### `med_` IS INSIDE THE CAPTURE GROUP, AND THAT MATTERS TWICE
 *
 * 1. **`validateMediaPath` reads ids out of `exec()`'s groups** rather than
 *    re-parsing the string, so a group it does not capture is a value it cannot
 *    return. This file shipped once with `[A-Z2-7]{12}` outside the parentheses:
 *    the regex matched every correct path, and `validateMediaPath` still returned
 *    `null` for all of them, because the `uid` group it destructured was
 *    `undefined` and `undefined !== callerUid` is always true. Every upload would
 *    have been silently dropped. Caught by `tests/unit/uploads/paths.test.ts`.
 *
 * 2. **The `med_` prefix is part of the id, not decoration around it.** A group of
 *    `[A-Z2-7]{12}` returns `ABCDEFGH2345`; the claim store is keyed on
 *    `med_ABCDEFGH2345`, so returning the bare body would make every
 *    `releaseClaim` a no-op and leave claims to expire on their own timer.
 *
 * So the tests assert on `validateMediaPath(...)`'s RETURN VALUE for a known-good
 * path — a `.test()` assertion passes throughout both of the failures above.
 */
const EXT_ALTERNATION = ALLOWED_MEDIA_EXTENSIONS.join('|');

/** `staging/{uid}/med_XXXXXXXXXXXX.{ext}` — where a client PUT lands. */
export const STAGING_PATH_RE = new RegExp(
  `^staging/([A-Za-z0-9_-]{1,128})/(med_[A-Z2-7]{12})\\.(${EXT_ALTERNATION})$`,
);

/** `incidents/{incidentId}/{reports|supplements}/{reportId}/med_XXXXXXXXXXXX.{ext}` */
export const FINAL_PATH_RE = new RegExp(
  `^incidents/([A-Za-z0-9]{20})/(reports|supplements)/([A-Za-z0-9]{2,})/(med_[A-Z2-7]{12})\\.(${EXT_ALTERNATION})$`,
);

/** `quarantine/med_XXXXXXXXXXXX.{ext}` */
export const QUARANTINE_PATH_RE = new RegExp(
  `^quarantine/(med_[A-Z2-7]{12})\\.(${EXT_ALTERNATION})$`,
);

/**
 * Does this path try to escape its prefix?
 *
 * docs/15 §3.4 lists `..`, a leading `/`, a doubled `/`, and `%2e` as
 * `403 UPLOAD_FORBIDDEN_PATH`, and none of them can match the regexes above — the
 * character classes exclude `.` in the id position and `/` in a segment. So this
 * is a **defence-in-depth assertion, not the control**: the regexes are. It exists
 * because "the regex already rejects it" is a claim about a regex, and a claim
 * about a regex is exactly the kind of thing that is true until someone adds a
 * `.` to a character class.
 *
 * `decodeURIComponent` is applied first on purpose: `%2e%2e%2f` is a
 * double-encoded traversal and is only a traversal after decoding. Decoding can
 * throw on a malformed escape, which is itself a rejection.
 */
export function looksLikePathEscape(path: string): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed percent-escape is not a legal path.
    return true;
  }
  if (decoded.includes('..')) return true;
  if (decoded.includes('//')) return true;
  if (decoded.startsWith('/')) return true;
  if (decoded.includes('\0')) return true;
  // Backslash is a separator on Windows and in some GCS clients, so
  // `a\..\b` is a traversal even though it matches none of the patterns above.
  if (decoded.includes('\\')) return true;
  return false;
}

/** The shape a validated path is turned into, so a caller uses fields not parsing. */
export type ParsedMediaPath =
  | { readonly shape: 'staging'; readonly uid: string; readonly mediaId: string; readonly ext: string }
  | {
      readonly shape: 'final';
      readonly incidentId: string;
      readonly sub: 'reports' | 'supplements';
      readonly reportId: string;
      readonly mediaId: string;
      readonly ext: string;
    }
  | { readonly shape: 'quarantine'; readonly mediaId: string; readonly ext: string };

/**
 * The one function that decides whether a client-supplied path is acceptable.
 *
 * Returns `null` rather than throwing: a validator that throws cannot be used
 * inside a `for` loop over a report's media array without each iteration being
 * wrapped, and a wrapper that is forgotten turns one bad item into a rejected
 * report. The caller decides per-item, which is what docs/15 §5.3 requires.
 *
 * `callerUid` is a REQUIRED argument rather than being read from a context. The
 * ownership check is the single most important thing this function does, and a
 * signature that made it optional would let a future caller forget it — which is
 * the failure docs/15 §3.4 calls `403 UPLOAD_FORBIDDEN_PATH`.
 *
 * The ownership test is `path.split('/')[1] === callerUid`, matching docs/15
 * §3.4's contract exactly. It is a segment comparison rather than a `startsWith`
 * so that a uid of `abc` cannot claim the uploads of `abcdef`.
 */
export function validateMediaPath(path: string, callerUid: string): ParsedMediaPath | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return null;
  if (looksLikePathEscape(path)) return null;

  const staging = STAGING_PATH_RE.exec(path);
  if (staging !== null) {
    const [, uid, mediaId, ext] = staging;
    if (uid !== callerUid) return null;
    return { shape: 'staging', uid: uid as string, mediaId: mediaId as string, ext: ext as string };
  }

  const final = FINAL_PATH_RE.exec(path);
  if (final !== null) {
    const [, incidentId, sub, reportId, mediaId, ext] = final;
    return {
      shape: 'final',
      incidentId: incidentId as string,
      sub: sub as 'reports' | 'supplements',
      reportId: reportId as string,
      mediaId: mediaId as string,
      ext: ext as string,
    };
  }

  if (QUARANTINE_PATH_RE.test(path)) {
    // `exec` again rather than reusing a `test` result: the capture groups are only
    // populated by `exec`, and the alternative — `test` then `exec` — runs the
    // regex twice and reads as a bug the next time someone tidies it. A failure
    // here is impossible (the `test` just passed) and is handled anyway, because a
    // `null` return is the SAFE answer for an unparseable path.
    const quarantine = QUARANTINE_PATH_RE.exec(path);
    if (quarantine === null) return null;
    const [, mediaId, ext] = quarantine;
    if (mediaId === undefined || ext === undefined) return null;
    return { shape: 'quarantine', mediaId, ext };
  }

  return null;
}

/** Build a staging path. The ONLY way one is ever constructed. */
export function stagingPathFor(uid: string, mediaId: string, ext: string): string {
  return `staging/${uid}/${mediaId}.${ext}`;
}

/** Build a final evidence path. Server-side only; a client has no permission there. */
export function finalPathFor(
  incidentId: string,
  reportId: string,
  mediaId: string,
  ext: string,
  sub: 'reports' | 'supplements' = 'reports',
): string {
  return `incidents/${incidentId}/${sub}/${reportId}/${mediaId}.${ext}`;
}

/** Build a quarantine path. */
export function quarantinePathFor(mediaId: string, ext: string): string {
  return `quarantine/${mediaId}.${ext}`;
}

/* ========================================================================== */
/* Request schemas — docs/15 §8.1 steps 2 and 4                                 */
/* ========================================================================== */

/**
 * `POST /api/uploads/sign` body. docs/15 §8.1 step 2.
 *
 * The client contributes NOTHING to the path or the filename. It declares what it
 * *intends* to upload, and the server generates the id and the destination. The
 * fields here are all claims to be checked, and three of them are checked again
 * against the object's bytes in step 4.
 *
 * `intent` is a required enum with one member rather than omitted. It exists so a
 * signed URL is only ever issued for a report attachment, and so the string
 * `"report"` appears in the audit log — a future "profile photo" flow then has to
 * add a value here deliberately rather than inheriting this one.
 */
export const signUploadBodySchema = strictObject({
  kind: z.enum(['image', 'audio']),
  /** Checked against `ALLOWED_MEDIA[kind]`. */
  contentType: z.string().trim().max(120),
  /** Checked against the per-kind cap. docs/15 §7.1. */
  sizeBytes: z.number().int().min(1).max(15_728_640),
  /** Audio only. Checked against `maxAudioDurationSec`. */
  durationSec: z.number().int().min(1).max(300).optional(),
  /** Images only. Checked against `maxImageDimension`. */
  clientWidth: z.number().int().min(1).max(12_000).optional(),
  clientHeight: z.number().int().min(1).max(12_000).optional(),
  /** The local preview filename, for the dispatcher's display. NEVER a path. */
  displayName: z.string().trim().max(200).optional(),
  /** docs/15 §8.2 step 1. Did the client manage to strip EXIF? A record, not a gate. */
  exifStripped: z.boolean().optional(),
  intent: z.literal('report'),
});

export type SignUploadBody = z.infer<typeof signUploadBodySchema>;

/** What `POST /api/uploads/sign` returns. */
export const signUploadResponseSchema = z.object({
  mediaId: z.string(),
  storagePath: z.string(),
  uploadUrl: z.string().url(),
  /** Epoch millis. The client's clock is irrelevant; it compares against its own now. */
  expiresAt: z.number().int().positive(),
  /** The Storage PUT must be refused above this. Signed into the URL. */
  maxSizeBytes: z.number().int().positive(),
  /** The `Content-Type` the PUT must carry EXACTLY. Signed into the URL. */
  requiredContentType: z.string(),
  kind: z.enum(['image', 'audio']),
});

export type SignUploadResponse = z.infer<typeof signUploadResponseSchema>;

/**
 * `POST /api/uploads/finalize` body.
 *
 * A single `mediaId`, never a path. The server looks the path up from its own
 * claim record, so a client cannot finalize an object it did not upload — which is
 * the property that makes the 30-minute claim window in `sign-upload.ts` worth
 * having.
 */
export const finalizeUploadBodySchema = strictObject({
  mediaId: z.string().regex(MEDIA_ID_RE, 'A mediaId looks like med_XXXXXXXXXXXX.'),
});

export type FinalizeUploadBody = z.infer<typeof finalizeUploadBodySchema>;

/** What finalize returns — docs/15 §8.1 step 4. */
export const finalizeUploadResponseSchema = z.object({
  mediaId: z.string(),
  kind: z.enum(['image', 'audio']),
  /** SNIFFED, never the declared one. docs/15 §5.3. */
  verifiedContentType: z.string(),
  actualSizeBytes: z.number().int().nonnegative(),
  /** Over the whole object, for integrity and duplicate detection. */
  sha256: z.string().length(64),
  /**
   * `'pending'` when the sniff was inconclusive. docs/15 §5.2.4 and §5.3: the
   * object is accepted, but a human can look before a dispatcher relies on it.
   */
  scanStatus: z.enum(['clean', 'pending', 'quarantined']),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationSec: z.number().int().positive().nullable(),
});

export type FinalizeUploadResponse = z.infer<typeof finalizeUploadResponseSchema>;

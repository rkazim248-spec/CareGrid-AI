/**
 * ============================================================================
 * CareGrid AI — signed-URL issuance for evidence uploads
 * ============================================================================
 *
 * docs/15 §8.1 step 2. Turns a citizen's INTENT to upload into a destination and a
 * signed PUT URL.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PROPERTY THIS STEP EXISTS TO PROVIDE
 * ---------------------------------------------------------------------------
 * **The client contributes nothing to the path or the filename.**
 *
 * docs/15 §3.1: the staging path's `uid` segment is `token.uid` — SERVER-side — the
 * `mediaId` is server-generated, and the `ext` is server-derived from the SNIFFED
 * type. Every hazard in docs/15 §3.5 follows from that one decision: path
 * traversal, extension spoofing, control characters in a name, Unicode
 * homoglyphs, a 300-character Windows filename, and a filename that leaks a
 * timestamp and an app name into a path admins can list.
 *
 * A client that wanted to name its own destination would get a signed URL for a
 * path it chose. So the client sends only claims, and every claim is checked
 * against the allow-list and the caps HERE — before a token exists.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DECLARED TYPE IS CHECKED HERE *AND* THE SNIFFED TYPE LATER
 * ---------------------------------------------------------------------------
 * Because they answer different questions. This check stops an obvious mistake
 * cheaply, before a byte moves. The sniff in step 4 is the one that matters,
 * because it is the only one that reads the file. docs/15 §8.1 step 4 is OPTIONAL
 * — the incident-creation path re-sniffs regardless — which is exactly why the
 * cheap check cannot be the only check.
 */

import 'server-only';

import { randomBytes } from 'node:crypto';

import { AppError } from '@/lib/server/errors';
import { uploadConfig } from '@/lib/env.server';
import {
  ALLOWED_MEDIA,
  MEDIA_ID_ALPHABET,
  MEDIA_ID_BODY_LENGTH,
  MEDIA_LIMITS,
  mediaIdOk,
  stagingPathFor,
  type AllowedMediaType,
  type SignUploadBody,
  type SignUploadResponse,
} from '@/validators/upload';
import { signPutUrl } from '@/services/uploads/evidence-storage';

/* ========================================================================== */
/* mediaId generation — docs/15 §4                                              */
/* ========================================================================== */

/**
 * `med_` + 12 base32 characters, from `crypto.randomBytes`.
 *
 * **Server-side only, and the alternative is not acceptable.** A client-generated
 * `mediaId` would let a client enumerate or overwrite another user's media, and
 * `Math.random()` and `Date.now()` are not acceptable either: both are
 * predictable, and a predictable `mediaId` is a guessable upload path.
 *
 * The loop is bounded by `MEDIA_ID_BODY_LENGTH` (12), **not** by
 * `MEDIA_ID_ALPHABET.length` (32). Those are different numbers and confusing them
 * is a silent failure: the generator emits a 32-character body, `MEDIA_ID_RE`
 * demands exactly 12, and every id the server mints fails its own regex. The
 * result is a signed URL for a path Storage will refuse, and a citizen who cannot
 * upload anything. This is the bug this function shipped with, caught by the
 * closed-loop assertion in `paths.test.ts`.
 *
 * `bytes[i] % 32` is a modulo of 256 by 32, which is exactly uniform — the
 * residual bias everyone worries about does not exist when the divisor is a power
 * of two. Worth saying, because "is this biased?" is the right question to ask of
 * an id generator and the answer here is no.
 *
 * 60 bits of entropy across 100 000 objects is a ~4e-1 collision probability
 * (docs/15 §4), which is why the sweeper and the claim window exist to make a
 * collision harmless rather than why the id is longer.
 */
export function generateMediaId(): string {
  const bytes = randomBytes(MEDIA_ID_BODY_LENGTH);
  let out = '';
  for (let i = 0; i < MEDIA_ID_BODY_LENGTH; i += 1) {
    out += MEDIA_ID_ALPHABET[(bytes[i] as number) % MEDIA_ID_ALPHABET.length];
  }
  return `med_${out}`;
}

/* ========================================================================== */
/* Claim records — docs/15 §8.1 step 2                                          */
/* ========================================================================== */

/**
 * The 30-minute claim window.
 *
 * In-memory, and that is a deliberate, bounded, documented choice rather than an
 * oversight. A claim record says "this uid was issued this mediaId, at this size,
 * for this content type" — and its ONLY job is to stop a client finalizing or
 * attaching an object it did not upload.
 *
 * An in-memory store is adequate for that because the check it enables is also
 * re-derived from Storage on the next call: step 4 range-reads the object and
 * re-sniffs, and step 5 re-sniffs again. A lost claim record therefore costs a
 * faster failure path, not a security property.
 *
 * A Firestore-backed claim store would be more correct across a cold start and is
 * NOT built here, because it would add a write to the most latency-sensitive
 * endpoint in the product for a check that two other steps already perform. This
 * is recorded in `docs/30.6` rather than left to be discovered.
 */
export type Claim = {
  readonly uid: string;
  readonly mediaId: string;
  readonly storagePath: string;
  readonly contentType: AllowedMediaType;
  readonly declaredSizeBytes: number;
  readonly issuedAtMs: number;
  readonly kind: 'image' | 'audio';
  /**
   * The duration the CLIENT measured, kept so finalize can report it back without
   * re-measuring.
   *
   * **This is a claim, not a control, and is deliberately not verified.** The
   * audio caps that are actually enforced are the byte cap (a 15 MB cap on an
   * Opus stream bounds the duration) and the client's own auto-stop. A server-side
   * duration check would mean parsing a container, and for `audio/mp4` the `moov`
   * atom is routinely at the END of the file (docs/15 §5.2.5) — so the check
   * would cost a full download of a 15 MB object to learn a number that is not
   * security-relevant. The `null` case is fine: a caller that needs a duration
   * displays nothing rather than a wrong one.
   */
  readonly durationSec: number | undefined;
};

const claims = new Map<string, Claim>();

/** Exported for the sweeper and for tests. Not a security boundary on its own. */
export function claimFor(uid: string, mediaId: string): Claim | null {
  const claim = claims.get(`${uid}/${mediaId}`);
  if (claim === undefined) return null;
  if (Date.now() - claim.issuedAtMs > uploadConfig().stagingSweepMin * 60_000) {
    claims.delete(`${uid}/${mediaId}`);
    return null;
  }
  return claim;
}

/** Forget a claim. Called after the object has been moved or deleted. */
export function releaseClaim(uid: string, mediaId: string): void {
  claims.delete(`${uid}/${mediaId}`);
}

/** Test seam. */
export function resetClaimsForTests(): void {
  claims.clear();
}

/* ========================================================================== */
/* The sign service — docs/15 §8.1 step 2                                        */
/* ========================================================================== */

/**
 * Issue a signed PUT URL for one media item.
 *
 * Every check here is on a CLAIM, and every one of them can refuse. The order is
 * the order in which a person's effort is cheapest to reject:
 *
 *   1. **kind matches the type** — a caller asking to sign an `audio/webm` as an
 *      `image` is refused before anything else is examined.
 *   2. **the type is in the allow-list for that kind** — §5.1, and the allow-list
 *      is the single source shared with the rules and the client.
 *   3. **the size is within the per-kind cap** — §7.1. Checked against
 *      `ALLOWED_MEDIA`, not against a constant, so changing the table changes
 *      this too.
 *   4. **the audio duration is within the cap** — §7.1. A duration is a CLAIM and
 *      is not trusted later; the size cap and the sniff are the controls.
 *   5. **the image dimensions are within the caps** — §9.1. Also a claim, and
 *      again re-read from the header in the sniff.
 *
 * `maxSizeBytes` in the response is signed INTO the URL, so a modified client that
 * sends a bigger file is refused by Google rather than by us, before the bytes
 * land.
 */
export async function signUpload(
  uid: string,
  body: SignUploadBody,
): Promise<SignUploadResponse> {
  const { maxImageBytes, maxAudioBytes, maxAudioDurationSec } = uploadConfig();

  // --- 1. does the type belong to the claimed kind? ---------------------
  const entry = ALLOWED_MEDIA[body.contentType as AllowedMediaType];
  if (entry === undefined) {
    throw new AppError({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message:
        'That file type is not supported. Photos must be JPG, PNG or WebP; a voice note must be WebM, M4A or MP3.',
    });
  }
  if (entry.kind !== body.kind) {
    // A caller cannot sign an audio upload as an image to get a different cap.
    throw new AppError({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'That file type does not match the kind of evidence being uploaded.',
    });
  }

  // --- 2. the per-kind size cap ----------------------------------------
  // Both numbers are considered and the SMALLER wins, so lowering an environment
  // variable tightens the control and raising one cannot exceed the table.
  const tableCap = entry.maxBytes;
  const envCap = body.kind === 'image' ? maxImageBytes : maxAudioBytes;
  const maxSizeBytes = Math.min(tableCap, envCap);
  if (body.sizeBytes > maxSizeBytes) {
    throw new AppError({
      code: 'UPLOAD_TOO_LARGE',
      message:
        body.kind === 'image'
          ? 'Photos must be under 5 MB. Try a smaller photo, or take a new one.'
          : 'That recording is too large. Record a shorter voice note.',
    });
  }

  // --- 3. the audio duration cap ---------------------------------------
  if (body.kind === 'audio') {
    if (body.durationSec === undefined) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'A voice note must state how long it is, so we can check it against the limit.',
        details: [{ field: 'durationSec', issue: 'required for audio' }],
      });
    }
    const cap = Math.min(MEDIA_LIMITS.maxAudioDurationSec, maxAudioDurationSec);
    if (body.durationSec > cap) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: `Voice notes are limited to ${cap} seconds.`,
        details: [{ field: 'durationSec', issue: `must be at most ${cap}` }],
      });
    }
  }

  // --- 4. the image dimension caps -------------------------------------
  if (body.kind === 'image') {
    const width = body.clientWidth;
    const height = body.clientHeight;
    if (width === undefined || height === undefined) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'A photo must state its dimensions, so we can check them against the limit.',
        details: [{ field: 'clientWidth', issue: 'required for an image' }],
      });
    }
    if (width > MEDIA_LIMITS.maxImageDimension || height > MEDIA_LIMITS.maxImageDimension) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'That photo is too large to process. Try a smaller one.',
        details: [{ field: 'clientWidth', issue: `must be at most ${MEDIA_LIMITS.maxImageDimension}px` }],
      });
    }
    if (width * height > MEDIA_LIMITS.maxImageMegapixels * 1_000_000) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'That photo has too many pixels. Try a smaller one.',
        details: [{ field: 'clientWidth', issue: `must be under ${MEDIA_LIMITS.maxImageMegapixels} megapixels` }],
      });
    }
  }

  // --- 5. the server names everything ----------------------------------
  const mediaId = generateMediaId();
  // A belt-and-braces assertion. `mediaIdOk` is also enforced by `storage.rules`
  // and by the path regexes, and three independent gates is what docs/15 §4 asks
  // for — but if the generator is ever changed and produces a non-conforming id,
  // this fails HERE with a clear message rather than producing a signed URL for a
  // path Storage will refuse.
  if (!mediaIdOk(mediaId)) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Could not prepare an upload reference.',
    });
  }

  const ext = entry.ext;
  const storagePath = stagingPathFor(uid, mediaId, ext);

  claims.set(`${uid}/${mediaId}`, {
    uid,
    mediaId,
    storagePath,
    contentType: body.contentType as AllowedMediaType,
    declaredSizeBytes: body.sizeBytes,
    issuedAtMs: Date.now(),
    kind: body.kind,
    durationSec: body.durationSec,
  });

  const { uploadUrl, expiresAt } = await signPutUrl(storagePath, body.contentType, maxSizeBytes);

  return {
    mediaId,
    storagePath,
    uploadUrl,
    expiresAt,
    maxSizeBytes,
    requiredContentType: body.contentType,
    kind: body.kind,
  };
}

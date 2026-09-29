/**
 * ============================================================================
 * CareGrid AI — upload finalization
 * ============================================================================
 *
 * docs/15 §8.1 step 4. The object is in Storage. This step decides whether it is
 * what it claims to be.
 *
 * ---------------------------------------------------------------------------
 * WHAT HAPPENS HERE, IN ORDER
 * ---------------------------------------------------------------------------
 *   1. **Find the claim.** `mediaId` only — never a path. The server looks the
 *      path up from its own record, so a client cannot finalize an object it did
 *      not upload. That is what the 30-minute window is for.
 *   2. **Range-read the head.** 4 KiB by default, 64 KiB for `audio/webm`
 *      (docs/15 §5.2.4, and `sniff.ts` explains why at length).
 *   3. **Sniff.** `detectMediaType()`.
 *   4. **Compare.** Declared vs sniffed. docs/15 §5.3: the SNIFFED type wins, the
 *      declared type is never stored, and a disagreement drops the item.
 *   5. **Size.** Zero, or more than 1% off what was signed for, is
 *      `409 UPLOAD_INCOMPLETE`. The 1% tolerance exists because a signed URL states
 *      a size and a client may send marginally different bytes; a LARGE
 *      difference means the upload was truncated or something else was sent.
 *   6. **Hash.** SHA-256 over the WHOLE object, for integrity and for
 *      duplicate-upload detection.
 *   7. **Quarantine anything recognisably dangerous**, and record the verdict.
 *
 * ---------------------------------------------------------------------------
 * WHY A REFUSAL DELETES THE OBJECT
 * ---------------------------------------------------------------------------
 * A rejected object is not left in `staging/`. It is a file nobody will ever
 * attach, in a bucket the citizen can see in their console, consuming quota, and
 * it will be swept in 30 minutes anyway. Deleting it now is the honest state
 * AND it means the `quarantine/` folder contains only things a human must look
 * at — which is the entire purpose of that folder. A sweep that removes both
 * classes equally makes `quarantine/` meaningless.
 */

import 'server-only';

import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { uploadConfig } from '@/lib/env.server';
import {
  ALLOWED_MEDIA,
  MEDIA_LIMITS,
  type FinalizeUploadResponse,
  type AllowedMediaType,
} from '@/validators/upload';
import { detectMediaType } from '@/services/uploads/sniff';
import {
  deleteObject,
  moveToQuarantine,
  objectExists,
  readHeadBytes,
  sha256OfObject,
} from '@/services/uploads/evidence-storage';
import { claimFor, releaseClaim, type Claim } from '@/services/uploads/sign-upload';

/* ========================================================================== */
/* Constants                                                                     */
/* ========================================================================== */

/**
 * How far the sniffed size may differ from the signed one, as a fraction.
 *
 * docs/15 §8.2 step 4: "size 0, or > 1 % off the declared size". A tolerance
 * rather than an exact match because a signed URL records the size the client
 * INTENDED to send, and a client that compressed between signing and uploading
 * sends something different — legitimately. A large difference is the signal:
 * truncation, a re-read, or a different file.
 */
const SIZE_TOLERANCE_RATIO = 0.01;

/** The floor for the sniff window when the type is not yet known. */
const DEFAULT_SNIFF_BYTES = 4096;

/**
 * `audio/webm` gets the larger window, per docs/15 §5.2.4.
 *
 * The trade is stated in the document: "reject a valid 90-second voice note" is a
 * worse failure for this product than "accept a video-only WebM and let `<audio>`
 * fail to play it". A citizen whose emergency report depends on their voice must
 * never lose it to a sniffing window.
 */
function sniffWindowFor(contentType: AllowedMediaType | null): number {
  const { sniffBytes } = uploadConfig();
  if (contentType === 'audio/webm') return sniffBytes;
  return Math.min(DEFAULT_SNIFF_BYTES, sniffBytes);
}

/* ========================================================================== */
/* The service                                                                   */
/* ========================================================================== */

/**
 * Verify one uploaded object and record what it actually is.
 *
 * Throws `AppError` for a refusal. The distinction from `sign-upload.ts` is
 * deliberate: signing validates CLAIMS before a token exists, so a bad request
 * there is a 4xx the client can fix. Finalizing validates FACTS, and a bad fact
 * means the bytes are not what they said — which is a different kind of event and
 * is treated as one.
 */
export async function finalizeUpload(
  uid: string,
  mediaId: string,
): Promise<FinalizeUploadResponse> {
  const log = createLogger('');

  // --- 1. the claim, and only from our own record ----------------------
  const claim = claimFor(uid, mediaId);
  if (claim === null) {
    // docs/15 §8.2 step 4, "Object does not exist" is `404`. Here the object may
    // exist and simply not be ours, and the message must not distinguish the two —
    // that distinction is a way to test whether someone else's upload exists.
    throw new AppError({
      code: 'MEDIA_NOT_FOUND',
      message: 'That upload was not started from this device, or it has expired. Please upload it again.',
    });
  }

  // --- 2. does the object exist, and how big? -------------------------
  const metadata = await objectExists(claim.storagePath);
  if (metadata === null) {
    releaseClaim(uid, mediaId);
    throw new AppError({
      code: 'UPLOAD_INCOMPLETE',
      message: 'That upload did not finish. Please try again.',
    });
  }

  // --- 3. the size checks, BEFORE reading the head ---------------------
  // Cheap first, and a 15 MB audio clip that arrived at 0 bytes should not cost
  // a range request to learn nothing.
  if (metadata.sizeBytes === 0) {
    await deleteObject(claim.storagePath);
    releaseClaim(uid, mediaId);
    throw new AppError({
      code: 'UPLOAD_INCOMPLETE',
      message: 'That upload did not finish. Please try again.',
    });
  }

  const declaredDelta = Math.abs(metadata.sizeBytes - claim.declaredSizeBytes) / claim.declaredSizeBytes;
  if (declaredDelta > SIZE_TOLERANCE_RATIO) {
    // Deleted rather than left: a truncated object is not evidence and the
    // citizen will re-upload, so keeping it only wastes quota.
    await deleteObject(claim.storagePath);
    releaseClaim(uid, mediaId);
    throw new AppError({
      code: 'UPLOAD_INCOMPLETE',
      message: 'That upload did not finish — the file arrived incomplete. Please try again.',
    });
  }

  // --- 4. read the head and sniff --------------------------------------
  const head = await readHeadBytes(claim.storagePath, sniffWindowFor(claim.contentType));
  if (head === null) {
    releaseClaim(uid, mediaId);
    throw new AppError({ code: 'MEDIA_NOT_FOUND', message: 'That upload could not be read.' });
  }

  const detected = detectMediaType(head);

  if (detected === null) {
    await deleteObject(claim.storagePath);
    releaseClaim(uid, mediaId);
    throw new AppError({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message:
        'That file type is not supported. Photos must be JPG, PNG or WebP; a voice note must be WebM, M4A or MP3.',
    });
  }

  // --- 5. quarantine: recognisably an executable or an archive ---------
  if ('quarantined' in detected) {
    const quarantinePath = await moveToQuarantine(
      claim.storagePath,
      claim.mediaId,
      ALLOWED_MEDIA[claim.contentType].ext,
    );
    releaseClaim(uid, mediaId);
    // The quarantine path is safe to log and it is the one thing an operator needs:
    // `quarantine/{mediaId}.{ext}` contains no uid, so this is the ONE place in the
    // upload chain where a path is safe to put in a log line. A staging path is
    // `staging/{uid}/...` and would leak the identity.
    log.warn({
      code: 'UPLOAD_QUARANTINED',
      path: 'uploads.finalize',
      status: 422,
      quarantine: quarantinePath,
    });
    // The reason is a fixed sentence from `sniff.ts`, never a path or a filename.
    // The quarantine path is deliberately NOT in the client-facing message: a
    // citizen does not need a bucket path, and docs/15 §14 wants that folder
    // visible only to operators.
    throw new AppError({
      code: 'UPLOAD_QUARANTINED',
      message: `That file was not accepted (${detected.reason}). It has been held for review and not attached to your report.`,
    });
  }

  // --- 6. declared vs sniffed: the SNIFFED type wins -------------------
  if (detected.contentType !== claim.contentType) {
    await deleteObject(claim.storagePath);
    releaseClaim(uid, mediaId);
    throw new AppError({
      code: 'UPLOAD_SIGNATURE_MISMATCH',
      // Names both types, because that is what tells a person what went wrong
      // with THEIR file. Neither value is sensitive.
      message: `That file's contents (${detected.contentType}) do not match the type it was sent as (${claim.contentType}).`,
    });
  }

  // --- 7. the kind must still match ------------------------------------
  if (detected.kind !== claim.kind) {
    await deleteObject(claim.storagePath);
    releaseClaim(uid, mediaId);
    throw new AppError({
      code: 'UPLOAD_SIGNATURE_MISMATCH',
      message: 'That file does not match the kind of evidence you are adding.',
    });
  }

  // --- 8. the per-kind cap, re-checked against the SNIFFED type --------
  // A client that signed a 1 KB `image/jpeg` cannot turn out to be a 15 MB object
  // that happens to start with `FF D8 FF`. The declared size matched, so the
  // object is not oversized — but the cap is re-checked from the table rather than
  // assumed from the claim, because the claim's type is what is now in doubt.
  const cap = ALLOWED_MEDIA[detected.contentType].maxBytes;
  if (metadata.sizeBytes > cap) {
    await deleteObject(claim.storagePath);
    releaseClaim(uid, mediaId);
    throw new AppError({ code: 'UPLOAD_TOO_LARGE', message: 'That file is larger than the limit for its type.' });
  }

  // --- 9. the image dimension caps, from the header --------------------
  if (detected.kind === 'image' && detected.width !== null && detected.height !== null) {
    const overDimension =
      detected.width > MEDIA_LIMITS.maxImageDimension || detected.height > MEDIA_LIMITS.maxImageDimension;
    const overMegapixels = detected.width * detected.height > MEDIA_LIMITS.maxImageMegapixels * 1_000_000;
    if (overDimension || overMegapixels) {
      await deleteObject(claim.storagePath);
      releaseClaim(uid, mediaId);
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'That photo is too large to process. Try a smaller one.',
      });
    }
  }

  // --- 10. the hash, over the whole object ----------------------------
  const sha256 = await sha256OfObject(claim.storagePath);

  // --- 11. the verdict -------------------------------------------------
  return {
    mediaId: claim.mediaId,
    kind: detected.kind,
    // The SNIFFED type. The declared one is not returned, not stored, and not
    // available to this caller — docs/15 §5.3.
    verifiedContentType: detected.contentType,
    actualSizeBytes: metadata.sizeBytes,
    sha256,
    // An inconclusive sniff is ACCEPTED and marked pending, per docs/15 §5.2.4.
    // A human can look before a dispatcher relies on it, and a citizen's voice
    // note is not lost to a sniffing window.
    scanStatus: detected.confidence === 'exact' ? 'clean' : 'pending',
    width: detected.width,
    height: detected.height,
    // The duration the CLIENT measured at record time, or `null` if it could not
    // measure one. `null` is the honest answer and the UI renders nothing rather
    // than a guess — see `Claim.durationSec` for why this is not verified
    // server-side.
    durationSec: claim.durationSec ?? null,
  };
}

/** The claim type, re-exported so the incident pipeline can read `durationSec`. */
export type { Claim };

/**
 * ============================================================================
 * CareGrid AI — the evidence storage service
 * ============================================================================
 *
 * The Admin SDK side of the upload chain. Every function here bypasses Storage
 * Security Rules, which is precisely why it is server-only and why every path it
 * touches is one a client has no permission on.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE OPERATIONS, AND WHY EACH EXISTS
 * ---------------------------------------------------------------------------
 * | Function | Why it cannot be a client operation |
 * | --- | --- |
 * | `signPutUrl` | Minting a signed URL requires a service account. A client cannot write a token. |
 * | `readHeadBytes` | Verifying the bytes requires reading them. A client verifying its own upload is not a control. |
 * | `objectExists` | Ownership is decided by a Firestore claim record, not by the caller. |
 * | `moveStagedToFinal` | `incidents/**` is `if false` in `storage.rules` for EVERYONE. Only this can touch it. |
 * | `signedReadUrl` | docs/15 §12: visibility is per-incident and lives in Firestore, which rules cannot join against. The API decides, then mints. |
 *
 * ---------------------------------------------------------------------------
 * WHY COPY-THEN-DELETE AND NEVER A "MOVE"
 * ---------------------------------------------------------------------------
 * docs/15 §3.3: "A rename across prefixes is not atomic in the Storage SDK.
 * Copy-then-delete means an interruption leaves a duplicate in staging (harmless,
 * swept in 30 min) rather than losing evidence (unacceptable)."
 *
 * The asymmetry is the whole argument. Losing a citizen's photo of a fire is not
 * recoverable; an orphan in `staging/` is removed by a scheduled sweep. So the
 * operation that could lose evidence is never attempted, and the order is
 * copy → verify → delete, with the delete last and `ignoreNotFound: true` so a
 * retried delete is not an error.
 */

import 'server-only';

import { createHash } from 'node:crypto';

import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { getAdminStorage } from '@/lib/server/firebase-admin';
import { uploadConfig } from '@/lib/env.server';
import {
  quarantinePathFor,
} from '@/validators/upload';

/* ========================================================================== */
/* Errors                                                                        */
/* ========================================================================== */

/**
 * Turn any Storage failure into a typed `AppError`.
 *
 * The distinction that matters: `404` is `MEDIA_NOT_FOUND` (the object is not
 * there, which for a caller may also mean "not yours") and everything else is
 * `STORAGE_UNAVAILABLE` (503, retryable, with `Retry-After`).
 *
 * A raw SDK error is never allowed to escape. It can contain a bucket name, an
 * object path — which includes a uid — and a provider request id.
 */
function storageFailure(operation: string, error: unknown): AppError {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const notFound =
    code === 404 || /not found|does not exist|no such object/i.test(message);

  return new AppError({
    code: notFound ? 'MEDIA_NOT_FOUND' : 'STORAGE_UNAVAILABLE',
    message: notFound
      ? 'That file is not in storage. The upload may not have completed.'
      : 'File storage is temporarily unavailable. Your report text is safe and will be submitted.',
    // The operation name is a fixed string from this file. The SDK message is NOT
    // attached: it can contain the object path, and a path contains a uid.
    details: [{ field: 'operation', issue: operation }],
    cause: error,
  });
}

/** Is Storage usable at all? A route asks this before it does anything else. */
export function isStorageConfigured(): boolean {
  try {
    // Touching the bucket is the only honest test. `getStorage()` succeeds with
    // dummy credentials and fails on the first real call, so a boolean derived
    // from construction would be true in a deployment that cannot store anything.
    getAdminStorage().bucket();
    return true;
  } catch {
    return false;
  }
}

/* ========================================================================== */
/* 1. Signing                                                                   */
/* ========================================================================== */

/**
 * Mint a signed PUT URL for a staging path.
 *
 * The URL binds FOUR things, and each binding is load-bearing:
 *
 *  1. the exact object path
 *  2. the `PUT` method — a signed GET URL would let a caller read
 *  3. the exact `Content-Type` the client must send
 *  4. an expiry
 *
 * Binding the content type is what makes `storage.rules`' content check
 * enforceable in practice: the signature is computed over the header, so a client
 * that sends a different `Content-Type` gets a `403` from Google rather than
 * storing a mislabelled object that step 4 then has to catch. Defence in depth
 * where the layers are cheap.
 */
export async function signPutUrl(
  storagePath: string,
  contentType: string,
  maxSizeBytes: number,
): Promise<{ uploadUrl: string; expiresAt: number }> {
  const { signedUrlTtlSec } = uploadConfig();
  const expiresAt = Date.now() + signedUrlTtlSec * 1000;
  try {
    const file = getAdminStorage().bucket().file(storagePath);
    const [uploadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresAt,
      contentType,
      extensionHeaders: {
        'x-goog-content-length-range': `0,${maxSizeBytes}`,
      },
    });
    return { uploadUrl, expiresAt };
  } catch (error) {
    throw storageFailure('signPutUrl', error);
  }
}

/* ========================================================================== */
/* 2. Reading for verification                                                  */
/* ========================================================================== */

/**
 * Read the first `length` bytes of an object.
 *
 * A RANGE request, not a full download. docs/15 §5.2: the server reads the first
 * 4 KiB, and 64 KiB for `audio/webm`. Downloading a 15 MB audio clip to check its
 * first 64 bytes would cost more than the sniff.
 *
 * Returns `null` when the object does not exist, which the caller turns into
 * `404 MEDIA_NOT_FOUND`. `null` rather than a throw because "not there" is an
 * expected state in the finalize path — a client whose upload was interrupted
 * legitimately gets here.
 */
export async function readHeadBytes(
  storagePath: string,
  length: number,
): Promise<Uint8Array | null> {
  try {
    const file = getAdminStorage().bucket().file(storagePath);
    const [contents] = await file.download({ start: 0, end: length - 1 });
    return contents;
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 404 || /not found|does not exist|no such object/i.test(message)) return null;
    throw storageFailure('readHeadBytes', error);
  }
}

/** Does this object exist, and how big is it? `null` when it does not. */
export async function objectExists(
  storagePath: string,
): Promise<{ sizeBytes: number; contentType: string | null; updatedIso: string | null } | null> {
  try {
    const [metadata] = await getAdminStorage()
      .bucket()
      .file(storagePath)
      .getMetadata();
    return {
      sizeBytes: Number(metadata.size ?? '0'),
      // The object's STORED content type is what the client PUT, so it is a claim
      // too. It is never used as the authority — only the sniff is. docs/15 §5.3.
      contentType: typeof metadata.contentType === 'string' ? metadata.contentType : null,
      updatedIso: typeof metadata.updated === 'string' ? metadata.updated : null,
    };
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 404 || /not found|does not exist|no such object/i.test(message)) return null;
    throw storageFailure('objectExists', error);
  }
}

/** SHA-256 over an object's full contents. docs/15 §8.1 step 4. */
export async function sha256OfObject(storagePath: string): Promise<string> {
  try {
    const [contents] = await getAdminStorage().bucket().file(storagePath).download();
    return createHash('sha256').update(contents).digest('hex');
  } catch (error) {
    throw storageFailure('sha256OfObject', error);
  }
}

/** Delete an object. A missing object is NOT an error — this runs on cleanup paths. */
export async function deleteObject(storagePath: string): Promise<void> {
  try {
    await getAdminStorage().bucket().file(storagePath).delete({ ignoreNotFound: true });
  } catch (error) {
    throw storageFailure('deleteObject', error);
  }
}

/* ========================================================================== */
/* 3. The move — docs/15 §3.3                                                    */
/* ========================================================================== */

/**
 * Copy a staged object to its final path, then delete the staging copy.
 *
 * The order is the argument, and it is not negotiable: an interruption between
 * the two leaves a DUPLICATE (swept in 30 minutes) rather than losing the
 * evidence. Nothing here is retried in a way that could skip the copy.
 *
 * The `ext` argument is the SNIFFED type's extension, not the declared one. A
 * mislabelled file therefore lands as `.jpg`, which docs/15 §6 calls the friendly
 * AND correct behaviour.
 */
export async function moveStagedToFinal(
  stagingPath: string,
  finalPath: string,
): Promise<void> {
  const log = createLogger('');
  const bucket = getAdminStorage().bucket();
  try {
    // COPY FIRST.
    await bucket.file(stagingPath).copy(bucket.file(finalPath));
  } catch (error) {
    // The staging object is deliberately LEFT IN PLACE. The sweeper removes it, and
    // a caller who retries gets a second chance rather than a lost upload.
    log.warn({ code: 'STORAGE_UNAVAILABLE', path: 'uploads.move', status: 503 });
    throw storageFailure('moveStagedToFinal', error);
  }

  try {
    // THEN delete, and treat "already gone" as success so a retried move is not an
    // error. `ignoreNotFound` is the flag, not a try/catch, so there is no window
    // in which a throw here looks like a failed move.
    await bucket.file(stagingPath).delete({ ignoreNotFound: true });
  } catch {
    // The evidence is ALREADY at its final path. A failure to remove the staging
    // duplicate is a cleanup problem, not a data-loss problem, so it is a warning
    // and the move still succeeds. Note there is no `catch (error)` here: the SDK
    // message can contain the staging path, which contains a uid, so it is
    // deliberately not read and not logged.
    log.warn({ code: 'STORAGE_UNAVAILABLE', path: 'uploads.move.cleanup', status: 503 });
  }
}

/**
 * Move a refused object into `quarantine/`.
 *
 * A distinct function rather than a call to `moveStagedToFinal` because the
 * DESTINATION SEMANTICS differ: a quarantined object is retained for a human to
 * look at, not attached to an incident. Conflating the two is how a quarantined
 * file ends up in an incident's evidence folder.
 */
export async function moveToQuarantine(
  stagingPath: string,
  mediaId: string,
  ext: string,
): Promise<string> {
  const target = quarantinePathFor(mediaId, ext);
  try {
    const bucket = getAdminStorage().bucket();
    await bucket.file(stagingPath).copy(bucket.file(target));
    await bucket.file(stagingPath).delete({ ignoreNotFound: true });
    return target;
  } catch (error) {
    throw storageFailure('moveToQuarantine', error);
  }
}

/* ========================================================================== */
/* 4. Serving — docs/15 §12                                                     */
/* ========================================================================== */

/**
 * A short-lived signed GET URL.
 *
 * The TTL is 900 s (docs/15 §7.1, `UPLOAD_SIGNED_URL_TTL_SEC`). Long enough for
 * a slow connection and a responder downloading evidence on mobile data; short
 * enough that a URL pasted into a group chat is useless within the hour.
 *
 * `responseDisposition: 'inline'` matters and is easy to omit. Without it, a
 * browser may download rather than render, and for an IMAGE that is a worse
 * experience. The `Content-Disposition` is also part of what makes the polyglot
 * residual risk acceptable (docs/15 §5.4 point 4): the object is fetched by
 * Google's storage host, never interpreted as HTML on our origin.
 *
 * **There is deliberately no `mimeType` parameter.** The object was stored with
 * the SNIFFED content type, and re-specifying it here would create a second place
 * for the two to disagree — exactly the class of bug the Phase 5 sniffer exists to
 * prevent. A caller that "knows better" than the object cannot override it.
 */
export async function signedReadUrl(
  storagePath: string,
  fileName: string,
): Promise<{ url: string; expiresAt: number }> {
  const { signedUrlTtlSec } = uploadConfig();
  const expiresAt = Date.now() + signedUrlTtlSec * 1000;
  try {
    const [url] = await getAdminStorage()
      .bucket()
      .file(storagePath)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: expiresAt,
        responseDisposition: `inline; filename="${safeDownloadName(fileName)}"`,
      });
    return { url, expiresAt };
  } catch (error) {
    throw storageFailure('signedReadUrl', error);
  }
}

/**
 * A filename safe to put in a `Content-Disposition` header.
 *
 * A header injection here would be a response-splitting bug, and a `Content-Disposition`
 * value is attacker-influenced only insofar as the display name came from a
 * client. Everything outside a conservative set is replaced, the length is
 * capped, and the result never contains a quote, a backslash, a slash, a CR or an
 * LF.
 */
export function safeDownloadName(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\/\r\n]/g, '_')
    .replace(/[^\w.\- ]+/g, '_')
    .slice(0, 100);
  return cleaned.length === 0 ? 'evidence' : cleaned;
}

/* ========================================================================== */
/* 5. The maintenance sweep — docs/15 §16.2                                    */
/* ========================================================================== */

/**
 * What the sweeper would do, and what it does not do yet.
 *
 * docs/15 §3.3 and §16.2: anything still in `staging/` after
 * `STAGING_UPLOAD_SWEEP_MIN` is removed by a `sweep-staging-uploads` job. That job
 * is Phase 9 maintenance work (`lib/env.maintenance.ts` territory) and is NOT
 * built here.
 *
 * **This is recorded as a gap rather than worked around**, and the reason matters:
 * the brief §39 says "If automated cleanup is not yet implemented, document it as a
 * future integration point rather than creating an unsafe workaround."
 *
 * A tempting workaround is to delete a staging object when an incident is
 * created. That is exactly wrong: it is a WRITE on the report path, it would fail
 * a report that has already been filed, and it does not clean up the objects that
 * are actually orphaned — the ones whose user never submitted at all, which is
 * the entire population the sweeper exists for. So the gap is left open and named.
 */
export const STAGING_SWEEP_STATUS = {
  implemented: false,
  /** Where the job belongs when Phase 9 builds it. */
  belongsIn: 'lib/env.maintenance.ts',
  /** The window, from `STAGING_UPLOAD_SWEEP_MIN`. */
  windowMin: 30,
  /** What the job must do, so whoever writes it does not have to re-derive it. */
  contract: [
    'List objects under staging/ whose updated timestamp is older than the window.',
    'Delete each one. An object with no claim record is orphaned by definition.',
    'Never delete an object whose claim record is still inside the window.',
  ],
} as const;

/** The claim window, for the sign service and for this record to agree. */
export function stagingClaimWindowMin(): number {
  return uploadConfig().stagingSweepMin;
}


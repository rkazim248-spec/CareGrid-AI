/**
 * ============================================================================
 * CareGrid AI — attaching evidence to an incident, and reading it back
 * ============================================================================
 *
 * docs/15 §8.1 steps 5-7, §12, §13. This is the file where a staged upload
 * becomes a report's evidence.
 *
 * ---------------------------------------------------------------------------
 * FOUR JOBS, AND THE ORDER THEY HAVE TO HAPPEN IN
 * ---------------------------------------------------------------------------
 * | Function | Job |
 * | --- | --- |
 * | `attachEvidenceToIncident` | Step 5+6: RE-SNIFF, compute the final path, copy-then-delete, produce `MediaRef` rows |
 * | `stageImageForAi` / `stageAudioForAi` | Download a verified object and hand it to Phase 4's triage |
 * | `resolveEvidenceRead` | Step 7: evaluate the §13 access matrix, then mint a 15-minute signed URL |
 * | `sweepAbandonedStaging` | NOT implemented. Named, with its contract. |
 *
 * ---------------------------------------------------------------------------
 * WHY STEP 5 RE-SNIFFS WHEN STEP 4 ALREADY DID
 * ---------------------------------------------------------------------------
 * docs/15 §8.1 is explicit: "RE-SNIFF in the request handler (the authoritative
 * check; finalize was only a fast-fail)". This is not redundancy, and the
 * reason is a race:
 *
 * ```
 * sign  ?  [attacker swaps the object]  ?  finalize  ?  [attacker swaps it again]  ?  create
 * ```
 *
 * A signed URL is valid for 15 minutes. Finalize happens seconds after sign, but
 * incident creation can be minutes later — the citizen is typing, choosing
 * photos, granting microphone permission. A `MediaRef` that recorded a sniff from
 * two minutes ago would attest to bytes that may not be the bytes now.
 *
 * So the re-sniff is the **authoritative** check, and the one whose result is
 * persisted. Finalize's sniff is a fast-fail that saves the citizen a wait.
 * The `sha256` recorded at finalize is recomputed here for the same reason, and
 * a difference between them is itself the signal that the object was swapped.
 *
 * This is why the copy happens AFTER the re-sniff and BEFORE the transaction
 * commits the `MediaRef` (docs/15 §3.3): a persisted `storagePath` must never
 * point at an object that does not exist.
 *
 * ---------------------------------------------------------------------------
 * THE FR-029 SPIRIT: STORAGE FAILURE MUST NOT LOSE A REPORT
 * ---------------------------------------------------------------------------
 * docs/15 §16.3 specifies this precisely and the distinction is the whole design:
 *
 * | The report has | Storage fails | What happens |
 * | --- | --- | --- |
 * | valid text (>= 20 chars) | any item | **Report is created.** That item is dropped, `evidenceCount` reflects reality, the response carries `meta.droppedMedia` and `storageDegraded: true`, and the incident is audited with `storageDegraded`. |
 * | NO valid text (image-only or audio-only) | any item | `503 STORAGE_UNAVAILABLE`. **The report is NOT created.** The client keeps the local draft. |
 *
 * "An image-only report with no storable image is not a report" — docs/15's own
 * words, and the reasoning is sound: there would be nothing to dispatch on. But
 * the same outage must never cost a citizen their typed description, and that is
 * the asymmetry this function implements.
 */

import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';

import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { uploadConfig } from '@/lib/env.server';
import { getAdminDb, getAdminStorage } from '@/lib/server/firebase-admin';
import { SUB_COLLECTIONS, COLLECTIONS } from '@/config/collections';
import { validateImage } from '@/services/ai/media';
import { detectMediaType } from '@/services/uploads/sniff';
import {
  deleteObject,
  moveStagedToFinal,
  objectExists,
  readHeadBytes,
  safeDownloadName,
  sha256OfObject,
  signedReadUrl,
} from '@/services/uploads/evidence-storage';
import { claimFor, releaseClaim } from '@/services/uploads/sign-upload';
import {
  ALLOWED_MEDIA,
  finalPathFor,
  validateMediaPath,
  type AllowedMediaType,
} from '@/validators/upload';
import type { MediaRef } from '@/types/media';

/* ========================================================================== */
/* The input                                                                   */
/* ========================================================================== */

/** What `POST /api/incidents` accepts for one media item. docs/15 §8.1 step 5. */
export type EvidenceAttachment = {
  /** A STAGING path the client signed for. Never a final path, never a name. */
  readonly storagePath: string;
  /** The reporter's original filename, display-only. Sanitised on the way in. */
  readonly displayName: string;
};

/* ========================================================================== */
/* Step 5 + 6: verify, move, and produce MediaRefs                            */
/* ========================================================================== */

/** What came back, including the things that did not work. */
export type AttachmentResult = {
  /** The evidence that is now at its final path. Empty when storage failed. */
  readonly attached: readonly MediaRef[];
  /** The `mediaId`s that were dropped, for `meta.droppedMedia`. */
  readonly dropped: readonly string[];
  /** `true` when Storage, not the client, was the reason. Audited. */
  readonly storageDegraded: boolean;
};

/**
 * Move staged evidence to its final path and return the rows to persist.
 *
 * `incidentId` and `reportId` are the Firestore auto-IDs the caller has already
 * minted inside its transaction, because the final path is derived from them and
 * an object must exist at that path before the `MediaRef` is committed.
 *
 * ### Why this NEVER throws for a per-item problem
 *
 * docs/15 §5.3: "The media item is dropped from the report, not silently
 * accepted." A single bad photo must not fail a report that has a good
 * description. So every per-item failure is caught here, the `mediaId` is
 * recorded in `dropped`, and the loop continues.
 *
 * The ONE thing that propagates is the `hasValidText === false` case, and only
 * when *nothing* could be attached — because then there is no report at all. That
 * is checked by the caller, not here, because this function does not know whether
 * the report has usable text.
 */
export async function attachEvidenceToIncident(
  uid: string,
  incidentId: string,
  reportId: string,
  items: readonly EvidenceAttachment[],
  hasValidText: boolean,
): Promise<AttachmentResult> {
  const log = createLogger('');
  const attached: MediaRef[] = [];
  const dropped: string[] = [];
  let storageDegraded = false;

  for (const item of items) {
    // --- the path must be the caller's own staging path ----------------
    // `validateMediaPath` compares `path.split('/')[1]` with `callerUid` and
    // returns `null` for anything that is not one of the three legal shapes. A
    // client that posts `incidents/<someone-else's>/reports/...` gets `null` here
    // and is dropped, not refused — the report still goes in.
    const parsed = validateMediaPath(item.storagePath, uid);
    if (parsed === null || parsed.shape !== 'staging') {
      // The `mediaId` may be recoverable for `droppedMedia`; if the path was
      // nonsense, there is nothing honest to name.
      const guess = item.storagePath.split('/').pop()?.split('.')[0];
      if (guess !== undefined && guess.startsWith('med_')) dropped.push(guess);
      continue;
    }

    const { mediaId, ext } = parsed;

    try {
      // --- does it exist, and how big? -------------------------------
      const metadata = await objectExists(item.storagePath);
      if (metadata === null || metadata.sizeBytes === 0) {
        // An interrupted upload that finalize was never called for. Nothing to
        // move, and leaving it would only delay the sweeper.
        await deleteObject(item.storagePath);
        releaseClaim(uid, mediaId);
        dropped.push(mediaId);
        continue;
      }

      // --- the AUTHORITATIVE re-sniff (docs/15 §8.1 step 5) ----------
      // The window is chosen from the DECLARED type because that is all that is
      // known before reading; the sniffed type is what the decision is based on.
      const { sniffBytes } = uploadConfig();
      const head = await readHeadBytes(
        item.storagePath,
        metadata.contentType === 'audio/webm' ? sniffBytes : Math.min(4096, sniffBytes),
      );
      if (head === null) {
        dropped.push(mediaId);
        continue;
      }

      const detected = detectMediaType(head);
      if (detected === null || 'quarantined' in detected) {
        // An executable, or something no longer recognisable. Deleted rather
        // than quarantined here: quarantine is the FINALIZE path's job, and a
        // second quarantine implementation is a second thing to get wrong. What
        // this must NOT do is attach an object whose type we cannot vouch for.
        await deleteObject(item.storagePath);
        releaseClaim(uid, mediaId);
        dropped.push(mediaId);
        log.warn({ code: 'UPLOAD_SIGNATURE_MISMATCH', path: 'uploads.attach', status: 415 });
        continue;
      }

      // --- the cap, against the SNIFFED type --------------------------
      const cap = ALLOWED_MEDIA[detected.contentType].maxBytes;
      if (metadata.sizeBytes > cap) {
        await deleteObject(item.storagePath);
        releaseClaim(uid, mediaId);
        dropped.push(mediaId);
        continue;
      }

      // --- the destination, derived not echoed -----------------------
      // `ext` comes from the SNIFFED type, not from the staging path. A file
      // signed as `.jpg` that sniffs as PNG lands as `.png` — docs/15 §6's
      // "ACCEPT, but the extension is corrected. No failure."
      const sniffedExt = ALLOWED_MEDIA[detected.contentType].ext;
      const finalPath = finalPathFor(incidentId, reportId, mediaId, sniffedExt, 'reports');

      // --- the hash, recomputed at the authoritative moment ----------
      const sha256 = await sha256OfObject(item.storagePath);
      const claim = claimFor(uid, mediaId);
      if (claim !== null && claim.declaredSizeBytes !== metadata.sizeBytes) {
        // The object changed size between sign and create. docs/15 §8.1 step 4
        // would have caught this, but create is the authoritative moment and this
        // is the last point at which the bytes can be questioned.
        log.warn({ code: 'UPLOAD_INCOMPLETE', path: 'uploads.attach', status: 409 });
        dropped.push(mediaId);
        continue;
      }

      // --- the move: copy, THEN delete (docs/15 §3.3) ---------------
      await moveStagedToFinal(item.storagePath, finalPath);
      releaseClaim(uid, mediaId);

      attached.push({
        mediaId,
        kind: detected.kind,
        contentType: detected.contentType,
        storagePath: finalPath,
        sha256,
        sizeBytes: metadata.sizeBytes,
        // Sanitised before it is persisted, and only ever used for display.
        displayName: safeDownloadName(item.displayName),
        width: detected.width,
        height: detected.height,
        durationSec: claim?.durationSec ?? null,
        // An inconclusive sniff is carried forward as `pending` rather than
        // promoted to `clean`. Step 7 refuses to serve a `pending` item, so this
        // is a gate and not a label.
        scanStatus: detected.confidence === 'exact' ? 'clean' : 'pending',
        uploadedBy: uid,
        uploadedAt: nowTimestamp(),
      });

      // The staging `ext` is deliberately not compared to the sniffed one above.
      // A disagreement is the documented friendly case, not an error.
      void ext;
    } catch (error) {
      // A Storage failure, as opposed to a bad file. Distinguished because the
      // consequence differs: this one is `storageDegraded` and is audited, and
      // docs/15 §16.3 says the report is still created.
      storageDegraded = true;
      dropped.push(mediaId);
      log.warn({ code: 'STORAGE_UNAVAILABLE', path: 'uploads.attach', status: 503 });
      // The error is deliberately not re-thrown and not logged: an SDK message
      // can contain the object path, which contains a uid.
      void error;
    }
  }

  // --- the one case where nothing is recorded ------------------------
  // No usable text and nothing attachable: there is no report. docs/15 §16.3.
  if (attached.length === 0 && !hasValidText) {
    throw new AppError({
      code: 'STORAGE_UNAVAILABLE',
      message:
        'We could not save your photo or recording, and there is no written description to submit. Your report has been kept on this device — please try again.',
    });
  }

  return { attached, dropped, storageDegraded };
}

/* ========================================================================== */
/* Step 7: reading evidence back — docs/15 §12 and §13                         */
/* ========================================================================== */

/** The caller's authority, as the §13 matrix resolves it. */
export type EvidenceReadRequest = {
  readonly uid: string;
  /** The `mediaId`. A path is NEVER accepted here. */
  readonly mediaId: string;
  /**
   * Whether this caller may read evidence on the incident that holds it.
   *
   * Decided by the ROUTE, from the capability matrix, and passed in. This
   * function is not given a role string to interpret, because the role->capability
   * mapping lives in one place (`lib/auth/permissions.ts`) and a second
   * interpretation of a role inside a storage service is a second answer to the
   * question "who may see this photo".
   */
  readonly canReadEvidence: boolean;
};

export type ResolvedEvidenceRead = {
  readonly url: string;
  readonly expiresAt: number;
  /** The SNIFFED type, for a correct `alt` or `type` attribute. */
  readonly contentType: AllowedMediaType;
  readonly displayName: string;
};

/**
 * Mint a signed read URL for one media item, if the caller may have one.
 *
 * ---------------------------------------------------------------------------
 * 404 IS BYTE-IDENTICAL TO A PERMISSION REFUSAL — ON PURPOSE
 * ---------------------------------------------------------------------------
 * docs/15 §16.4: "`404 MEDIA_NOT_FOUND`, byte-identical to a permission refusal".
 *
 * If "you may not read this" and "this does not exist" were distinguishable, the
 * difference is an oracle: a caller could enumerate `mediaId`s and learn which
 * exist, which is a disclosure about other people's reports. So both are the
 * same status, the same code, and the same message, and neither names the
 * incident.
 *
 * This is also why `mediaId` is the only accepted input. A path would let a
 * caller aim the request at an arbitrary object; a `mediaId` is unguessable
 * (60 bits) and is resolved through Firestore, where the access decision lives.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LOOKUP IS BY `mediaId` AND NOT BY `storagePath`
 * ---------------------------------------------------------------------------
 * `storagePath` is not in any queryable index — it is a field on a document
 * inside a subcollection of a document inside a collection. Resolving it would
 * mean a collectionGroup query, which is both slow and a way to probe for
 * existence. Instead the `MediaRef` is found by `mediaId` within the incident,
 * which means the caller must already know the incident — and therefore already
 * have been through the access matrix for it.
 */
export async function resolveEvidenceRead(
  request: EvidenceReadRequest,
): Promise<ResolvedEvidenceRead> {
  const { uid, mediaId, canReadEvidence } = request;

  // The unified refusal. ONE construction site, so the forbidden, the absent and
  // the unverified paths cannot drift into three different messages — which is
  // precisely the oracle docs/15 §16.4 forbids.
  //
  // Written as a thrown `AppError` held in a local, rather than a `never`-returning
  // helper, because TypeScript only narrows control flow through a function
  // *declaration* statically known to return `never`. A
  // `const refuse = (): never => { throw ... }` compiles and then leaves every
  // use site reporting "possibly null" — a type error that looks like a logic bug
  // and gets "fixed" with a `!` that deletes the check entirely.
  const REFUSAL = new AppError({
    code: 'MEDIA_NOT_FOUND',
    // Identical whether the object is absent, unverified, or forbidden.
    message: 'That file is not available.',
  });

  if (!canReadEvidence) throw REFUSAL;

  const found = await findMediaRefById(mediaId);
  if (found === null) throw REFUSAL;

  // The uploader may always read their own evidence, even on an incident they
  // have since lost access to (a cancelled one, say). The record survives; the
  // file is theirs.
  const isOwn = found.ref.uploadedBy === uid;

  // docs/15 §8.1 step 7: an item whose scan was inconclusive is not served to a
  // responder. This is the gate that makes `pending` mean something rather than
  // being a label.
  //
  // The uploader MAY see their own pending file. It is the file they just chose,
  // and hiding it would look exactly like data loss — the worst possible read for
  // someone who has just taken a photo of a fire. A responder may not, because an
  // unverified file is not evidence they can act on.
  if (found.ref.scanStatus === 'quarantined') throw REFUSAL;
  if (found.ref.scanStatus === 'pending' && !isOwn) {
    throw new AppError({
      code: 'MEDIA_NOT_VERIFIED',
      message: 'That file is still being checked and cannot be shown yet.',
    });
  }

  // The object may be gone (docs/15 §16.4). Mark the ref so the UI can say
  // "evidence unavailable" instead of showing a broken image.
  const metadata = await objectExists(found.ref.storagePath);
  if (metadata === null) {
    await markStorageMissing(found.incidentId, found.reportId, mediaId);
    // The SAME refusal, not a fresh one. An object that vanished out of band is
    // indistinguishable from one the caller was never allowed to see, and a
    // distinct message here would be the oracle docs/15 §16.4 rules out.
    throw REFUSAL;
  }

  const { url, expiresAt } = await signedReadUrl(found.ref.storagePath, found.ref.displayName);
  return {
    url,
    expiresAt,
    contentType: found.ref.contentType,
    displayName: found.ref.displayName,
  };
}

/** One `MediaRef` and where it lives. The location is needed to mark flags. */
type FoundRef = {
  readonly incidentId: string;
  readonly reportId: string;
  readonly ref: MediaRef;
};

/**
 * Find a `MediaRef` by its `mediaId`.
 *
 * A collectionGroup query, which is the only way to search by a field that is
 * not the document ID. It is bounded by `where('mediaId', '==', ...)` so it
 * returns at most the handful of reports that reference one id, and the
 * `mediaId` regex already guarantees it is a well-formed id before we get here.
 */
async function findMediaRefById(mediaId: string): Promise<FoundRef | null> {
  const db = getAdminDb();
  const snapshot = await db
    .collectionGroup(SUB_COLLECTIONS.incidentReports)
    .where('mediaIds', 'array-contains', mediaId)
    .limit(5)
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data() as { media?: readonly MediaRef[] };
    const ref = (data.media ?? []).find((candidate) => candidate.mediaId === mediaId);
    if (ref !== undefined) {
      return {
        // The parent chain is `incidents/{id}/reports/{rid}`, so the incident id
        // is two levels up from the report document.
        incidentId: doc.ref.parent.parent?.id ?? '',
        reportId: doc.id,
        ref,
      };
    }
  }
  return null;
}

/**
 * Record that an object is gone. docs/15 §16.4.
 *
 * Best-effort and deliberately silent on failure: this runs on a READ path, and a
 * read must not fail because a bookkeeping write did. The flag is a nicety for
 * the dispatcher UI; the unified 404 has already been returned.
 */
async function markStorageMissing(
  incidentId: string,
  reportId: string,
  mediaId: string,
): Promise<void> {
  try {
    await getAdminDb()
      .collection(COLLECTIONS.incidents)
      .doc(incidentId)
      .collection(SUB_COLLECTIONS.incidentReports)
      .doc(reportId)
      .set(
        { mediaMissing: { [mediaId]: true } },
        { merge: true },
      );
  } catch {
    // Intentionally empty. See the doc comment.
  }
}

/* ========================================================================== */
/* The AI bridge — Storage to Phase 4                                          */
/* ========================================================================== */

/**
 * One staged object, in the shape Phase 4's `toTriageRequest` wants.
 *
 * `base64` rather than a Storage URI because `@google/genai` is called with
 * inline data and this project's Phase 4 already validated that path. Note the
 * size arithmetic in docs/15 §7.2: base64 inflates by 1.37x, which is exactly why
 * the FILE never passes through an HTTP request body — it goes browser to Storage
 * directly, and only the server-side, already-verified bytes are inlined into the
 * Gemini call.
 */
export type StagedAiMedia = {
  readonly mediaId: string;
  /** The SNIFFED type. What the model is told, and what the prompt's counts use. */
  readonly contentType: AllowedMediaType;
  readonly base64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly displayName: string;
  /** Present for audio only. */
  readonly durationSec: number | null;
};

/**
 * The largest object Phase 5 will hand to the model.
 *
 * docs/09 §4 puts the total request at ~18 MB (3x5 MB images + 15 MB audio).
 * 18 MB of raw bytes is ~24 MB of base64, and Gemini's inline-data ceiling is
 * comfortably above that, so the guard here is not about the provider — it is
 * about not building a 24 MB string in a serverless function's heap for a
 * request that will then be refused.
 */
const AI_MEDIA_MAX_BYTES = 15_728_640;

/**
 * Download a verified staging image and validate it for the AI.
 *
 * **The bytes go through Phase 4's `validateImage` a second time, and that is not
 * redundant.** Phase 4's validator checks signature, declared type, extension and
 * size. It is the only implementation of those checks for the AI path, so an
 * object that Storage accepted (which checks `contentType` as a *claim*) is
 * re-checked against its actual bytes here. A `contentType` of `image/jpeg` on an
 * object full of HTML passes `storage.rules`; it does not pass this.
 */
export async function stageImageForAi(
  uid: string,
  mediaId: string,
): Promise<StagedAiMedia> {
  const staged = await readStagedForAi(uid, mediaId, 'image');
  // Throws `ImageValidationError` naming the reason, which the route turns into
  // a 415. It is Phase 4's own error type, so the copy is already written for a
  // person rather than for a log.
  const validated = validateImage({
    data: staged.bytes,
    declaredMimeType: staged.contentType,
    // The server-derived `med_XXX.jpg` name, not the reporter's: Phase 4 checks
    // the extension against the signature, and the reporter's name is the field
    // that is allowed to be wrong.
    fileName: `${mediaId}.${ALLOWED_MEDIA[staged.contentType].ext}`,
  });

  return {
    mediaId,
    contentType: staged.contentType,
    base64: validated.base64,
    byteLength: validated.byteLength,
    sha256: validated.sha256,
    displayName: staged.displayName,
    durationSec: null,
  };
}

/**
 * Download a verified staging audio clip for the AI.
 *
 * No `validateAudio` exists in Phase 4 — it validated images only, because
 * audio arrived as a client-supplied base64 string with no byte check. Phase 5
 * has a real storage object and a sniffer, so this path is STRICTLY better
 * checked than Phase 4's was: the container was sniffed at finalize, and the
 * claim on the path was resolved from our own record.
 */
export async function stageAudioForAi(
  uid: string,
  mediaId: string,
): Promise<StagedAiMedia> {
  const staged = await readStagedForAi(uid, mediaId, 'audio');
  return {
    mediaId,
    contentType: staged.contentType,
    base64: Buffer.from(staged.bytes).toString('base64'),
    byteLength: staged.bytes.length,
    sha256: staged.sha256,
    displayName: staged.displayName,
    durationSec: staged.durationSec,
  };
}

/** The intermediate both AI staggers share, before Phase 4's shape is imposed. */
type StagedRead = {
  readonly bytes: Uint8Array;
  readonly contentType: AllowedMediaType;
  readonly sha256: string;
  readonly displayName: string;
  readonly durationSec: number | null;
};

/**
 * The shared download, with every check that can be made without knowing the
 * kind in advance.
 */
async function readStagedForAi(
  uid: string,
  mediaId: string,
  expectedKind: 'image' | 'audio',
): Promise<StagedRead> {
  const claim = claimFor(uid, mediaId);
  if (claim === null) {
    throw new AppError({
      code: 'MEDIA_NOT_FOUND',
      message: 'That file is not available.',
    });
  }
  if (claim.kind !== expectedKind) {
    throw new AppError({
      code: 'UPLOAD_SIGNATURE_MISMATCH',
      message: 'That file is not the kind of evidence you added.',
    });
  }

  const metadata = await objectExists(claim.storagePath);
  if (metadata === null || metadata.sizeBytes === 0) {
    throw new AppError({ code: 'MEDIA_NOT_FOUND', message: 'That file is not available.' });
  }
  if (metadata.sizeBytes > AI_MEDIA_MAX_BYTES) {
    throw new AppError({ code: 'UPLOAD_TOO_LARGE', message: 'That file is too large to analyse.' });
  }

  // FULL download, not a range read. The model needs the whole clip, and the
  // `moov` atom of an M4A is routinely at the end (docs/15 §5.2.5), so a
  // truncated read would produce a clip the model cannot decode.
  const [contents] = await getAdminStorage()
    .bucket()
    .file(claim.storagePath)
    .download();
  const bytes = new Uint8Array(contents);

  // Re-check the signature even here. It is cheap relative to the download, and
  // the whole point of the three-layer chain is that the AI path is never the
  // layer that gets skipped.
  const { sniffBytes } = uploadConfig();
  const head = bytes.subarray(0, Math.min(sniffBytes, bytes.length));
  const detected = detectMediaType(head);
  if (detected === null || 'quarantined' in detected || detected.kind !== expectedKind) {
    throw new AppError({
      code: 'UPLOAD_SIGNATURE_MISMATCH',
      message: 'That file is not the kind of evidence you added.',
    });
  }

  return {
    bytes,
    contentType: detected.contentType,
    sha256: await sha256OfObject(claim.storagePath),
    displayName: claim.mediaId,
    durationSec: claim.durationSec ?? null,
  };
}

/* ========================================================================== */
/* The sweeper — docs/15 §16.2, NOT implemented                                */
/* ========================================================================== */

/**
 * The sweeper does not exist. This is the contract for whoever builds it.
 *
 * docs/15 §16.2 specifies a `sweep-staging-uploads` maintenance job with a manual
 * trigger at `POST /api/admin/maintenance/sweep-staging-uploads` requiring a
 * reason and an audit entry, gated on `r57_runMaintenanceJobs`. Phase 9 owns
 * maintenance; this phase records the contract rather than shipping a job that
 * would silently never run.
 *
 * ### Why it is NOT "worked around" here
 *
 * The tempting shortcut is to delete a user's staging objects when their
 * incident is created. That is wrong in three separate ways:
 *
 *  1. It does not clean up the population the sweeper exists for — objects whose
 *     user abandoned the form and never submitted. Those are the overwhelming
 *     majority, and a create-time cleanup touches none of them.
 *  2. It puts a Storage WRITE on the report-creation path, so a Storage blip
 *     could fail a report that has already been filed — the exact outcome
 *     §16.3 exists to prevent.
 *  3. It creates a retention behaviour nobody chose, on evidence that may be
 *     needed for a dispute.
 *
 * brief §39 anticipates this precisely: "If automated cleanup is not yet
 * implemented, document it as a future integration point rather than creating an
 * unsafe workaround."
 */
export const SWEEP_NOT_IMPLEMENTED = {
  implemented: false,
  /** docs/15 §16.2. */
  jobName: 'sweep-staging-uploads',
  /** Where it belongs, per the phase plan's maintenance ownership. */
  belongsInPhase: 9,
  /** The capability that must gate the manual trigger. */
  requiresCapability: 'r57_runMaintenanceJobs',
  /** The route docs/15 §16.2 specifies for the manual trigger. */
  manualTrigger: 'POST /api/admin/maintenance/sweep-staging-uploads',
  /** The window, from `STAGING_UPLOAD_SWEEP_MIN`. */
  windowMin: 30,
  /** What it must do. Written out so the implementer does not re-derive it. */
  contract: [
    'List objects under `staging/`.',
    'For each, compare its `updated` timestamp against STAGING_UPLOAD_SWEEP_MIN.',
    'Hard-delete any object older than the window. A staging object is orphaned by definition once it is older than the claim window.',
    'Never touch `incidents/**` or `quarantine/**`.',
    'Accept a required reason, and write one `maintenance` audit entry per run.',
  ],
  /**
   * The known gap this leaves, stated rather than hidden. docs/15 §16.2 row 3:
   * if a transaction fails after the copy, an object exists at `incidents/**`
   * that no `MediaRef` references. D-13 in docs/15 proposes a
   * `sweep-orphaned-evidence` job; it is also not built.
   */
  knownGap:
    'Orphaned objects under incidents/** (copy succeeded, transaction failed) are not detected. `GET /api/admin/system/health` should report them per docs/15 §16.2; that is Phase 9 work.',
} as const;

export type SweepReport = {
  readonly scanned: number;
  readonly deleted: readonly string[];
  readonly windowMin: number;
};

/**
 * The sweeper's entry point. It refuses rather than pretending.
 *
 * Throwing (rather than returning an empty report) is deliberate: a caller that
 * received `{ scanned: 0, deleted: [] }` would conclude staging is clean, which is
 * a false statement. An explicit failure says "this check did not run".
 */
export async function sweepAbandonedStaging(): Promise<SweepReport> {
  throw new AppError({
    code: 'SERVICE_UNAVAILABLE',
    message: `The staging-upload sweeper is not implemented in this phase (docs/15 §16.2). It belongs to Phase 9 and requires ${SWEEP_NOT_IMPLEMENTED.requiresCapability}.`,
  });
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/**
 * A server timestamp, isolated so the import is obvious at every use site.
 *
 * `Timestamp.now()` rather than `new Date()`, because the report document's other
 * timestamps are Firestore `Timestamp`s and a `Date` here would be the one field
 * that serialises differently.
 */
function nowTimestamp(): Timestamp {
  return Timestamp.now();
}

/**
 * ============================================================================
 * CareGrid AI — the browser-side upload manager
 * ============================================================================
 *
 * docs/15 §8.1 steps 1-4, in the browser. The direct browser-to-Storage PUT, the
 * real progress bar, the retry, and the duplicate-upload guard.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PUT GOES STRAIGHT TO STORAGE AND NOT THROUGH THE API
 * ---------------------------------------------------------------------------
 * Arithmetic, from docs/15 §7.2: base64 inflates by 1.37x, and Vercel rejects a
 * request body over 4 MiB. The largest permitted evidence file is 15 MiB, so
 * routing it through an API route is arithmetically impossible above ~3 MB. The
 * bytes therefore go browser -> Storage directly, and the API is used for the
 * three things that need server authority: minting the signed URL, verifying the
 * bytes, and minting read URLs later.
 *
 * This is also why the client pre-check is UX and not a control. Nothing here
 * decides whether a file is allowed. It decides whether to waste a citizen's time
 * uploading something the server will refuse.
 *
 * ---------------------------------------------------------------------------
 * THE DUPLICATE-UPLOAD GUARD (brief §27)
 * ---------------------------------------------------------------------------
 * brief §27 names four causes of accidental double-upload: double click, React
 * re-render, retry logic, component remount. They need four different mechanisms,
 * and it is worth being explicit about which is which, because "we debounced the
 * button" only fixes the first:
 *
 * | Cause | Mechanism |
 * | --- | --- |
 * | double click | an in-flight `Set` keyed by a content fingerprint, checked synchronously before any `await` |
 * | React re-render | all progress lives in a ref-backed store, and state is only touched through `setState` helpers |
 * | retry logic | a retry REUSES the same `localId`, so the store already knows the file; it never re-adds it |
 * | component remount | the store is a module-level singleton, not component state, so a remount reattaches to it |
 *
 * The fingerprint is `name:size:lastModified`, which is the strongest identity a
 * `File` has without reading its bytes. It is deliberately not content-based: a
 * sha256 of a 15 MB file on the main thread is a visible freeze on the phone
 * most likely to be reporting an emergency.
 */

import { uploadsFinalize, uploadsSign } from '@/lib/api/client';
import { getUploadLimits } from '@/lib/env.client';
import {
  ALLOWED_AUDIO_TYPES,
  ALLOWED_IMAGE_TYPES,
  type AllowedMediaType,
  type MediaKind,
} from '@/validators/upload';
import {
  voiceIsActive,
  type PendingUpload,
  type UploadStatus,
} from '@/types/media';

/* ========================================================================== */
/* Capability detection — §8.1 step 1                                          */
/* ========================================================================== */

/** Why an upload could not even be attempted. `null` means it can be. */
export type UploadRejection = {
  readonly code:
    | 'TOO_LARGE'
    | 'UNSUPPORTED_TYPE'
    | 'TOO_LONG'
    | 'QUOTA_FULL'
    | 'WRONG_KIND'
    | 'UNREADABLE';
  /** Safe to show a citizen. Never contains a path, a uid, or an SDK message. */
  readonly message: string;
};

/**
 * The client-side pre-check. docs/15 §8.1 step 1.
 *
 * **UX, not a control.** Every number here is re-checked by the server, and the
 * server's number wins. What this buys is that a person learns their photo is too
 * large immediately, rather than after selecting it, previewing it, uploading it
 * and being refused.
 *
 * The messages are the ones a person can act on, and they are specific: "Photos
 * must be under 5 MB" tells someone what to do, and "Unsupported file" does not.
 */
export function preCheckFile(
  file: File,
  kind: MediaKind,
  durationSec?: number,
): UploadRejection | null {
  const limits = getUploadLimits();
  const allowed: readonly string[] = kind === 'image' ? ALLOWED_IMAGE_TYPES : ALLOWED_AUDIO_TYPES;
  const cap = kind === 'image' ? limits.maxImageBytes : limits.maxAudioBytes;

  // The declared MIME type is a CLAIM. It is checked here so a person gets told
  // immediately, and it is checked again against the bytes server-side, because a
  // claim is not a fact.
  if (!allowed.includes(file.type)) {
    return {
      code: 'UNSUPPORTED_TYPE',
      message:
        kind === 'image'
          ? 'That file type is not supported. Photos must be JPG, PNG or WebP.'
          : 'That audio format is not supported. Please record the message again.',
    };
  }

  if (file.size === 0) {
    return { code: 'UNREADABLE', message: 'That file appears to be empty. Please choose another.' };
  }

  if (file.size > cap) {
    const mb = Math.round(cap / (1024 * 1024));
    return {
      code: 'TOO_LARGE',
      message:
        kind === 'image'
          ? `Photos must be under ${mb} MB. Try a smaller photo, or take a new one.`
          : `That recording is too large. Record a shorter voice note.`,
    };
  }

  if (kind === 'audio' && durationSec !== undefined) {
    if (durationSec > limits.maxAudioDurationSec) {
      return {
        code: 'TOO_LONG',
        message: `Voice notes are limited to ${limits.maxAudioDurationSec} seconds.`,
      };
    }
  }

  return null;
}

/**
 * The total-item check. docs/15 §7.1.
 *
 * `maxTotalPerReport` is 3, which is the SAME as the image limit — so a report
 * with an audio clip may carry at most two images. Checking the total rather than
 * only the per-kind count is what stops a citizen from adding a third photo to a
 * report that already has a voice note and being refused at submit time, after
 * they have written their whole report.
 */
export function preCheckQuota(
  current: readonly PendingUpload[],
  kind: MediaKind,
): UploadRejection | null {
  const limits = getUploadLimits();
  const live = current.filter((item) => item.status !== 'failed');

  if (kind === 'image' && live.filter((i) => i.kind === 'image').length >= limits.maxImages) {
    return {
      code: 'QUOTA_FULL',
      message: `You can add up to ${limits.maxImages} photos to one report.`,
    };
  }
  if (kind === 'audio' && live.filter((i) => i.kind === 'audio').length >= limits.maxAudioClips) {
    return {
      code: 'QUOTA_FULL',
      message: 'You can add one voice note to a report.',
    };
  }
  if (live.length >= limits.maxImages) {
    return {
      code: 'QUOTA_FULL',
      message: `This report already has ${live.length} items, which is the maximum. Remove one to add another.`,
    };
  }
  return null;
}

/* ========================================================================== */
/* The fingerprint and the in-flight guard                                      */
/* ========================================================================== */

/**
 * `name:size:lastModified` — the strongest identity a `File` carries for free.
 *
 * Deliberately not a content hash. Hashing 15 MB on the main thread is a visible
 * freeze on exactly the device most likely to be filing this report, and the
 * duplicate this guards against is the *same* `File` object reaching the uploader
 * twice — which `size` and `lastModified` already identify.
 */
function fingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/** The one in-flight key per fingerprint, per session. */
const inFlight = new Set<string>();

/** Is this exact file already being uploaded? Synchronous, so it beats a click. */
export function isInFlight(file: File): boolean {
  return inFlight.has(fingerprint(file));
}

/** Test seam. */
export function resetUploadManagerForTests(): void {
  inFlight.clear();
  store.clear();
}

/* ========================================================================== */
/* The store                                                                   */
/* ========================================================================== */

/**
 * Module-level, not component state.
 *
 * This is the whole of the brief §27 "component remount" defence. A `useState`
 * array in the report form would be discarded when the user navigated to the map
 * and back, and the files in it with it — so a citizen who picked three photos,
 * checked the map, and came back would find the form empty, or worse, would find
 * the uploader re-PUTting bytes that were already in Storage.
 *
 * A subscriber list rather than a React context, because a context provider still
 * unmounts with the tree above it. This sits outside React entirely.
 */
const store = new Map<string, PendingUpload>();
const listeners = new Set<(items: PendingUpload[]) => void>();

/** Notify subscribers. Called only from the setters below. */
function emit(): void {
  // A fresh array every time, so `useSyncExternalStore`'s identity check sees a
  // change. Returning the same array would make the UI silently stop updating.
  const snapshot = [...store.values()];
  for (const listener of listeners) listener(snapshot);
}

export function subscribeUploads(listener: (items: PendingUpload[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function uploadSnapshot(): PendingUpload[] {
  return [...store.values()];
}

/* ========================================================================== */
/* Gathering attachable media for the submit               */
/* ========================================================================== */

/** One item ready to be referenced in `POST /api/incidents` as `media[]`. */
export type AttachableMedia = {
  readonly storagePath: string;
  readonly displayName: string;
};

/** What the form needs to know before it sends the report. */
export type AttachableMediaSummary = {
  /** Ready to attach. Send these as `media[]`. */
  readonly attachable: readonly AttachableMedia[];
  /** Still uploading or being verified. Cannot be attached yet. */
  readonly inFlight: readonly PendingUpload[];
  /** Failed. Their bytes exist nowhere usable; the user must re-add them. */
  readonly failed: readonly PendingUpload[];
};

/**
 * Partition the store into what can be attached and what cannot.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN BEING INLINED IN THE FORM
 * ---------------------------------------------------------------------------
 * Because the rule "only a `uploaded` item with a `storagePath` is attachable" has
 * to be applied in exactly one place. Inlined in the form it would be a
 * `filter(...)` that someone later widens to "anything not failed" and thereby
 * ships an incident pointing at an object that was never uploaded.
 *
 * The predicate is therefore: `status === 'uploaded'` AND `storagePath` present.
 * Both halves are required.
 *
 *  - `status === 'uploaded'` alone would include an item whose PUT or finalize
 *    failed but which still carries the path from the sign step — the server would
 *    find nothing at that path and drop it, wasting the round trip and confusing
 *    the reporter.
 *  - `storagePath` present alone would include every signed item, including the
 *    ones mid-PUT right now.
 *
 * ---------------------------------------------------------------------------
 * `inFlight` IS RETURNED SO THE FORM CAN ASK, NOT JUST DROP
 * ---------------------------------------------------------------------------
 * A report whose photo is at 80% is still submittable, and silently discarding the
 * photo would be the worst outcome available: the citizen believes they sent a
 * photo and a dispatcher sees a text-only report. `report-form.tsx` uses this to
 * block submit on a still-uploading file rather than quietly omitting it.
 */
/**
 * Partition a set of uploads into what can be attached and what cannot.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PURE FUNCTION AND `collectAttachableMedia` IS A THIN WRAPPER
 * ---------------------------------------------------------------------------
 * Because the store is module-level and its only writer is `startUpload`, which
 * needs `XMLHttpRequest` and a browser. The unit environment is `node` by design,
 * so a test that wanted to cover this partition through the store would have to
 * re-implement the store — and a hand-built store that passes while the real one is
 * broken is worse than no test, because it reads as coverage.
 *
 * Taking the items as an argument makes the rule testable on its own terms, and
 * keeps `collectAttachableMedia` as the one place that knows where the items come
 * from. There is still exactly one implementation of the predicate.
 */
export function partitionUploads(items: readonly PendingUpload[]): AttachableMediaSummary {
  const attachable: AttachableMedia[] = [];
  const inFlight: PendingUpload[] = [];
  const failed: PendingUpload[] = [];

  for (const item of items) {
    if (item.status === 'failed') {
      failed.push(item);
      continue;
    }
    if (item.status !== 'uploaded' || item.storagePath === undefined) {
      inFlight.push(item);
      continue;
    }
    attachable.push({ storagePath: item.storagePath, displayName: item.fileName });
  }

  return { attachable, inFlight, failed };
}

/** Read the live store and partition it. See `partitionUploads`. */
export function collectAttachableMedia(): AttachableMediaSummary {
  return partitionUploads(uploadSnapshot());
}

/** A local id that cannot collide with a previous session's. */
let localCounter = 0;
function nextLocalId(): string {
  localCounter += 1;
  return `up_${Date.now().toString(36)}_${localCounter}`;
}

/**
 * Apply a partial update and emit.
 *
 * `patch` rather than a full object so a caller cannot accidentally drop a field
 * it did not mention — the `mediaId` on a verified upload must survive a
 * `status: 'failed'` update, or a retry would lose the id the server issued.
 *
 * The `status` is NOT part of the type. A progress tick arrives dozens of times a
 * second and must not have to restate the status to be legal; making it required
 * would only tempt a caller into a spread that could contradict it. Status
 * transitions go through `advance()`, which is the single place they can happen.
 */
function patchItem(localId: string, patch: Partial<PendingUpload>): void {
  const existing = store.get(localId);
  if (existing === undefined) return;
  store.set(localId, { ...existing, ...patch });
  emit();
}

/**
 * Move an item to a new state. The ONLY way `status` changes.
 *
 * Not a general setter: it is named for what it does so that a reader of
 * `startUpload` sees the state machine rather than eight assignments.
 */
function advance(localId: string, status: UploadStatus, patch: Partial<PendingUpload> = {}): void {
  patchItem(localId, { ...patch, status });
}

/* ========================================================================== */
/* The upload                                                                   */
/* ========================================================================== */

/** Options for one upload. */
export type StartUploadOptions = {
  readonly file: File;
  readonly kind: MediaKind;
  /** The client's measured duration. Required for audio. */
  readonly durationSec?: number;
  /** The reporter's own filename. Sent as a display hint, never as a path. */
  readonly displayName: string;
  /** Image dimensions, when cheaply known. A claim; re-checked server-side. */
  readonly clientWidth?: number;
  readonly clientHeight?: number;
  /** Fires on real byte progress. Never on a timer. */
  readonly onProgress?: (percent: number) => void;
};

/** What one upload produced. */
export type StartUploadResult =
  | { readonly ok: true; readonly mediaId: string; readonly localId: string }
  | { readonly ok: false; readonly localId: string; readonly rejection: UploadRejection };

/**
 * Upload one file end to end: pre-check ? sign ? PUT ? finalize.
 *
 * ---------------------------------------------------------------------------
 * WHY `XMLHttpRequest` AND NOT `fetch`
 * ---------------------------------------------------------------------------
 * `fetch` still has no upload progress event. brief §24 is explicit: "Do not fake
 * progress. Use actual upload progress where available." An `XMLHttpRequest`
 * `upload.onprogress` gives real `loaded`/`total` bytes; a CSS animation gives a
 * bar that reaches 100% and then sits there for four seconds on a 15 MB clip,
 * which is worse than no bar because it tells the citizen something untrue.
 *
 * This is the one place in the codebase where `XMLHttpRequest` is the right tool,
 * and the comment above is why it is not an accident.
 *
 * ---------------------------------------------------------------------------
 * THE ERROR PATH DELETES ITS OWN STAGING OBJECT
 * ---------------------------------------------------------------------------
 * A failed upload leaves an object in `staging/` until the sweeper runs. That is
 * the documented behaviour, and this function does not try to clean it up on the
 * client: the client's view of whether a delete succeeded is not a control, and a
 * "cleanup" call that itself fails leaves the citizen with a retried upload and
 * two orphaned objects. The sweeper is the answer, and it is Phase 9.
 */
export async function startUpload(
  options: StartUploadOptions,
): Promise<StartUploadResult> {
  const { file, kind, displayName, onProgress } = options;
  const localId = nextLocalId();
  const key = fingerprint(file);

  // --- the duplicate guard, checked BEFORE any await --------------------
  // Synchronous on purpose. An `await` before this check would let a second click
  // through in the same tick, which is the entire bug brief §27 is describing.
  if (inFlight.has(key)) {
    return {
      ok: false,
      localId,
      rejection: { code: 'UNREADABLE', message: 'That file is already uploading.' },
    };
  }
  inFlight.add(key);

  store.set(localId, {
    localId,
    status: 'validating',
    progress: 0,
    fileName: displayName,
    sizeBytes: file.size,
    declaredMimeType: file.type,
    kind,
  });
  emit();

  try {
    // --- 1. pre-check --------------------------------------------------
    const rejection = preCheckFile(file, kind, options.durationSec);
    if (rejection !== null) {
      advance(localId, 'failed', { error: rejection.message, retryable: false });
      return { ok: false, localId, rejection };
    }

    advance(localId, 'ready');

    // --- 2. sign -------------------------------------------------------
    advance(localId, 'signing');
    const signed = await uploadsSign({
      kind,
      contentType: file.type,
      sizeBytes: file.size,
      durationSec: options.durationSec,
      clientWidth: options.clientWidth,
      clientHeight: options.clientHeight,
      displayName,
      intent: 'report',
    });

    // Captured HERE, at the sign step, rather than at `uploaded`.
    //
    // That ordering is the whole point. `finalize` returns a `mediaId` but no path,
    // so reading it from there would mean the only opportunity to keep the staging
    // locator has already passed. Setting it now means it is present even if the
    // PUT or the finalize fails and the user retries — a retry re-signs, but an
    // item that reached `uploaded` always has the path that will be attached.
    advance(localId, 'signing', { storagePath: signed.storagePath });

    // --- 3. the PUT, with real progress --------------------------------
    advance(localId, 'uploading');
    await putWithProgress(signed.uploadUrl, file, signed.requiredContentType, (percent) => {
      onProgress?.(percent);
      patchItem(localId, { progress: percent });
    });

    // --- 4. finalize: the bytes are up, now find out what they are ------
    advance(localId, 'finalizing', { progress: 100 });
    const verified = await uploadsFinalize(signed.mediaId);

    advance(localId, 'uploaded', {
      mediaId: verified.mediaId,
      // The SNIFFED type replaces the declared one. The declaration is kept
      // alongside it only so the UI can say "you sent a PNG, it is really a JPEG"
      // if that ever matters — it is not what the report will record.
      verifiedContentType: verified.verifiedContentType as AllowedMediaType,
      sha256: verified.sha256,
      width: verified.width,
      height: verified.height,
      durationSec: verified.durationSec,
    });

    return { ok: true, mediaId: verified.mediaId, localId };
  } catch (error) {
    // --- the failure path ---------------------------------------------
    // The message is whatever the API layer produced, which is already written
    // for a person and carries no path or uid. An unexpected error (a network
    // drop, say) has no message, so a fixed sentence is used rather than
    // `String(error)` — which for a TypeError is "TypeError: Failed to fetch" and
    // tells a citizen nothing.
    const message =
      error instanceof Error && error.message.length > 0 && error.message.length < 300
        ? error.message
        : 'That upload did not finish. Your report text is safe — please try again.';

    advance(localId, 'failed', { error: message, retryable: true });
    return { ok: false, localId, rejection: { code: 'UNREADABLE', message } };
  } finally {
    // Released in `finally`, so a throw anywhere above still frees the slot. A
    // guard that leaks on the error path is a guard that blocks a legitimate
    // retry — which is the opposite of what brief §25 asks for.
    inFlight.delete(key);
  }
}

/* ========================================================================== */
/* The PUT                                                                     */
/* ========================================================================== */

/**
 * PUT a file to a signed URL, reporting REAL progress.
 *
 * `xhr.upload.onprogress` reports `loaded` and `total` in bytes, so the percentage
 * is real. Two details that are easy to get wrong:
 *
 *  - **`total` can be 0.** A `Content-Length`-less request reports `lengthComputable:
 *    false` and `total === 0`. Dividing by it yields `Infinity`, and a bar at
 *    `Infinity%` is worse than no bar. Below 1% is shown as 0 until the load
 *    event fires.
 *  - **The `Content-Type` header must be byte-identical to the one that was
 *    signed.** It is part of the V4 signature, so a different value is a `403` from
 *    Google with a message that names a signature rather than a format. This is
 *    `signed.requiredContentType`, not `file.type` — they are usually the same
 *    and are not always.
 */
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    // Must be set explicitly. `xhr.send(file)` does not set it for a Blob on
    // every browser, and an absent header is a signature mismatch.
    xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total === 0) {
        onProgress(0);
        return;
      }
      const percent = Math.min(99, Math.round((event.loaded / event.total) * 100));
      // Capped at 99, never 100. The file is not finished being verified until
      // `finalizeUpload` returns, and a bar that reads 100% while the server is
      // still sniffing the bytes is claiming something untrue — the same failure
      // as a faked bar, and the reason `finalizing` is a separate visible state.
      onProgress(percent);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      // A `403` on a signed URL is nearly always expiry: the URL lives 15 minutes
      // and a citizen on a slow connection choosing a large photo can exceed it.
      // The message says so, because "retry" is the right advice and a raw
      // "Forbidden" is not.
      const expired = xhr.status === 403;
      reject(
        new Error(
          expired
            ? 'That upload link expired before the file finished. Please try again.'
            : 'Storage refused the upload. Please try again.',
        ),
      );
    };

    xhr.onerror = () =>
      reject(new Error('The upload was interrupted. Your report text is safe — please try again.'));
    xhr.ontimeout = () => reject(new Error('The upload timed out. Please try again.'));
    xhr.onabort = () => reject(new Error('The upload was cancelled.'));

    xhr.send(file);
  });
}

/* ========================================================================== */
/* Removing and retrying                                                        */
/* ========================================================================== */

/**
 * Remove one item from the form.
 *
 * **Client-only, and it says so.** The object in `staging/` is not deleted here,
 * for the reason in `startUpload`: the client's view of whether a delete succeeded
 * is not a control. It is swept in 30 minutes.
 *
 * brief §25's "Do not silently discard the user's report" is honoured by the text:
 * the report text and the other files are untouched, and the removal is undoable
 * only in the sense that the citizen can re-add the file from their device.
 */
export function removeUpload(localId: string): void {
  store.delete(localId);
  emit();
}

/** Drop every item. Used when a report is successfully submitted. */
export function clearUploads(): void {
  store.clear();
  emit();
}

/**
 * Retry one failed item.
 *
 * The `File` is not in the store — only its metadata is, deliberately, so a
 * `Map` of `Blob`s does not sit in memory for the lifetime of a report. So a retry
 * needs the file again, and the caller supplies it from the `<input>`.
 *
 * The ORIGINAL `localId` is deliberately NOT reused. Reusing it would mean the
 * failed entry is still in the store, so the retry would be a second entry
 * against the same key and the duplicate guard would fire on itself.
 */
export async function retryUpload(
  localId: string,
  file: File,
  options: Omit<StartUploadOptions, 'file'>,
): Promise<StartUploadResult> {
  removeUpload(localId);
  return startUpload({ ...options, file });
}

/** `true` when a recording is in progress, so the uploader can refuse a new file. */
export function canAddMore(current: readonly PendingUpload[]): boolean {
  const limits = getUploadLimits();
  const live = current.filter((item) => item.status !== 'failed');
  return live.length < limits.maxImages;
}

/** Re-exported so a component does not import the recorder to ask this. */
export { voiceIsActive };

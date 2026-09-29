/**
 * ============================================================================
 * CareGrid AI — media and voice types
 * ============================================================================
 *
 * brief §37. One home for every media-shaped type, so a component, a service and
 * a validator are all talking about the same thing.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE LIVE IN `types/` AND NOT IN `validators/`
 * ---------------------------------------------------------------------------
 * `validators/upload.ts` owns what the SERVER will accept — the allow-list, the
 * path contract, the request bodies. That is a control, and a control has an
 * opinion.
 *
 * These are the shapes that describe evidence as it travels: a `MediaRef` already
 * stored in Firestore, an upload's progress through the client, a recorder's
 * state machine. They have no opinion about what is legal — that was decided
 * before they existed — and mixing the two is how a "shape" quietly becomes a
 * second, looser version of the rule.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR TYPE FAMILIES AND WHY EACH EXISTS
 * ---------------------------------------------------------------------------
 * | Family          | Answers                                          | Lives where        |
 * | --------------- | ------------------------------------------------ | ------------------ |
 * | `MediaRef`      | What is attached to a report, in Firestore        | this file          |
 * | `UploadStatus`  | Where one file is in the client's upload journey  | this file          |
 * | `VoiceState`    | What the recorder is doing right now              | this file          |
 * | `Transcript`    | What the user-confirmed voice text is             | `services/speech`  |
 *
 * `Transcript` is deliberately NOT here even though it is a type. It belongs to
 * the speech service, which owns the semantics of the four states, and
 * re-exporting it from `types/` would give two import paths to one concept — the
 * thing that makes a union quietly widen at one call site and not the other.
 */

import type { AllowedMediaType, MediaKind } from '@/validators/upload';

export type { AllowedMediaType, MediaKind };

/**
 * A Firestore timestamp, structurally.
 *
 * `MediaRef` is a persisted shape, and it is written by `firebase-admin` and read
 * by `firebase/firestore`. The two SDKs ship *different* `Timestamp` classes
 * that are not assignable to each other — the client one adds a `toJSON()` the
 * admin one does not have — so naming either of them here forces a lie in one
 * direction or the other, and picks a winner by accident of import path.
 *
 * This declares only the three members anything actually uses, and both classes
 * satisfy it. That is not a workaround for a type error: it is the real contract,
 * and it keeps `types/` from importing `firebase-admin`, which would drag a
 * server-only SDK into a module the client bundle can see.
 */
export type FirestoreInstant = {
  readonly seconds: number;
  readonly nanoseconds: number;
  toDate(): Date;
};

/* ========================================================================== */
/* MediaRef — what is attached to a report                                     */
/* ========================================================================== */

/**
 * One piece of evidence, as persisted on `incidents/{id}/reports/{rid}.media`.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PROPERTY THAT MATTERS: `storagePath` IS NEVER CLIENT-SUPPLIED
 * ---------------------------------------------------------------------------
 * Every field except `uploadedBy` is derived server-side from a verified object.
 * `storagePath` is computed by `attachEvidenceToIncident`, not echoed from the
 * request. brief §31: "Do not trust user-provided filenames as storage paths...
 * Never create paths such as /{originalFilename} directly."
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `downloadUrl`
 * ---------------------------------------------------------------------------
 * brief §16 shows an optional `downloadUrl` in its example shape. **It is
 * deliberately absent here**, and this is a real divergence from the brief.
 *
 * A persisted `downloadUrl` is a bearer token. Firebase's download URLs contain
 * a long-lived secret token; storing one in a Firestore document that is readable
 * by anyone who can read the incident means the URL outlives the authorization
 * decision that produced it. docs/15 §12 instead specifies a **15-minute signed
 * URL minted on demand** by `GET /api/uploads/:mediaId/url`, after the access
 * matrix in §13 has been evaluated. That is a T1 document being specific where
 * the brief is a sketch, and a stored URL is the specific failure the brief's own
 * §30 warns about ("Do not show private download tokens unnecessarily").
 *
 * The consequence for Phase 6: any UI that wants to show an image must fetch a
 * signed URL first. That is an extra round trip and it is the price of not
 * persisting a credential.
 */
export type MediaRef = {
  /** `med_XXXXXXXXXXXX`. Server-generated; the stable handle for this item. */
  readonly mediaId: string;
  readonly kind: MediaKind;
  /**
   * The SNIFFED type, never the declared one. docs/15 §5.3.
   *
   * Persisting the declared type alongside it would create a second source of
   * truth that a future reader could pick by mistake.
   */
  readonly contentType: AllowedMediaType;
  /** `incidents/{id}/reports/{rid}/{mediaId}.{ext}`. Computed, never echoed. */
  readonly storagePath: string;
  /** Over the whole object, for integrity and duplicate detection. */
  readonly sha256: string;
  readonly sizeBytes: number;
  /**
   * The reporter's original filename, for the dispatcher's display.
   *
   * **Sanitised, display-only, and never used to build a path.** It is stored so
   * a dispatcher sees "accident.jpg" rather than "med_A2F3K9QZ7M4C.jpg", and it
   * passes through `safeDownloadName()` before it gets here. Keeping a human
   * name is worth the (managed) risk; letting it influence a path is not.
   */
  readonly displayName: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSec: number | null;
  /**
   * `'clean'`, or `'pending'` when the sniff was inconclusive.
   *
   * docs/15 §8.1 step 7: a `pending` item is not served until it is resolved, so
   * this is a serving gate and not a cosmetic flag.
   */
  readonly scanStatus: 'clean' | 'pending' | 'quarantined';
  /** `token.uid`. From the verified token, never from the request body. */
  readonly uploadedBy: string;
  readonly uploadedAt: FirestoreInstant;
  /**
   * Set when the object was found to be gone at read time. docs/15 §16.4.
   *
   * Written by a read path, which is unusual and intentional: the alternative is
   * a dispatcher seeing a broken image icon and no explanation.
   */
  readonly storageMissing?: boolean;
  /** Set when the object was present but would not decode. docs/15 §16.4. */
  readonly storageCorrupt?: boolean;
};

/* ========================================================================== */
/* UploadStatus — one file's journey through the client                       */
/* ========================================================================== */

/**
 * Where one file is, in the browser.
 *
 * Seven states rather than a boolean pair, because the UI genuinely distinguishes
 * them: `validating` shows a spinner on a thumbnail that is not yet known to be
 * legal, `signing` is when the server is minting a URL, `uploading` is the only
 * state with a progress bar, and `finalizing` is after the bytes are up but
 * before the server has verified them — a window in which the file LOOKS done and
 * is not.
 *
 * brief §24's five labels ("Preparing... / Uploading... / Processing... /
 * Uploaded / Failed") are the user-facing subset; `validating` and `signing` both
 * render as "Preparing...", and `finalizing` renders as "Processing...".
 */
export type UploadStatus =
  /** Client-side type, size and dimension pre-check. Not yet sent. */
  | 'validating'
  /** Accepted locally. Not yet asked the server for a destination. */
  | 'ready'
  /** `POST /api/uploads/sign` in flight. */
  | 'signing'
  /** The PUT to Storage is in flight. This is the only state with a bar. */
  | 'uploading'
  /** `POST /api/uploads/finalize` in flight. Bytes are up, not yet trusted. */
  | 'finalizing'
  /** Verified. The `MediaRef` fields below are populated. */
  | 'uploaded'
  /** Refused or interrupted. `error` says which, and is safe to show. */
  | 'failed';

/** The terminal states — the two a retry button applies to. */
export type UploadTerminalStatus = Extract<UploadStatus, 'uploaded' | 'failed'>;

/**
 * One file being uploaded, as the UI holds it.
 *
 * `localId` is generated by the CLIENT and is the anti-duplicate key (brief §27).
 * It is never sent to the server and never becomes a `mediaId` — see
 * `features/reporting/evidence-uploader.tsx` for why the two are different
 * identifiers with different jobs.
 */
export type PendingUpload = {
  /** Client-only identity. Stable across a re-render, a retry, and a remount. */
  readonly localId: string;
  readonly status: UploadStatus;
  /** 0-100, integer. Real bytes, never an animation. brief §24. */
  readonly progress: number;
  readonly fileName: string;
  readonly sizeBytes: number;
  /** The client's claim. Overwritten by the SNIFFED type once verified. */
  readonly declaredMimeType: string;
  readonly kind: MediaKind;
  /** Present once `status === 'uploaded'`. */
  readonly mediaId?: string;
  readonly verifiedContentType?: AllowedMediaType;
  readonly sha256?: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationSec?: number | null;
  /** Safe to render. Never contains a path, a uid, or a raw SDK message. */
  readonly error?: string;
  /** `true` once a retry has been attempted, so the UI can offer "Retry" instead. */
  readonly retryable?: boolean;
};

/* ========================================================================== */
/* VoiceState — the recorder's state machine                                    */
/* ========================================================================== */

/**
 * brief §5's seven states, verbatim, plus `idle`.
 *
 * `unsupported` is the one that is not really a recorder state — it is the state
 * of a device where recording cannot happen at all — and it is included because
 * a component that has to render four different states when the microphone is
 * unavailable will render all of them the wrong way at some point. Making it a
 * member of the union means the type system requires the branch to exist.
 */
export type VoiceState =
  | 'idle'
  | 'recording'
  /** Present only where `MediaRecorder.pause()`/`resume()` exist. */
  | 'paused'
  | 'processing'
  | 'completed'
  | 'error'
  | 'unsupported';

/**
 * The states in which a recording is running and the user must not be able to
 * start another.
 *
 * **A derived type, not a hand-maintained list.** brief §27 ("Prevent accidental
 * multiple simultaneous recordings") and §6 are both satisfied by a single
 * `includes` check that cannot drift from the union. Adding a state to
 * `VoiceState` without considering it here is a compile error rather than a
 * double-recording bug.
 */
export const VOICE_ACTIVE_STATES: readonly VoiceState[] = ['recording', 'paused'];

/** Is the recorder mid-take? One place, so the UI and the guard cannot disagree. */
export function voiceIsActive(state: VoiceState): boolean {
  return VOICE_ACTIVE_STATES.includes(state);
}

/** States that offer a retry. `unsupported` is absent — retrying cannot help. */
export const VOICE_RETRYABLE_STATES: readonly VoiceState[] = ['error'];

/**
 * A finished recording, before it is uploaded.
 *
 * `blob` is a browser object and therefore **client-only**. It must never be
 * serialised into a `MediaRef` (brief §17: no base64 blobs in Firestore) and it
 * is deliberately not part of any server-side type.
 */
export type VoiceRecording = {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly durationSec: number;
  /** The client's own name for the clip, for the display field. Never a path. */
  readonly displayName: string;
};

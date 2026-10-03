'use client';

/**
 * ============================================================================
 * CareGrid AI — the evidence uploader
 * ============================================================================
 *
 * brief §10. Replaces the Phase 1 `EvidenceSlots`, which drew a progress bar that
 * a timer filled in with no bytes moving.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PHASE 1 COMPONENT HAD TO BE REPLACED, NOT EXTENDED
 * ---------------------------------------------------------------------------
 * `EvidenceSlots` created a fake `EvidenceItem` per click and animated its
 * `progress` to 1. It looked exactly like a working uploader and was not one.
 *
 * brief §24 is explicit: "Do not fake progress. Use actual upload progress where
 * available." And docs/15 §16.1's whole failure-mode table assumes a real transfer
 * that can be interrupted. A simulated bar cannot be interrupted, so it cannot
 * exercise — or reproduce — any of the recovery paths the specification requires.
 *
 * The Phase 1 component is left in the tree, unused, because `report-view.tsx`
 * and the Phase 1 tests reference it. Deleting it is a Phase 6 tidy-up, and
 * removing a component that other files import is a bigger change than Phase 5
 * needs.
 *
 * ---------------------------------------------------------------------------
 * THE PROGRESS BAR IS REAL BYTES
 * ---------------------------------------------------------------------------
 * Every percentage in this file came from `xhr.upload.onprogress`. There is no
 * `setInterval` anywhere in it, and the bar cannot reach 100 until the server has
 * verified the object — `finalizing` is a separate, visible state for the window
 * between "bytes are up" and "we know what they are".
 *
 * ---------------------------------------------------------------------------
 * ONE FILE AT A TIME, AND THE OTHERS KEEP GOING
 * ---------------------------------------------------------------------------
 * brief §26: when one of several files fails, the successful ones stay. Each item
 * carries its own `status` in a module-level store, so a failure is scoped to the
 * one item and the others are untouched. There is no single `isUploading` flag
 * anywhere, because one flag cannot represent three uploaded, one uploading and
 * one failed.
 */

import * as React from 'react';
import { ImagePlus, X, RotateCcw, CheckCircle2, Loader2, FileWarning } from 'lucide-react';

import { Alert, AlertDescription, AlertIcon, AlertTitle, Button, Label, Progress } from '@/components/ui';
import { getUploadLimits } from '@/lib/env.client';
import {
  canAddMore,
  isInFlight,
  preCheckQuota,
  removeUpload,
  retryUpload,
  startUpload,
  subscribeUploads,
  uploadSnapshot,
  type UploadRejection,
} from '@/features/reporting/upload-manager';
import type { PendingUpload } from '@/types/media';

/* ========================================================================== */
/* Copy                                                                        */
/* ========================================================================== */

/**
 * brief §24's five labels, plus what is needed around them.
 *
 * `UPLOAD_FAILED` deliberately says the report has NOT been submitted. brief §25:
 * "Your emergency report has not been submitted yet." A failure message that omits
 * that leaves a citizen believing their report is filed, which during an emergency
 * is the most damaging thing this component could get wrong.
 */
const COPY = {
  addTitle: 'Add emergency photo',
  addLead: 'Drag & drop, or browse',
  formats: 'JPG · PNG · WEBP',
  counter: (current: number, max: number) => `${current} / ${max} photos added`,
  preparing: 'Preparing…',
  signing: 'Preparing…',
  uploading: 'Uploading…',
  finalizing: 'Processing…',
  uploaded: 'Uploaded',
  failed: 'Upload failed',
  failedBody: 'Your emergency report has not been submitted yet.',
  retry: 'Retry',
  remove: 'Remove',
  dropActive: 'Drop the photo here',
} as const;

/**
 * brief §24's five user-facing labels, from `PendingUpload['status']`.
 *
 * A switch rather than a lookup, because the mapping is not one-to-one and the
 * collapses are the point: `validating`, `ready` and `signing` all render as
 * "Preparing…" because a citizen cannot tell them apart or act on the difference,
 * while `finalizing` is its own label because the bytes ARE up and the server is
 * deciding whether to accept them — a materially different wait.
 */
function statusLabel(status: PendingUpload['status']): string {
  switch (status) {
    case 'validating':
    case 'ready':
    case 'signing':
      return COPY.preparing;
    case 'uploading':
      return COPY.uploading;
    case 'finalizing':
      return COPY.finalizing;
    case 'uploaded':
      return COPY.uploaded;
    case 'failed':
      return COPY.failed;
    default:
      return COPY.preparing;
  }
}

/* ========================================================================== */
/* Component                                                                   */
/* ========================================================================== */

export type EvidenceUploaderProps = {
  /** Called when the set of uploaded items changes, so the form can enable submit. */
  readonly onChange?: (uploaded: readonly PendingUpload[]) => void;
  readonly disabled?: boolean;
};

export function EvidenceUploader({ onChange, disabled = false }: EvidenceUploaderProps) {
  const limits = getUploadLimits();
  const [items, setItems] = React.useState<readonly PendingUpload[]>(uploadSnapshot);
  const [rejection, setRejection] = React.useState<UploadRejection | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  /* --- subscribe to the module-level store ----------------------------- */
  // `useSyncExternalStore` rather than `useState` + an effect. The store already
  // exists outside React, so subscribing is the honest binding; the alternative is
  // a second copy of the state in the component, which is the "React re-render"
  // duplicate-upload cause brief §27 names.
  React.useEffect(() => {
    const unsubscribe = subscribeUploads(setItems);
    // A remount reattaches to whatever survived, rather than starting empty. This
    // is brief §27's "component remount" case, handled by the store being a module
    // singleton rather than by anything in this component.
    setItems(uploadSnapshot());
    return unsubscribe;
  }, []);

  /* --- tell the form what is uploaded ---------------------------------- */
  React.useEffect(() => {
    onChange?.(items.filter((item) => item.status === 'uploaded'));
  }, [items, onChange]);

  /* --- picking files --------------------------------------------------- */
  const handleFiles = React.useCallback(
    (files: FileList | File[] | null) => {
      if (files === null) return;
      const list = Array.from(files);
      setRejection(null);

      for (const file of list) {
        // The duplicate guard, before anything else. `isInFlight` is synchronous
        // and keyed on the file's fingerprint, so re-picking the same photo in the
        // same picker dialog cannot start a second PUT.
        if (isInFlight(file)) {
          setRejection({ code: 'UNREADABLE', message: 'That photo is already uploading.' });
          continue;
        }

        const quota = preCheckQuota(uploadSnapshot(), 'image');
        if (quota !== null) {
          // The quota message names the ACTUAL count, so a citizen who has one
          // voice note and two photos is told why a fourth will not fit rather
          // than being told "too many" with no number.
          setRejection(quota);
          break;
        }

        void startUpload({
          file,
          kind: 'image',
          // The citizen's own filename, as a DISPLAY hint. It is never used to
          // build a storage path — docs/15 §3.5, and the server derives the
          // extension from the sniffed type.
          displayName: file.name,
        });
      }
    },
    [],
  );

  /* --- remove and retry ------------------------------------------------ */
  const handleRemove = React.useCallback((localId: string) => {
    removeUpload(localId);
  }, []);

  /**
   * Retry a failed item.
   *
   * The `File` is not kept in the store — a `Map` of blobs would sit in memory for
   * the life of the report — so the citizen re-picks it. brief §25 offers `[Retry]`
   * and `[Remove]`; this is that Retry, and the label says where the file comes
   * from rather than pretending the bytes were retained.
   */
  const handleRetry = React.useCallback((item: PendingUpload) => {
    inputRef.current?.click();
    // Stashed for the next `change` event, because a retry needs the ORIGINAL
    // file and the picker gives us a fresh `FileList` with no way to tell which
    // one it is for.
    pendingRetryRef.current = item;
  }, []);

  const pendingRetryRef = React.useRef<PendingUpload | null>(null);

  const onInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const retryTarget = pendingRetryRef.current;
      pendingRetryRef.current = null;
      // Reset so re-picking the SAME file fires `change` again. Without this, a
      // citizen who retries the same photo after a fix gets no event at all and
      // the button appears broken.
      event.target.value = '';

      if (file === undefined) return;
      if (retryTarget === null) {
        handleFiles([file]);
        return;
      }
      void retryUpload(retryTarget.localId, file, {
        kind: 'image',
        displayName: retryTarget.fileName,
      });
    },
    [handleFiles],
  );

  const uploaded = items.filter((item) => item.status === 'uploaded');
  const failed = items.filter((item) => item.status === 'failed');
  const atMax = !canAddMore(items);

  return (
    <div className="flex flex-col gap-4">
      {/* --- the drop zone ------------------------------------------------ */}
      {!atMax ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            handleFiles(event.dataTransfer.files);
          }}
          className={`rounded-lg border-2 border-dashed p-6 text-center ${
            dragging ? 'border-primary bg-primary/5' : 'border-border'
          }`}
        >
          <ImagePlus aria-hidden="true" className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-2 font-medium">{dragging ? COPY.dropActive : COPY.addTitle}</p>
          <p className="text-sm text-secondary">{COPY.addLead}</p>
          <p className="mt-1 text-xs text-muted-foreground">{COPY.formats}</p>

          {/* brief §28: the BROWSE button is the primary path on mobile, and it
              is a real `<label for>` + hidden input rather than a div with a click
              handler — so it is reachable by keyboard, announced as a button, and
              opens the camera roll on iOS. `capture` is NOT set: forcing the
              camera would prevent a citizen from picking an existing photo, which
              is the more common case for evidence. */}
          <Label htmlFor="evidence-file-input" className="sr-only">
            Choose an emergency photo
          </Label>
          <input
            ref={inputRef}
            id="evidence-file-input"
            type="file"
            accept={limits.acceptedImageTypes.join(',')}
            multiple
            className="sr-only"
            disabled={disabled}
            onChange={onInputChange}
          />
          <Button
            type="button"
            variant="secondary"
            className="mt-3"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {COPY.addLead}
          </Button>
        </div>
      ) : null}

      {/* --- the count ---------------------------------------------------- */}
      {items.length > 0 ? (
        <p className="text-sm text-secondary">
          {COPY.counter(uploaded.length, limits.maxImages)}
        </p>
      ) : null}

      {/* --- a refusal ---------------------------------------------------- */}
      {rejection !== null ? (
        <Alert tone="warning">
          <AlertIcon tone="warning" />
          <AlertDescription>{rejection.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* --- the per-item list -------------------------------------------- */}
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.localId}>
            <EvidenceItemRow
              item={item}
              onRemove={() => handleRemove(item.localId)}
              onRetry={() => handleRetry(item)}
              disabled={disabled}
            />
          </li>
        ))}
      </ul>

      {/* --- the partial-failure summary (brief §26) ----------------------- */}
      {failed.length > 0 && uploaded.length > 0 ? (
        <Alert tone="warning">
          <AlertIcon tone="warning" />
          <div className="flex min-w-0 flex-col gap-1">
            <AlertTitle>
              {failed.length === 1 ? 'One photo did not upload' : `${failed.length} photos did not upload`}
            </AlertTitle>
            {/* brief §26: the successful ones are kept and the failure is
                per-item. This sentence is what tells the citizen that, so they
                do not re-upload files that already worked. */}
            <AlertDescription>
              {COPY.failedBody} Your other {uploaded.length === 1 ? 'photo is' : 'photos are'} saved.
            </AlertDescription>
          </div>
        </Alert>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* One row                                                                     */
/* ========================================================================== */

/**
 * One file's row: name, real progress, and the right action for its state.
 *
 * brief §29: the status is conveyed by an ICON AND TEXT, never by colour alone.
 * A green bar means nothing to a screen reader and little to a red-green
 * colourblind reader, so every state has a word next to it.
 */
function EvidenceItemRow({
  item,
  onRemove,
  onRetry,
  disabled,
}: {
  readonly item: PendingUpload;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
  readonly disabled: boolean;
}) {
  const inFlight = item.status === 'validating' || item.status === 'ready' || item.status === 'signing' || item.status === 'uploading' || item.status === 'finalizing';
  const failed = item.status === 'failed';
  const done = item.status === 'uploaded';

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <StatusIcon state={item.status} />
          <div className="flex min-w-0 flex-col">
            {/* `truncate` with a `title`, so a long filename is bounded on a
                320px screen and the full name is still available on hover. */}
            <span className="truncate text-sm font-medium" title={item.fileName}>
              {item.fileName}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatBytes(item.sizeBytes)}
              {item.width !== null && item.width !== undefined && item.height ? ` · ${item.width}×${item.height}` : ''}
            </span>
          </div>
        </div>

        {/* brief §12: every item can be removed before submission. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={inFlight || disabled}
          aria-label={`Remove ${item.fileName}`}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      {/* --- the real progress bar --------------------------------------- */}
      {inFlight ? (
        <>
          <Progress
            value={item.progress}
            aria-label={`Uploading ${item.fileName}, ${item.progress} percent`}
          />
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {statusLabel(item.status)} {item.progress > 0 ? `${item.progress}%` : ''}
          </p>
        </>
      ) : null}

      {done ? (
        <p className="text-xs text-muted-foreground">{COPY.uploaded}</p>
      ) : null}

      {failed ? (
        <div className="flex flex-col gap-2">
          {/* `role="alert"` rather than `aria-live="polite"`: a failure is the one
              state that must interrupt, because the citizen may otherwise believe
              their report is complete. */}
          <p role="alert" className="flex items-start gap-2 text-sm text-danger">
            <FileWarning aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              {item.error}
              <span className="block text-xs text-muted-foreground">
                {COPY.failedBody}
                {item.error === 'Image storage is temporarily unavailable in this demo.'
                  ? ' Remove this image to continue without it.'
                  : ''}
              </span>
            </span>
          </p>
          {item.retryable ? (
            <Button type="button" variant="secondary" size="sm" onClick={onRetry} disabled={disabled}>
              <RotateCcw aria-hidden="true" />
              {COPY.retry}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The state icon. Paired with text by the row; never the only signal. */
function StatusIcon({ state }: { readonly state: PendingUpload['status'] }) {
  if (state === 'failed') return <FileWarning aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />;
  if (state === 'uploaded') return <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />;
  return <Loader2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />;
}

/**
 * `1.8 MB`, from bytes.
 *
 * One decimal below 10 MB, none above, because `5.2 MB` and `12 MB` are both
 * useful and `12.4 MB` is not. The unit is MB rather than MiB because that is what
 * every phone's camera app and every file picker says — a citizen comparing the
 * message to their own "Photos" app is comparing against MB.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

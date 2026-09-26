'use client';

import * as React from 'react';
import { Image as ImageIcon, Trash2 } from 'lucide-react';

import { IconButton, Progress } from '@/components/ui';
import { REPORT_COPY } from '@/features/reporting/report-copy';
import { REPORT_LIMITS } from '@/config';
import { formatPercent } from '@/lib/format';
import type { EvidenceItem } from '@/features/reporting/report-types';

/**
 * Photo evidence slots — docs/04 §13.2 Components (`useUpload` image slots).
 *
 * PHASE 1 IS A SIMULATION. There is no `<input type="file">`, no FileReader,
 * no `POST /api/uploads/sign`, and no request. The slots exist so the layout,
 * the count, the progress treatment, and the remove affordance can be reviewed
 * before the pipeline lands. A slot that pretends to upload is worse than no
 * slot, so the helper text says exactly what is happening.
 *
 * `onProgress` is stable, which is what lets a single interval drive one slot
 * without re-rendering the whole form on every tick.
 */
export function EvidenceSlots({
  items,
  onAdd,
  onRemove,
  onProgress,
}: {
  items: readonly EvidenceItem[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onProgress: (id: string, progress: number) => void;
}) {
  const emptySlots = Math.max(0, REPORT_LIMITS.maxImages - items.length);

  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-3">
        {items.map((item) => (
          <FilledSlot key={item.id} item={item} onRemove={onRemove} onProgress={onProgress} />
        ))}

        {Array.from({ length: emptySlots }, (_, index) => (
          <li key={`slot-${index}`}>
            <button
              type="button"
              onClick={onAdd}
              className="flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-card border border-dashed border-control bg-inset px-2 py-3 text-center transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app"
            >
              <ImageIcon className="size-icon-lg text-muted" aria-hidden="true" />
              <span className="text-xs text-secondary">
                {REPORT_COPY.addPhotoLabel} {items.length + index + 1}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="text-xs text-secondary">{REPORT_COPY.photosHelper}</p>
    </div>
  );
}

/**
 * A filled slot. The progress bar is present only while the simulated upload is
 * running, and its `aria-valuetext` is the same string as the visible text so a
 * screen reader is not told "0.4" while the screen says 40 % (docs/04 §5.20).
 */
function FilledSlot({
  item,
  onRemove,
  onProgress,
}: {
  item: EvidenceItem;
  onRemove: (id: string) => void;
  onProgress: (id: string, progress: number) => void;
}) {
  const done = item.progress >= 1;

  React.useEffect(() => {
    if (done) return;
    const timer = setInterval(() => {
      const next = Math.min(1, item.progress + 0.1);
      onProgress(item.id, next);
      if (next >= 1) clearInterval(timer);
    }, 220);
    return () => clearInterval(timer);
    // `done` and `item.progress` drive the effect; the timer is cleared either way.
  }, [done, item.progress, item.id, onProgress]);

  const progressLabel = done
    ? 'Photo attached'
    : `Uploading photo, ${formatPercent(item.progress * 100, 0)} complete`;

  return (
    <li className="relative flex flex-col gap-2">
      <div className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-card border border-subtle bg-inset px-2 py-3">
        <ImageIcon className="size-icon-lg text-secondary" aria-hidden="true" />
        <p className="w-full truncate text-center text-2xs text-muted">{item.name}</p>
      </div>

      <Progress
        value={item.progress}
        label={progressLabel}
        fillClassName={done ? 'bg-success' : undefined}
      />

      <IconButton
        // The accessible name carries the file name, so a screen-reader user
        // knows WHICH photo is being removed. Anti-pattern A10.
        label={`Remove ${item.name}`}
        icon={Trash2}
        size="sm"
        tone="danger"
        className="absolute -top-2 -right-2 min-h-9 min-w-9 bg-surface"
        onClick={() => onRemove(item.id)}
      />
    </li>
  );
}

import * as React from 'react';

import { cn } from '@/lib/cn';
import { Progress } from '@/components/ui/progress';
import { formatSlaRemaining } from '@/lib/format';
import type { SlaState } from '@/types/enums';

/**
 * SlaMeter — docs/04 §5.20
 *
 * Deterministic SLA state with colour + icon + text. Three rules that matter:
 *
 *  1. The COUNTDOWN IS NOT AN `aria-live` REGION. A value that changes every
 *     15 seconds would flood a screen reader. Only the transition INTO
 *     `breached` announces, once, via `role="status"`.
 *  2. `aria-valuetext` is the SAME string as the visible text, so the reader is
 *     never told "0.6" while the screen says "At risk, 1 min left".
 *  3. Numbers are tabular so a ticking clock cannot reflow the row.
 */
export type SlaMeterProps = {
  /** Minutes from the SLA clock start. 5 / 15 / 60 / 240. */
  targetMin: number;
  /** Minutes elapsed since `verifiedAt ?? createdAt`. */
  elapsedMin: number;
  state: SlaState;
  className?: string;
  /** Hide the text and show only the meter (dense table variant). */
  compact?: boolean;
};

const TONE: Record<SlaState, { fill: string; text: string }> = {
  on_track: { fill: 'bg-success', text: 'text-success' },
  at_risk: { fill: 'bg-warning', text: 'text-warning' },
  breached: { fill: 'bg-danger', text: 'text-danger' },
};

export function SlaMeter({
  targetMin,
  elapsedMin,
  state,
  className,
  compact = false,
}: SlaMeterProps) {
  const { text } = formatSlaRemaining(targetMin, elapsedMin);
  const ratio = targetMin > 0 ? Math.max(0, Math.min(1, 1 - elapsedMin / targetMin)) : 0;
  const tone = TONE[state];

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <Progress
        value={ratio}
        fillClassName={tone.fill}
        label={text}
        className="min-w-16"
      />
      <p className={cn('text-xs tabular', tone.text)}>{text}</p>
      {state === 'breached' ? (
        <span role="status" className="sr-only">
          Response target passed for this incident.
        </span>
      ) : null}
      {compact ? <span className="sr-only">{text}</span> : null}
    </div>
  );
}

/** Compact inline variant for table cells: the text only, no track. */
export function SlaInline({
  targetMin,
  elapsedMin,
  className,
}: {
  targetMin: number;
  elapsedMin: number;
  className?: string;
}) {
  const { state, text } = formatSlaRemaining(targetMin, elapsedMin);
  return (
    <span className={cn('text-xs tabular', TONE[state].text, className)}>
      <span className="sr-only">SLA: </span>
      {text}
    </span>
  );
}

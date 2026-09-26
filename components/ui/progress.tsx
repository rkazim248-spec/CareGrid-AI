'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';

import { cn } from '@/lib/cn';

/**
 * Progress — docs/04 §5.20
 * 6px track, inset fill surface, pill radius. Indeterminate when `value` is
 * null. `aria-valuetext` must be the SAME string as the visible label so a
 * screen reader is not told "50" while the screen says "On track, 3 min left".
 */
function Progress({
  className,
  value,
  fillClassName,
  label,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  fillClassName?: string;
  /** The human sentence, used for both `aria-valuetext` and the visible text. */
  label?: string;
}) {
  const pct = value === null || value === undefined ? null : Math.round(value * 100);
  return (
    <ProgressPrimitive.Root
      className={cn('relative h-1.5 w-full overflow-hidden rounded-pill bg-inset', className)}
      value={value ?? null}
      aria-valuetext={label}
      aria-label={props['aria-label'] ?? label}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full w-full flex-1 rounded-pill bg-accent transition-transform duration-[--motion-duration-base]',
          'motion-reduce:transition-none',
          fillClassName,
        )}
        style={{ transform: `translateX(-${100 - (pct ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

/** Indeterminate variant: a sliding bar for an unknown-duration operation. */
function ProgressIndeterminate({ className, label }: { className?: string; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-pill bg-inset', className)}
    >
      <div
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 w-1/3 rounded-pill bg-accent',
          'animate-[var(--animate-shimmer)]',
          'motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-40',
        )}
      />
    </div>
  );
}

export { Progress, ProgressIndeterminate };

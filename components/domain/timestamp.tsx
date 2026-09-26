'use client';

import * as React from 'react';

import { cn } from '@/lib/cn';
import {
  formatAbsolute,
  formatRelative,
  relativeTimeAriaLabel,
  toDateTimeAttr,
} from '@/lib/format';

/**
 * Timestamp / RelativeTime — docs/04 §5.28
 *
 * `Timestamp` renders an absolute time (that is what a person needs to
 * correlate with a log) and carries the full ISO in `title` for support.
 *
 * `RelativeTime` shows "4 min ago" but its `aria-label` is the ABSOLUTE time.
 * "4 min ago" is a useful glance and a poor instruction; "26 September 2026 at
 * 15:04" is the opposite, and that is what a screen-reader user gets.
 */
export function Timestamp({
  iso,
  className,
  showDate = true,
}: {
  iso: string;
  className?: string;
  showDate?: boolean;
}) {
  return (
    <time
      dateTime={toDateTimeAttr(iso)}
      title={toDateTimeAttr(iso)}
      className={cn('text-xs text-secondary tabular', className)}
    >
      {showDate ? formatAbsolute(iso) : formatAbsolute(iso).split(',')[1]?.trim()}
    </time>
  );
}

export function RelativeTime({
  iso,
  className,
  /** Re-render interval. 30s keeps "2 min ago" honest without churn. */
  refreshMs = 30_000,
}: {
  iso: string;
  className?: string;
  refreshMs?: number;
}) {
  const [, force] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    const timer = setInterval(force, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  return (
    <time
      dateTime={toDateTimeAttr(iso)}
      title={formatAbsolute(iso)}
      aria-label={relativeTimeAriaLabel(iso)}
      className={cn('text-xs text-muted tabular', className)}
    >
      {formatRelative(iso)}
    </time>
  );
}

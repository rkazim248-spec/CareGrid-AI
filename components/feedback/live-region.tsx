'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * LiveRegion — a polite announcement channel for state changes.
 *
 * Two rules, both from docs/04:
 *  - Realtime ROW updates do NOT announce. A dispatcher watching a queue would
 *    otherwise be read forty updates a minute by a screen reader.
 *  - Only genuinely new, actionable facts announce: "reconnecting", "Live",
 *    "1 new incident", "SLA breached".
 *
 * So this component is used sparingly and deliberately, not wired to every value.
 */
export function LiveRegion({
  message,
  className,
  assertive = false,
}: {
  message: string;
  className?: string;
  assertive?: boolean;
}) {
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={cn('sr-only', className)}
    >
      {message}
    </div>
  );
}

/**
 * PendingBadge — the optimistic-write marker (FR-076).
 * The row renders at reduced opacity with this spinner and `aria-busy` set on
 * the row itself, not here.
 */
export function PendingBadge({ label = 'Saving' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <Loader2
        className="size-3.5 animate-[var(--animate-spin-slow)] motion-reduce:animate-none"
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

/**
 * RequestId — a copyable correlation id. Support can trace it in server logs.
 * The copy button has a real label, because a bare glyph is anti-pattern A10.
 */
export function RequestId({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);

  const copy = React.useCallback(() => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy request reference ${value}`}
      className="font-mono text-2xs text-muted transition-colors hover:text-secondary focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus"
    >
      {value}
      <span className="sr-only">{copied ? ' — copied' : ' — copy'}</span>
    </button>
  );
}

/** Small inline "Demo Data" provenance chip. docs/04 §15.5 */
export function DemoDataBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-pill border border-warning bg-warning-muted px-2 py-0.5 text-2xs font-semibold tracking-[0.06em] text-warning-fg-muted uppercase',
        className,
      )}
    >
      Demo data
    </span>
  );
}

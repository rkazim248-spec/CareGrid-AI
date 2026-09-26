import * as React from 'react';

import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { SAFETY_FLAG_META } from '@/config/safety-flags';
import type { SafetyFlag } from '@/types/enums';

/**
 * SafetyFlagChips — docs/04 §7.3
 *
 * Each flag has a FIXED chip. The tone split is the point: the four flags that
 * force an urgency floor are `danger`, the rest are `warning`. A flag that
 * cannot change a decision must not be painted like one that can, or the
 * dispatcher's eye stops discriminating.
 *
 * Chips are always visible at the row level. Hiding them in a "details"
 * expander is anti-pattern A12 and directly violates FR-024.
 */
const TONE: Record<'danger' | 'warning' | 'accent', { bg: string; border: string; text: string }> = {
  danger: { bg: 'bg-danger-muted', border: 'border-danger', text: 'text-danger-fg-muted' },
  warning: { bg: 'bg-warning-muted', border: 'border-warning', text: 'text-warning-fg-muted' },
  accent: { bg: 'bg-accent-muted', border: 'border-accent', text: 'text-accent-fg-muted' },
};

export function SafetyFlagChip({
  flag,
  className,
}: {
  flag: SafetyFlag;
  className?: string;
}) {
  const meta = SAFETY_FLAG_META[flag];
  const Icon = meta.icon;
  const tone = TONE[meta.tone];

  return (
    <Badge
      variant="default"
      size="sm"
      className={cn(tone.bg, tone.border, tone.text, className)}
      aria-label={`Safety flag: ${meta.label}`}
    >
      <Icon aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

export function SafetyFlagChips({
  flags,
  max = 4,
  className,
}: {
  flags: readonly SafetyFlag[];
  /** Beyond this, render "+n more" as visible text rather than hiding silently. */
  max?: number;
  className?: string;
}) {
  if (flags.length === 0) return null;
  const shown = flags.slice(0, max);
  const overflow = flags.length - shown.length;

  return (
    <ul className={cn('flex flex-wrap items-center gap-1.5', className)} aria-label="Safety flags">
      {shown.map((flag) => (
        <li key={flag}>
          <SafetyFlagChip flag={flag} />
        </li>
      ))}
      {overflow > 0 ? (
        <li>
          <span className="text-xs text-secondary">+{overflow} more</span>
        </li>
      ) : null}
    </ul>
  );
}

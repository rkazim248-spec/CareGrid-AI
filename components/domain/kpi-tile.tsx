import * as React from 'react';
import { CircleCheck, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { RelativeTime } from '@/components/domain/timestamp';

/**
 * KpiTile — docs/04 §5.24
 *
 * FR-078 / US-020 AC4: the "as of" time is MANDATORY. A number with no
 * timestamp is a claim with no evidence, and in an operations console that is
 * how a dispatcher acts on stale data.
 *
 * There is deliberately NO count-up animation (anti-pattern A9). The number
 * swaps instantly and the tile border carries the live-update treatment.
 */
export type KpiTileProps = {
  label: string;
  value: string | number;
  /** ISO timestamp of the underlying snapshot. */
  asOfIso: string;
  /** Optional secondary line, e.g. "2 need review". */
  hint?: string;
  variant?: 'default' | 'critical' | 'breached';
  /** Optional icon. Never the only meaning. */
  icon?: LucideIcon;
  className?: string;
};

const VARIANT: Record<NonNullable<KpiTileProps['variant']>, { ring: string; value: string }> = {
  default: { ring: 'border-subtle', value: 'text-primary' },
  critical: { ring: 'border-urgency-critical', value: 'text-urgency-critical' },
  breached: { ring: 'border-danger', value: 'text-danger' },
};

export function KpiTile({
  label,
  value,
  asOfIso,
  hint,
  variant = 'default',
  icon: Icon,
  className,
}: KpiTileProps) {
  const tone = VARIANT[variant];
  const StatusIcon = variant === 'breached' ? OctagonAlert : variant === 'critical' ? TriangleAlert : CircleCheck;

  return (
    <section
      aria-label={label}
      className={cn(
        'flex flex-col gap-1 rounded-card border bg-surface px-4 py-3',
        tone.ring,
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className="size-3.5 text-muted" aria-hidden="true" /> : null}
        <h3 className="uppercase-label text-muted">{label}</h3>
      </div>

      <p className={cn('text-3xl leading-none font-bold tabular', tone.value)}>{value}</p>

      {hint ? <p className="text-xs text-secondary">{hint}</p> : null}

      <p className="flex items-center gap-1.5 text-2xs text-muted">
        <StatusIcon className="size-3" aria-hidden="true" />
        as of <RelativeTime iso={asOfIso} />
      </p>
    </section>
  );
}

/**
 * The horizontal KPI strip. On mobile it scrolls with scroll-snap rather than
 * wrapping, because a wrapped strip pushes the queue below the fold on the one
 * screen where vertical space is scarcest (docs/04 §13.7).
 */
export function KpiTileRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5',
        'max-lg:snap-x max-lg:flex max-lg:overflow-x-auto max-lg:pb-1',
        className,
      )}
    >
      {children}
    </div>
  );
}

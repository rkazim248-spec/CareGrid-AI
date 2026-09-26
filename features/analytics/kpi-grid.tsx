'use client';

import { Bot, CircleCheck, Gauge, Siren, Target, Timer, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { KpiTile } from '@/components/domain';
import { formatDuration, formatPercent } from '@/lib/format';
import type { Analytics } from '@/types';

/**
 * KpiGrid — the analytics totals (docs/04 §13.13, FR-110…FR-118).
 *
 * Eight tiles, every one of them carrying the same three properties the spec
 * demands of a number in an operations console:
 *   - an `as of` time, so the figure is not an unsourced claim;
 *   - a unit in the VALUE itself ("24 min", "88.4%") rather than in a column
 *     header nobody remembers;
 *   - never a bare number where a rate is meant — `formatPercent` and
 *     `formatDuration` do the rounding, and the client never re-derives them.
 *
 * `Sla compliance`, `false-alarm rate`, `AI fallback rate` and `mean AI
 * confidence` come from the same `totals` block as the counts. They are grouped
 * after the counts, not interleaved, because they are ratios and mixing them
 * with counts makes both harder to scan.
 */

type TileSpec = {
  label: string;
  value: string;
  hint?: string;
  variant: 'default' | 'critical' | 'breached';
  icon: LucideIcon;
};

export function buildAnalyticsTiles(totals: Analytics['totals']): TileSpec[] {
  return [
    {
      label: 'Total incidents',
      value: String(totals.total),
      variant: 'default',
      icon: Gauge,
    },
    {
      label: 'Critical incidents',
      value: String(totals.critical),
      variant: totals.critical > 0 ? 'critical' : 'default',
      icon: Siren,
    },
    {
      label: 'Resolved',
      value: String(totals.resolved),
      hint: `${totals.cancelled} cancelled · ${totals.falseAlarm} false alarm`,
      variant: 'default',
      icon: CircleCheck,
    },
    {
      label: 'Average response time',
      value: formatDuration(totals.meanTimeToDispatchSec),
      hint: `Verify in ${formatDuration(totals.meanTimeToVerifySec)} · resolve in ${formatDuration(totals.meanTimeToResolveSec)}`,
      variant: 'default',
      icon: Timer,
    },
    {
      label: 'SLA compliance',
      value: formatPercent(totals.slaCompliancePct),
      hint: 'Share of incidents picked up inside the response target.',
      variant: totals.slaCompliancePct < 90 ? 'breached' : 'default',
      icon: Target,
    },
    {
      label: 'False-alarm rate',
      value: formatPercent(falseAlarmRate(totals)),
      hint: `${totals.falseAlarm} of ${totals.total} incidents.`,
      variant: 'default',
      icon: TriangleAlert,
    },
    {
      label: 'AI fallback rate',
      value: formatPercent(totals.aiFallbackRatePct),
      hint: 'Reports that needed the automatic fallback path.',
      variant: 'default',
      icon: Bot,
    },
    {
      label: 'Mean AI confidence',
      value: totals.meanAiConfidence.toFixed(2),
      hint: 'An estimate from report text and media. A person reviews every field.',
      variant: 'default',
      icon: Bot,
    },
  ];
}

/** False alarms as a share of every incident in the period. Never guessed. */
export function falseAlarmRate(totals: Analytics['totals']): number {
  if (!totals.total) return 0;
  return (totals.falseAlarm / totals.total) * 100;
}

export function KpiGrid({
  totals,
  asOfIso,
}: {
  totals: Analytics['totals'];
  asOfIso: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {buildAnalyticsTiles(totals).map((tile) => (
        <KpiTile
          key={tile.label}
          label={tile.label}
          value={tile.value}
          asOfIso={asOfIso}
          {...(tile.hint ? { hint: tile.hint } : {})}
          variant={tile.variant}
          icon={tile.icon}
        />
      ))}
    </div>
  );
}

/** Placeholder for `analytics/loading.tsx` usage. Geometry matches the real tiles. */
export function KpiGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 rounded-card border border-subtle bg-surface px-4 py-3"
        >
          <div className="skeleton-fill h-3 w-28 rounded-sm" />
          <div className="skeleton-fill h-7 w-16 rounded-sm" />
          <div className="skeleton-fill h-3 w-32 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

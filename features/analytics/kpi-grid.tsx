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

/**
 * What an unmeasurable metric renders as.
 *
 * brief §30: "Never fabricate values. Example: `Not enough data to calculate
 * response time.` is preferable to displaying an invented metric." And
 * `docs/14 §2.1`: "A metric whose inputs are absent is `null`, never `0`. `0`
 * asserts 'we measured zero'; `null` asserts 'we could not measure this'."
 *
 * Before Phase 9, `AnalyticsTotals` typed every metric as `number`, so this
 * sentence could not exist — a duration computed from zero qualifying records had
 * to be *some* number, and `formatDuration(0)` reads on a dispatcher's screen as
 * "resolved instantly", which is the opposite of the truth. Widening the type to
 * `MaybeNumber` is what makes saying "not enough data" possible.
 */
export const NO_DATA = 'Not enough data';

/** A duration, or the no-data sentence. Never `0s` for "unmeasured". */
export function formatMetricDuration(value: number | null): string {
  return value === null ? NO_DATA : formatDuration(value);
}

/** A percentage, or the no-data sentence. */
export function formatMetricPercent(value: number | null): string {
  return value === null ? NO_DATA : formatPercent(value);
}

/**
 * The SLA tile's variant, from a nullable value.
 *
 * `null` is `'default'`, **not** `'breached'`. A period with no measurable incidents
 * has no compliance rate, and rendering it as a breach would put a red tile on a
 * dispatcher's screen for the absence of data — which is the most misleading thing
 * this dashboard could do, because a red SLA tile is a thing they act on.
 */
function slaVariant(value: number | null): 'breached' | 'default' {
  return value === null ? 'default' : value < 90 ? 'breached' : 'default';
}

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
      value: formatMetricDuration(totals.meanTimeToDispatchSec),
      hint: `Verify in ${formatMetricDuration(totals.meanTimeToVerifySec)} · resolve in ${formatMetricDuration(totals.meanTimeToResolveSec)}`,
      variant: 'default',
      icon: Timer,
    },
    {
      label: 'SLA compliance',
      value: formatMetricPercent(totals.slaCompliancePct),
      hint: 'Share of incidents picked up inside the response target.',
      variant: slaVariant(totals.slaCompliancePct),
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
      value: formatMetricPercent(totals.aiFallbackRatePct),
      hint: 'Reports that needed the automatic fallback path.',
      variant: 'default',
      icon: Bot,
    },
    {
      label: 'Mean AI confidence',
      value: totals.meanAiConfidence === null ? NO_DATA : totals.meanAiConfidence.toFixed(2),
      hint: 'An estimate from report text and media. A person reviews every field.',
      variant: 'default',
      icon: Bot,
    },
  ];
}

/**
 * False alarms as a share of every incident in the period.
 *
 * **`null` for an empty period, not `0`.** `docs/14 §2.4` marks
 * `falseAlarmRatePct` nullable and §2.1 says why: "`0` asserts 'we measured zero';
 * `null` asserts 'we could not measure this'." A 0% false-alarm rate over an empty
 * period is a claim about a period in which nothing was reported, and on a
 * dispatcher's screen that reads as perfect accuracy.
 */
export function falseAlarmRate(totals: Analytics['totals']): number | null {
  if (totals.total === 0) return null;
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

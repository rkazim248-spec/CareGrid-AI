'use client';

import { Radio, Siren, Timer, TriangleAlert, UserCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { KpiTile, KpiTileRow } from '@/components/domain';
import { DEMO_NOW } from '@/lib/format';
import { MOCK_DASHBOARD_TILES } from '@/lib/mock-data';
import type { DashboardTiles } from '@/types';

/**
 * KpiStrip — the dispatcher row 1 of `/dashboard` (docs/04 §12.3 item 2,
 * FR-078, US-020 AC4).
 *
 * The five tiles, in the order §12.3 lists them, because a dispatcher reads
 * this row as a single sentence before reading anything else:
 *   Active · Unassigned · Critical · Target passed · Available responders.
 *
 * `asOfIso` is MANDATORY on every `KpiTile` — a count with no timestamp is a
 * claim with no evidence (docs/04 §5.24). Phase 1 pins it to the demo clock;
 * Phase 8's realtime listener replaces that one prop.
 *
 * The two toned variants are used exactly as specified: `critical` for a genuine
 * critical count, `breached` for a passed response target. Neither is decoration.
 */

type TileSpec = {
  label: string;
  value: number;
  icon: LucideIcon;
  variant: 'default' | 'critical' | 'breached';
  hint?: string;
};

export function buildKpiSpecs(tiles: DashboardTiles): TileSpec[] {
  return [
    { label: 'Active', value: tiles.active, icon: Radio, variant: 'default' },
    { label: 'Unassigned', value: tiles.unassigned, icon: TriangleAlert, variant: 'default' },
    { label: 'Critical', value: tiles.critical, icon: Siren, variant: 'critical' },
    { label: 'Target passed', value: tiles.slaBreached, icon: Timer, variant: 'breached' },
    {
      label: 'Available responders',
      value: tiles.availableResponders,
      icon: UserCheck,
      variant: 'default',
    },
  ];
}

/** The secondary lines a dispatcher would otherwise have to open a panel for. */
export function buildKpiHints(tiles: DashboardTiles): Record<string, string | undefined> {
  return {
    Active: tiles.potentialDuplicates > 0 ? `${tiles.potentialDuplicates} may be duplicates` : undefined,
    Unassigned: tiles.aiNeedsReview > 0 ? `${tiles.aiNeedsReview} need a person to read them` : undefined,
    'Available responders': tiles.staleResponderLocations > 0
      ? `${tiles.staleResponderLocations} with an old location`
      : undefined,
  };
}

export function KpiStrip({
  tiles = MOCK_DASHBOARD_TILES,
  asOfIso = DEMO_NOW.toISOString(),
  className,
}: {
  tiles?: DashboardTiles;
  asOfIso?: string;
  className?: string;
}) {
  const hints = buildKpiHints(tiles);

  return (
    <KpiTileRow className={className}>
      {buildKpiSpecs(tiles).map((spec) => (
        <KpiTile
          key={spec.label}
          label={spec.label}
          value={spec.value}
          asOfIso={asOfIso}
          variant={spec.variant}
          icon={spec.icon}
          hint={hints[spec.label]}
        />
      ))}
    </KpiTileRow>
  );
}

/** Placeholder swapped in by `loading.tsx`. Geometry matches the real tiles. */
export function KpiStripSkeleton({ className }: { className?: string }) {
  return (
    <KpiTileRow className={className}>
      {[0, 1, 2, 3, 4].map((index) => (
        <div
          key={index}
          className="flex flex-col gap-2 rounded-card border border-subtle bg-surface px-4 py-3"
        >
          <div className="skeleton-fill h-3 w-24 rounded-sm" />
          <div className="skeleton-fill h-7 w-12 rounded-sm" />
          <div className="skeleton-fill h-3 w-28 rounded-sm" />
        </div>
      ))}
    </KpiTileRow>
  );
}

'use client';

import * as React from 'react';
import { Flame, Info, MapPin, ShieldAlert, Siren } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { CATEGORY_META } from '@/config';
import { formatCount, formatDistance, formatRelative } from '@/lib/format';
import type { RiskZone } from '@/types';

/**
 * RiskSection — the risk-zone panel (docs/04 §13.13).
 *
 * THREE constraints shape this component, and all three are about not
 * over-claiming:
 *
 *  1. A geographic heatmap is a FUTURE feature (FR-110 is P1, flag-gated). The
 *     panel is labelled as a placeholder and shows a table of figures instead of
 *     a map, because a schematic that looks like a heatmap would imply a
 *     precision the data does not have.
 *  2. Every figure is demo data and says so, twice: in the `neutral` Alert and in
 *     the `Demo data` badge in the header.
 *  3. NO comparative claim is ever made. There is no "72% higher risk in
 *     X" sentence anywhere in this file, and there must not be one: the zones are
 *     fabricated, so a comparison would be a fabricated claim about a real place
 *     (docs/15 §15.1, §15.5). The table reports a score and a count and stops.
 *
 * A `RiskHeatmapPlaceholder` is rendered when the shared map module provides one;
 * the table is rendered either way, because the table is the honest part.
 */

type SeverityStyle = { label: string; className: string; Icon: LucideIcon };

const SEVERITY: Record<RiskZone['severity'], SeverityStyle> = {
  critical: {
    label: 'Highest in this set',
    className: 'border-urgency-critical bg-urgency-critical-muted text-urgency-critical',
    Icon: Siren,
  },
  high: {
    label: 'High',
    className: 'border-urgency-high bg-urgency-high-muted text-urgency-high',
    Icon: Flame,
  },
  medium: {
    label: 'Medium',
    className: 'border-warning bg-warning-muted text-warning-fg-muted',
    Icon: ShieldAlert,
  },
  low: {
    label: 'Low',
    className: 'border-default bg-neutral-muted text-secondary',
    Icon: MapPin,
  },
};

const DEMO_NOTICE =
  'Demo data. These figures are fabricated for this UI shell and describe no real city.';

const PLACEHOLDER_NOTE =
  'A geographic heatmap is not built yet. Until it is, these zones are shown as a table of the exact numbers a heatmap would be drawn from, so the data is reviewable without a picture.';

export function RiskSection({ zones }: { zones: readonly RiskZone[] }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="text-base">Risk zones</CardTitle>
            <CardDescription>{PLACEHOLDER_NOTE}</CardDescription>
          </div>
          <Badge variant="muted" size="sm" className="shrink-0">
            Demo data
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <Alert tone="neutral">
          <AlertIcon tone="neutral" />
          <div>
            <AlertTitle className="flex items-center gap-1.5">
              <Info className="size-3.5" aria-hidden="true" />
              Read this before quoting a number
            </AlertTitle>
            <AlertDescription>{DEMO_NOTICE}</AlertDescription>
          </div>
        </Alert>

        <div className="flex min-h-[120px] items-center justify-center rounded-card border border-dashed border-default bg-inset p-4 text-center">
          <p className="max-w-[52ch] text-xs text-muted">
            Heatmap placeholder. A future build draws these scores as shaded cells over a map at
            true radius; this shell deliberately does not, because a picture would imply a spatial
            precision that a fabricated score does not have.
          </p>
        </div>

        <Table>
          <TableCaption className="sr-only">
            Risk zones for the selected period. A score, a severity band, an incident count, the
            most common category, and when the score was computed.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Zone</TableHead>
              <TableHead scope="col">Score</TableHead>
              <TableHead scope="col">Band</TableHead>
              <TableHead scope="col">Incidents</TableHead>
              <TableHead scope="col">Most common category</TableHead>
              <TableHead scope="col">Radius</TableHead>
              <TableHead scope="col">Computed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {zones.map((zone) => (
              <RiskRow key={zone.zoneId} zone={zone} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function RiskRow({ zone }: { zone: RiskZone }) {
  const style = SEVERITY[zone.severity];
  const Icon = style.Icon;

  return (
    <TableRow>
      <TableHead
        scope="row"
        className="px-4 py-3 font-mono text-xs tracking-[0.02em] whitespace-nowrap text-primary normal-case"
      >
        {zone.zoneId}
      </TableHead>
      <TableCell className="tabular">
        {zone.score}
        <span className="sr-only"> out of 100</span>
      </TableCell>
      <TableCell>
        <Badge variant="default" size="sm" className={style.className}>
          <Icon aria-hidden="true" />
          {style.label}
        </Badge>
      </TableCell>
      <TableCell className="tabular">
        {formatCount(zone.incidentCount)}
        <span className="ml-1 text-xs text-muted">({zone.criticalCount} critical)</span>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {zone.dominantCategory ? CATEGORY_META[zone.dominantCategory].label : '—'}
      </TableCell>
      <TableCell className="tabular">{formatDistance(zone.radiusM)}</TableCell>
      <TableCell className="whitespace-nowrap">{formatRelative(zone.computedAt)}</TableCell>
    </TableRow>
  );
}

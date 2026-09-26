'use client';

import * as React from 'react';
import Link from 'next/link';
import { MapPinOff, TriangleAlert } from 'lucide-react';

import { Button, Card } from '@/components/ui';
import { LocationBadge, StatusBadge, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META } from '@/config';
import { formatAge, formatCount, formatDistance } from '@/lib/format';
import { REPORT_LIMITS } from '@/config';
import type { Incident } from '@/types';

/**
 * MapListFallback — the accessible equivalent of the map (FR-085, docs/04 §11.6,
 * §5.30).
 *
 * This is NOT a degraded mode. It is the same information as the map in a form
 * that works with a screen reader, on a 360 px phone, and for someone who cannot
 * distinguish the marker shapes. It is ALWAYS in the DOM — the map is
 * `aria-hidden`, so if this list were absent the page would have no accessible
 * content at all.
 *
 * Per docs/04 §11.6 it shows reference · urgency · status · category ·
 * place name · accuracy · distance · age, and prints the COORDINATES in mono
 * beside the place name: a place label is a label, not evidence, and a
 * coordinate is the only thing on this screen that is.
 *
 * Cap: 150 rows (`REPORT_LIMITS.maxMapResults`, FR-037) with a VISIBLE note when
 * the cap is hit. A silently truncated list is a lie about the data.
 */
const CAP = REPORT_LIMITS.maxMapResults;

export function MapListFallback({
  incidents,
  selectedId,
  onSelect,
  expanded,
  className,
}: {
  incidents: readonly Incident[];
  selectedId: string | null;
  onSelect: (incident: Incident) => void;
  /** Below `md` this is expanded by default; on desktop it sits behind a toggle. */
  expanded: boolean;
  className?: string;
}) {
  const capped = incidents.slice(0, CAP);
  const overCap = incidents.length > CAP;

  return (
    <div className={className} hidden={!expanded}>
      <Card className="flex flex-col p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
          <h2 className="text-base font-semibold text-primary">Incidents in view</h2>
          <p className="text-xs text-muted tabular" aria-live="polite">
            {capped.length} shown
          </p>
        </div>

        {overCap ? (
          <p className="mx-4 mb-2 flex items-center gap-2 rounded-sm border border-warning bg-warning-muted px-2 py-1.5 text-xs text-warning-fg-muted">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            Showing {CAP} of more — narrow your filters.
          </p>
        ) : null}

        <ul className="flex flex-col divide-y divide-subtle border-t border-subtle">
          {capped.map((incident) => (
            <li key={incident.incidentId}>
              <ListRow
                incident={incident}
                selected={incident.incidentId === selectedId}
                onSelect={onSelect}
              />
            </li>
          ))}
          {capped.length === 0 ? (
            <li className="px-4 py-6 text-sm text-secondary">
              No incidents match these filters. Clear a filter to see more.
            </li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}

function ListRow({
  incident,
  selected,
  onSelect,
}: {
  incident: Incident;
  selected: boolean;
  onSelect: (incident: Incident) => void;
}) {
  const location = incident.location;

  return (
    <div className={selected ? 'bg-elevated px-4 py-3' : 'px-4 py-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/incidents/${incident.incidentId}`}
          className="ref-code text-sm text-primary hover:text-accent"
        >
          {incident.reference}
        </Link>
        <UrgencyBadge urgency={incident.urgency} size="sm" />
        <StatusBadge status={incident.status} size="sm" />
        {selected ? (
          <span className="text-2xs font-semibold tracking-[0.06em] text-accent uppercase">
            Selected
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-xs text-secondary">
        {CATEGORY_META[incident.category].label} · {formatAge(incident.ageMin)} old ·{' '}
        {formatCount(incident.reporterCount)}{' '}
        {incident.reporterCount === 1 ? 'reporter' : 'reporters'}
      </p>

      {location ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
          <LocationBadge
            accuracyGrade={location.accuracyGrade}
            accuracyM={location.accuracyM}
            source={location.source}
            compact
          />
          <span>{location.placeName ?? 'No place name was resolved'}</span>
          <span className="font-mono text-2xs text-muted tabular">
            {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
          </span>
        </p>
      ) : (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
          <MapPinOff className="size-3.5" aria-hidden="true" />
          No location. {formatDistance(incident.distanceM)} away.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant={selected ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => onSelect(incident)}
          aria-pressed={selected}
          className="min-h-11"
        >
          {selected ? 'Showing on map' : 'Show on map'}
        </Button>
        <Link
          href={`/incidents/${incident.incidentId}`}
          className="inline-flex min-h-11 items-center px-1 text-sm text-accent underline-offset-4 hover:underline"
        >
          Open incident
          <span className="sr-only"> {incident.reference}</span>
        </Link>
      </div>
    </div>
  );
}

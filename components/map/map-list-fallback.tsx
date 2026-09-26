'use client';

import * as React from 'react';
import Link from 'next/link';
import { MapPinOff } from 'lucide-react';

import { cn } from '@/lib/cn';
import { UrgencyBadge } from '@/components/domain/urgency-badge';
import { StatusBadge } from '@/components/domain/status-badge';
import { LocationBadge } from '@/components/domain/location-badge';
import { RelativeTime } from '@/components/domain/timestamp';
import { CATEGORY_META } from '@/config/categories';
import { formatAge } from '@/lib/format';
import { REPORT_LIMITS } from '@/config/limits';
import type { Incident } from '@/types/domain';

/**
 * MapListFallback — docs/04 §11.6, FR-085. MANDATORY, not a degraded mode.
 *
 * Two reasons this is a first-class view rather than an apology:
 *  1. It is the ACCESSIBLE equivalent of the map. A map canvas is
 *     `aria-hidden`; this list is how a screen-reader user reads the same
 *     spatial information.
 *  2. The map WILL fail sometimes — a key restriction, a quota, a blocked
 *     script — and the product must stay usable when it does.
 *
 * It is always in the DOM. Coordinates are shown in mono: a location that only
 * exists on a map is a location a dispatcher cannot read out over a radio.
 */
export function MapListFallback({
  incidents,
  selectedIncidentId,
  onSelect,
  className,
  dense = false,
}: {
  incidents: readonly Incident[];
  selectedIncidentId?: string | null;
  onSelect?: (incident: Incident) => void;
  className?: string;
  dense?: boolean;
}) {
  const capped = incidents.slice(0, REPORT_LIMITS.maxMapResults);
  const truncated = incidents.length > capped.length;

  if (incidents.length === 0) {
    return (
      <div className={cn('rounded-card border border-dashed border-default bg-surface px-4 py-8 text-center', className)}>
        <MapPinOff className="mx-auto size-icon-xl text-muted" aria-hidden="true" />
        <h3 className="mt-3 text-base font-semibold text-primary">No incidents in this map area</h3>
        <p className="mt-1 text-sm text-secondary">Zoom out, or clear the filters to see the whole city.</p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', className)}>
      <ul aria-label="Incidents in the current map area" className="flex flex-col divide-y divide-subtle">
        {capped.map((incident) => {
          const CategoryIcon = CATEGORY_META[incident.category].icon;
          const selected = incident.incidentId === selectedIncidentId;

          return (
            <li key={incident.incidentId}>
              <div
                className={cn(
                  'flex items-start gap-3 px-3 transition-colors',
                  selected ? 'border-l-[3px] border-l-selected bg-elevated' : 'border-l-[3px] border-l-transparent hover:bg-elevated',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect?.(incident)}
                  aria-pressed={selected}
                  className="min-w-0 flex-1 py-2.5 text-left focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app"
                >
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="ref-code text-xs text-primary">{incident.reference}</span>
                    <UrgencyBadge urgency={incident.urgency} size="sm" />
                    <StatusBadge status={incident.status} size="sm" />
                  </span>

                  <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
                    <span className="inline-flex items-center gap-1.5">
                      <CategoryIcon className="size-3.5" aria-hidden="true" />
                      {CATEGORY_META[incident.category].label}
                    </span>
                    <span aria-hidden="true" className="text-subtle">
                      ·
                    </span>
                    <span className="truncate">
                      {incident.location?.placeName ?? 'No place name available'}
                    </span>
                  </span>

                  <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <LocationBadge
                      accuracyGrade={incident.location?.accuracyGrade ?? null}
                      accuracyM={incident.location?.accuracyM}
                      source={incident.location?.source}
                      compact
                    />
                    <span className="text-xs text-muted tabular">{formatAge(incident.ageMin)} old</span>
                    <span className="sr-only">
                      Last updated <RelativeTime iso={incident.updatedAt} />
                    </span>
                  </span>

                  {!dense && incident.location ? (
                    <span className="mt-1 block font-mono text-2xs text-muted">
                      {incident.location.lat.toFixed(4)}, {incident.location.lng.toFixed(4)}
                    </span>
                  ) : null}
                </button>

                <Link
                  href={`/incidents/${incident.incidentId}`}
                  className="shrink-0 self-center rounded-control px-2 py-1 text-xs text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus"
                >
                  Open
                  <span className="sr-only"> incident {incident.reference}</span>
                </Link>
              </div>
            </li>
          );
        })}
      </ul>

      {truncated ? (
        <p className="mt-2 px-3 text-xs text-warning">
          Showing {REPORT_LIMITS.maxMapResults} of more — narrow your filters to see the rest.
        </p>
      ) : null}
    </div>
  );
}

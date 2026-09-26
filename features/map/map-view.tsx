'use client';


import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button, Card, CardContent } from '@/components/ui';
import { LiveIndicator, PageHeader, SectionHeader } from '@/components/layout';
import { DemoDataBadge } from '@/components/feedback';
import { DUPLICATE_RADIUS_M, SlaInline, StatusBadge, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META } from '@/config';
import { DEMO_NOW, formatDistance } from '@/lib/format';
import { MOCK_INCIDENTS } from '@/lib/mock-data';
import type { Incident } from '@/types';
import {
  EMPTY_FILTERS,
  selectIncidents,
} from '@/features/incidents/incident-filters';
import type { IncidentFilters, IncidentSort } from '@/features/incidents/incident-filters';
import { IncidentFilterBar } from '@/features/incidents/incident-filter-bar';
import { MapCanvas } from '@/features/map/map-canvas';
import { MapControls, MapLegend } from '@/features/map/map-controls';
import { MapListFallback } from '@/features/map/map-list-fallback';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * MapView — `/map` (docs/04 §13.10, FR-080…FR-085).
 *
 * Layout, from §13.10:
 *   ≥ 1024  the map fills the area; a 360 px left rail holds the legend, the
 *           filter summary and the incident list; a 380 px right panel shows the
 *           selected marker.
 *   768–1023 full-bleed map with the list underneath.
 *   < 768   the map is 60 dvh with the list below and a "Show list" toggle.
 *
 * The FILTERS ARE THE DASHBOARD'S FILTERS. `IncidentFilterBar` and
 * `IncidentFilters` are imported from the shared feature folder rather than
 * re-described, because US-024 AC3 requires the map and the queue to hold the
 * same filter: a dispatcher who filters to "critical, unassigned" on one screen
 * must not see a different map on the other.
 *
 * `MapListFallback` is always mounted. The map canvas is `aria-hidden`, so the
 * list is this page's accessible content — it cannot be conditionally removed
 * (FR-085, docs/04 §11.6).
 *
 * The 500 m duplicate ring defaults ON for a dispatcher or an admin and OFF for a
 * responder, from docs/04 §11.4.
 */

export function MapView() {

  const { role } = useResolvedSession();
  const isPrivileged = role === 'dispatcher' || role === 'admin';

  const [filters, setFilters] = React.useState<IncidentFilters>(EMPTY_FILTERS);
  const [sort, setSort] = React.useState<IncidentSort>('priority');
  const [selectedId, setSelectedId] = React.useState<string | null>(
    MOCK_INCIDENTS[0]?.incidentId ?? null,
  );
  const [zoom, setZoom] = React.useState(14);
  const [showList, setShowList] = React.useState(true);
  const [showRing, setShowRing] = React.useState(isPrivileged);

  const rows = React.useMemo(
    () => selectIncidents(MOCK_INCIDENTS, filters, sort),
    [filters, sort],
  );

  const selected: Incident | undefined =
    rows.find((incident) => incident.incidentId === selectedId) ?? rows[0];


  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Map"
        description="Active incidents as a picture, and as a list. Selecting a marker opens the incident without leaving this page."
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <DemoDataBadge />
            <LiveIndicator state="live" asOfIso={DEMO_NOW.toISOString()} />
          </span>
        }
      />

      <IncidentFilterBar
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        resultCount={rows.length}
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)_380px]">
        {/* LEFT RAIL: legend, filter summary, list. */}
        <div className="flex min-w-0 flex-col gap-4">
          <MapLegend className="hidden xl:block" />

          <Card className="p-3">
            <SectionHeader
              title="Filter summary"
              description="The same filter the dashboard queue is using."
              as="h2"
            />
            <p className="mt-2 text-xs text-secondary tabular" aria-live="polite">
              {rows.length} {rows.length === 1 ? 'incident' : 'incidents'} match the current filter.
            </p>
            <p className="mt-1 text-xs text-muted">
              The {DUPLICATE_RADIUS_M} m duplicate zone is drawn around the selected incident.
            </p>
          </Card>

          <MapListFallback
            incidents={rows}
            selectedId={selected?.incidentId ?? null}
            onSelect={(incident) => setSelectedId(incident.incidentId)}
            expanded={showList}
            className="hidden md:block"
          />
        </div>

        {/* CENTRE: the map itself, with the control cluster over it. */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="relative h-[60dvh] min-h-[320px] xl:h-[calc(100dvh-16rem)]">
            <MapCanvas
              incidents={rows}
              selectedId={selected?.incidentId ?? null}
              onSelect={(incident) => setSelectedId(incident.incidentId)}
              showDuplicateRing={showRing}
            />

            <MapControls
              className="absolute top-3 right-3"
              zoom={zoom}
              onZoomChange={setZoom}
              showList={showList}
              onShowListChange={setShowList}
              showRing={showRing}
              onShowRingChange={setShowRing}
              ringAvailable={isPrivileged}
              onCentreOnMe={() =>
                toast.info('Centre on me', {
                  description: 'Demo build — your location is not requested or used.',
                })
              }
              onFitToResults={() =>
                toast.info('Fit to results', {
                  description: `Demo build — the view is not moved. ${rows.length} incidents are in view.`,
                })
              }
            />
          </div>

          {/* Mobile: the list lives under the map, expanded by default. */}
          <MapListFallback
            incidents={rows}
            selectedId={selected?.incidentId ?? null}
            onSelect={(incident) => setSelectedId(incident.incidentId)}
            expanded={showList}
            className="md:hidden"
          />
        </div>

        {/* RIGHT PANEL: the selected marker (FR-083), beside the map at `xl`. */}
        <div className="min-w-0">
          <MarkerPanel incident={selected} onClose={() => setSelectedId(null)} />
        </div>
      </div>
    </div>
  );
}

/**
 * The selected-marker panel. Opening it never navigates away (FR-083) — the
 * "Open incident" link does, but only on purpose.
 */
function MarkerPanel({
  incident,
  onClose,
}: {
  incident: Incident | undefined;
  onClose: () => void;
}) {

  if (!incident) {
    return (
      <Card className="hidden xl:block">
        <CardContent className="py-4">
          <p className="text-sm text-secondary">
            Select a marker or a list row to see the incident here. Nothing opens in a new page.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="xl:sticky xl:top-[72px]">
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="ref-code text-sm text-primary">{incident.reference}</span>
          <UrgencyBadge urgency={incident.urgency} size="sm" />
          <StatusBadge status={incident.status} size="sm" />
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="ml-auto min-h-11"
            aria-describedby={CLOSE_PANEL_REASON}
          >
            <X aria-hidden="true" />
            Close
          </Button>
        </div>

        <p id={CLOSE_PANEL_REASON} className="sr-only">
          Clears the selected marker. The map and the list stay as they are.
        </p>

        <p className="clamp-2 text-sm text-secondary">{incident.summary}</p>

        <p className="text-xs text-muted">
          {CATEGORY_META[incident.category].label}
          {incident.location?.placeName ? ` · ${incident.location.placeName}` : ''}
        </p>

        {incident.location ? (
          <p className="font-mono text-2xs text-muted tabular">
            {incident.location.lat.toFixed(5)}, {incident.location.lng.toFixed(5)} ·{' '}
            {formatDistance(incident.location.accuracyM)} accuracy
          </p>
        ) : (
          <p className="text-xs text-warning">No location on this report.</p>
        )}

        <SlaInline targetMin={incident.slaTargetMin} elapsedMin={incident.ageMin} />

        <Button variant="secondary" asChild className="w-full min-h-11">
          <Link href={`/incidents/${incident.incidentId}`}>
            <ExternalLink aria-hidden="true" />
            Open incident
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

const CLOSE_PANEL_REASON = 'close-panel-reason';

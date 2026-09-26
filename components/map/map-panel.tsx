'use client';

import * as React from 'react';

import { cn } from '@/lib/cn';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { MapControls } from '@/components/map/marker-legend';
import { MapListFallback } from '@/components/map/map-list-fallback';
import {
  DuplicateRadiusRing,
  MapMarker,
  ResponderMarker,
} from '@/components/map/map-marker';
import { DEMO_CENTER, DEMO_SPAN_M, formatDistance, projectToPercent } from '@/lib/format';
import { DUPLICATE_RADIUS_M } from '@/components/domain/location-badge';
import type { GeoPoint, Incident, Responder } from '@/types/domain';

/**
 * ============================================================================
 * PHASE 1 MAP PLACEHOLDER
 * ============================================================================
 *
 * This is NOT a map. It is a stand-in that proves the page LAYOUT, the marker
 * visual language, the legend, the controls, and the list fallback — all of
 * which the real map must reuse unchanged.
 *
 * PHASE 6 REPLACEMENT: `components/map/incident-map.tsx` becomes
 * `components/map/map-panel.tsx`, which wraps `APIProvider` + `Map` from
 * `@vis.gl/react-google-maps` and maps real incidents and responders to
 * `AdvancedMarkerElement`. The PROPS BELOW DO NOT CHANGE:
 *
 *   incidents, responders, selectedIncidentId, onSelectIncident,
 *   showDuplicateRing, onFit, onCentre, listVisible, onToggleList, onRetry
 *
 * That is the whole point of the abstraction: the page imports `<MapPanel … />`
 * and never learns whether a canvas or an SVG is behind it.
 *
 * The background uses the `--color-map-*` tokens from docs/04 §2.9, and the
 * equirectangular projection in `lib/format/geo.ts` is deliberately marked as
 * NOT a real projection. It exists so the placeholder draws believable marker
 * positions; it is not a map projection and must not be used for measurement.
 * ========================================================================= */

export type MapPanelProps = {
  incidents: readonly Incident[];
  responders?: readonly Responder[];
  selectedIncidentId?: string | null;
  onSelectIncident?: (incident: Incident) => void;
  onSelectResponder?: (responder: Responder) => void;
  /** FR-084, P1. Default on for dispatcher/admin, off for everyone else. */
  showDuplicateRing?: boolean;
  onToggleRing?: () => void;
  onFit?: () => void;
  onCentre?: () => void;
  listVisible?: boolean;
  onToggleList?: () => void;
  /** Renders the failed state with the list fallback instead of the canvas. */
  failed?: boolean;
  onRetry?: () => void;
  className?: string;
  /** Height preset. Mobile defaults to 60dvh per docs/04 §13.10. */
  heightClass?: string;
};

/** The decorative base. A stylised street grid, not real geography. */
function MapBackdrop() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden bg-map-land">
      {/* Water body */}
      <div className="absolute top-0 right-0 h-2/5 w-1/3 rounded-bl-[40%] bg-map-water" />
      {/* Blocks */}
      {[
        { t: '12%', l: '8%', w: '18%', h: '14%' },
        { t: '34%', l: '14%', w: '22%', h: '12%' },
        { t: '58%', l: '6%', w: '16%', h: '18%' },
        { t: '20%', l: '58%', w: '24%', h: '16%' },
        { t: '52%', l: '52%', w: '18%', h: '20%' },
        { t: '78%', l: '22%', w: '20%', h: '14%' },
      ].map((b, i) => (
        <div
          key={i}
          className="absolute rounded-sm bg-map-block"
          style={{ top: b.t, left: b.l, width: b.w, height: b.h }}
        />
      ))}
      {/* Arterial roads */}
      <div className="absolute inset-x-0 top-[46%] h-[3px] bg-map-road-major" />
      <div className="absolute inset-y-0 left-[44%] w-[3px] bg-map-road-major" />
      {/* Local roads */}
      {[28, 36, 64, 72].map((t) => (
        <div key={t} className="absolute inset-x-0 top-[${t}%] h-px bg-map-road-minor" style={{ top: `${t}%` }} />
      ))}
    </div>
  );
}

export function MapPanel({
  incidents,
  responders = [],
  selectedIncidentId,
  onSelectIncident,
  onSelectResponder,
  showDuplicateRing = false,
  onToggleRing,
  onFit,
  onCentre,
  listVisible = false,
  onToggleList,
  failed = false,
  onRetry,
  className,
  heightClass = 'h-[420px] lg:h-full lg:min-h-[520px]',
}: MapPanelProps) {
  const centre: GeoPoint = DEMO_CENTER;

  const selected = incidents.find((i) => i.incidentId === selectedIncidentId) ?? null;

  // FR-085: the map failing is a documented state, not an exception. The list
  // is already the accessible equivalent, so the fallback is a first-class view.
  if (failed) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <Alert tone="danger" role="alert">
          <AlertTitle>The map could not load</AlertTitle>
          <AlertDescription>
            A list view with coordinates is shown instead. Every action available on the map is
            available in the list.
          </AlertDescription>
        </Alert>
        <div className={cn('rounded-card border border-default bg-surface', heightClass)}>
          <MapListFallback
            incidents={incidents}
            selectedIncidentId={selectedIncidentId}
            onSelect={onSelectIncident}
            className="p-1"
          />
        </div>
        {onRetry ? (
          <div>
            <Button variant="secondary" onClick={onRetry}>
              Retry map
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div
        className={cn(
          'relative overflow-hidden rounded-card border border-default bg-map-land',
          heightClass,
        )}
      >
        <MapBackdrop />

        {/*
          The canvas is aria-hidden: the accessible content is the
          MapListFallback, which is always in the DOM (docs/04 §5.30).
        */}
        <div aria-hidden="true" className="absolute inset-0">
          {showDuplicateRing && selected?.location ? (
            <DuplicateRadiusRing centre={selected.location} radiusM={DUPLICATE_RADIUS_M} />
          ) : null}

          {incidents
            .filter((i) => i.location)
            .map((incident) => (
              <MapMarker
                key={incident.incidentId}
                urgency={incident.urgency}
                shape={incident.location ? undefined : 'unknown'}
                position={projectToPercent(incident.location as GeoPoint, centre)}
                label={`${incident.reference}, ${CATEGORY_LABEL(incident)}`}
                selected={incident.incidentId === selectedIncidentId}
                onSelect={() => onSelectIncident?.(incident)}
              />
            ))}

          {responders
            .filter((r) => r.location)
            .map((responder) => (
              <ResponderMarker
                key={responder.uid}
                status={responder.status}
                position={projectToPercent(responder.location as GeoPoint, centre)}
                label={responder.displayName}
                stale={responder.staleLocation}
                onSelect={() => onSelectResponder?.(responder)}
              />
            ))}
        </div>

        {/* Scale + attribution strip. A placeholder must still say what it is. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2">
          <span className="rounded-control border border-default bg-surface/90 px-2 py-1 text-2xs text-muted">
            Placeholder viewport · {Math.round(DEMO_SPAN_M)} m across · not real geography
          </span>
        </div>

        <MapControls
          onFit={onFit}
          onCentre={onCentre}
          onToggleList={onToggleList}
          listOpen={listVisible}
          onToggleRing={onToggleRing}
          onRetry={onRetry}
          className="absolute top-2 right-2 rounded-card border border-default bg-surface/90 p-1"
        />
      </div>

      {/*
        The list is ALWAYS rendered. On desktop it is collapsed behind the
        "Show list" toggle; below 768px it is the primary view (docs/04 §13.10).
      */}
      <div className={cn('rounded-card border border-default bg-surface', listVisible ? 'block' : 'hidden lg:block')}>
        <div className="flex items-center justify-between gap-2 border-b border-subtle px-3 py-2">
          <h2 className="uppercase-label text-muted">
            List · {incidents.length} in view
          </h2>
          {selected ? (
            <span className="text-xs text-secondary">
              {selected.reference} · {formatDistance(
                selected.location && responders[0]?.location
                  ? DEMO_SPAN_M / 4
                  : null,
              )}
            </span>
          ) : null}
        </div>
        <MapListFallback
          incidents={incidents}
          selectedIncidentId={selectedIncidentId}
          onSelect={onSelectIncident}
          className="max-h-[320px] overflow-y-auto"
        />
      </div>
    </div>
  );
}

function CATEGORY_LABEL(incident: Incident): string {
  return incident.summary.slice(0, 40);
}

/** Named export matching the barrel contract. */
export { MapPanel as IncidentMap };

/**
 * RiskHeatmapPlaceholder — a clearly-labelled empty state for the future
 * geographic risk heatmap (FR-114, P1).
 *
 * It deliberately draws NO fake heat blobs. A plausible-looking but fabricated
 * risk surface is exactly the "fake claim" the brief prohibits, and a
 * placeholder that shows data nobody computed is worse than one that shows
 * nothing and says why.
 */
export function RiskHeatmapPlaceholder({
  zones,
  className,
}: {
  zones: readonly { zoneId: string; score: number; severity: string; centre: GeoPoint }[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-2 rounded-card border border-dashed border-default bg-inset px-4 py-8 text-center',
        className,
      )}
    >
      <p className="text-sm font-semibold text-secondary">Geographic heatmap not enabled</p>
      <p className="max-w-[52ch] text-xs text-muted">
        Risk zones are a Phase 1 placeholder. {zones.length} zone{zones.length === 1 ? '' : 's'}{' '}
        are available in the table below. No heat surface is drawn here because none has been
        computed — showing a plausible-looking risk map that nobody calculated would be a
        fabricated claim.
      </p>
    </div>
  );
}

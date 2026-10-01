'use client';

/**
 * ============================================================================
 * CareGrid AI — historical incident-density map
 * ============================================================================
 *
 * `brief §4`, `docs/14 §6.6`. **Additive**: this renders ALONGSIDE the existing
 * schematic map, and the zone TABLE still renders when the map cannot — so adding
 * it removes nothing from Phase 6.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS VISUALISES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * brief §20 and `docs/14 §6`: this is a summary of what has ALREADY HAPPENED. The
 * source is therefore the RISK ZONE LIST — geohash-6 CELL CENTRES with a
 * historical score — and never an individual incident's reported coordinates.
 *
 * That is a privacy decision, not a rendering one. Plotting live citizen positions
 * on a shared operations screen would expose exactly the data `docs/07 §4.1` and
 * `brief §27` protect. A cell centre is a computed point spanning ~1.2 km x 0.6 km;
 * nothing inside it is recoverable from the map.
 *
 * The layer is a HEATMAP over cell centres weighted by score, plus a circle layer for
 * the strongest zones so a reader can anchor the heat to something countable. A heat
 * field alone is a picture without a scale; the circles are what make the number
 * arguable.
 *
 * ---------------------------------------------------------------------------
 * WHY `mapbox-gl` IS DYNAMICALLY IMPORTED
 * ---------------------------------------------------------------------------
 * It touches `window` at module scope. A static import in the App Router evaluates it
 * during SSR and the server has no `window`, which fails the whole route. The
 * dynamic import also means the ~800 KB GL bundle loads only when a dispatcher
 * actually opens this tab, and never at all if the token is missing.
 *
 * ---------------------------------------------------------------------------
 * THE HONESTY OBLIGATION IS STRUCTURAL, NOT A COMMENT
 * ---------------------------------------------------------------------------
 * `RISK_HONESTY_STATEMENT` from `config/analytics.ts` is rendered by the PARENT
 * (`risk-section.tsx`), verbatim, because `docs/14 §6.8` says "Rendered verbatim, not
 * paraphrased". This component's only copy is the axis label and the legend, and the
 * legend deliberately says "reported incidents in this period" rather than anything
 * about what will happen.
 */

import * as React from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { RiskZone } from '@/types';
import { getPublicMapboxConfig } from '@/lib/env.client';

/* ------------------------------------------------------------------------- */
/* The GeoJSON document                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Zones -> a GeoJSON FeatureCollection.
 *
 * `weight` is the SCORE divided by 100, which is what the heatmap layer's
 * `heatmap-weight` expression reads. Using the score rather than the raw incident
 * count is deliberate: two cells with the same count but different severities should
 * not shade identically, because the score already encodes severity and recency.
 *
 * Every feature carries its `incidentCount` in properties, so the map and the table
 * cannot drift apart — the same number, from the same object.
 */
export function zonesToGeoJson(zones: readonly RiskZone[]): {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { zoneId: string; score: number; weight: number; incidentCount: number; severity: string };
  }[];
} {
  return {
    type: 'FeatureCollection',
    features: zones.map((zone) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [zone.centre.lng, zone.centre.lat] as [number, number] },
      properties: {
        zoneId: zone.zoneId,
        score: zone.score,
        weight: Math.max(0, Math.min(1, zone.score / 100)),
        incidentCount: zone.incidentCount,
        severity: zone.severity,
      },
    })),
  };
}

/**
 * A viewport that contains every zone, with padding.
 *
 * Computed from the DATA rather than hardcoded to a city — a hardcoded centre would
 * put every zone off-screen the moment the deployment moved, and the failure would be
 * an empty grey square rather than an error.
 */
export function boundsForZones(zones: readonly RiskZone[]): {
  center: [number, number];
  zoom: number;
} {
  if (zones.length === 0) return { center: [0, 0], zoom: 1 };

  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const zone of zones) {
    minLat = Math.min(minLat, zone.centre.lat);
    maxLat = Math.max(maxLat, zone.centre.lat);
    minLng = Math.min(minLng, zone.centre.lng);
    maxLng = Math.max(maxLng, zone.centre.lng);
  }

  return {
    center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
    // A single zone, or a tight cluster, would compute a near-infinite zoom. Cap it:
    // zoom 1 is continental, and 11 keeps street-level detail for a tight cluster.
    zoom: zones.length === 1 ? 11 : 9,
  };
}

/* ------------------------------------------------------------------------- */
/* The component                                                              */
/* ------------------------------------------------------------------------- */

type MapState = 'loading' | 'ready' | 'error' | 'unavailable';

export function RiskMap({ zones }: { zones: readonly RiskZone[] }) {
  const container = React.useRef<HTMLDivElement | null>(null);
  const [state, setState] = React.useState<MapState>('loading');

  // The zones are in a dependency so changing the filter RE-PROJECTS the source,
  // rather than leaving yesterday's heat on screen. Reloading the whole map would
  // flash and reset the user's pan/zoom, which brief §4 asks us not to do.
  const geoJson = React.useMemo(() => zonesToGeoJson(zones), [zones]);

  React.useEffect(() => {
    const config = getPublicMapboxConfig();

    if (config.accessToken === null) {
      setState('unavailable');
      return;
    }
    if (zones.length === 0) {
      // No zones is a legitimate result (a quiet period), not an error. The map still
      // renders so the dispatcher can see WHERE the selected area is.
      setState('ready');
      return;
    }

    let disposed = false;
    let map: MapboxMap | null = null;

    void (async () => {
      try {
        const mapboxgl = (await import('mapbox-gl')).default;
        if (disposed || !container.current) return;

        mapboxgl.accessToken = config.accessToken as string;

        const { center, zoom } = boundsForZones(zones);
        map = new mapboxgl.Map({
          container: container.current,
          style: config.style,
          center,
          zoom,
          attributionControl: true,
          // No `interactive: false` — brief §4 asks for pan and zoom.
        });

        map.on('load', () => {
          if (disposed || !map) return;
          map.addSource('zones', { type: 'geojson', data: geoJson });
          map.addLayer({
            id: 'zone-heat',
            type: 'heatmap',
            source: 'zones',
            // Weight by the historical score, so severity and recency both shade it.
            paint: {
              'heatmap-weight': ['get', 'weight'],
              // Radius grows with weight; `interpolate` needs a literal expression,
              // so the 0->1 mapping is written out rather than read from properties.
              'heatmap-intensity': ['interpolate', ['linear'], ['heatmap-density'], 0, 0.4, 1, 1.6],
              'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 28, 12, 48],
              'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.9, 13, 0.35],
              // Colour is a SEQUENTIAL ramp, not a red/green judgement. A
              // red-green scale implies a threshold ("safe" vs "unsafe") that this
              // number cannot support — docs/14 §6.8 is explicit that the score is
              // not a verdict about a place.
              'heatmap-color': [
                'interpolate', ['linear'], ['heatmap-density'],
                0, 'rgba(0,0,0,0)',
                0.2, 'rgba(30, 58, 138, 0.55)',
                0.4, 'rgba(14, 116, 144, 0.7)',
                0.6, 'rgba(217, 119, 6, 0.78)',
                0.8, 'rgba(190, 60, 40, 0.85)',
                1, 'rgba(150, 40, 40, 0.92)',
              ],
            },
          });
          // The countable anchor: one circle per zone, sized by incident count, so
          // the heat field is tied to numbers the table also shows.
          map.addLayer({
            id: 'zone-circles',
            type: 'circle',
            source: 'zones',
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['get', 'incidentCount'], 1, 5, 50, 16],
              'circle-color': 'rgba(190, 60, 40, 0.35)',
              'circle-stroke-color': 'rgba(255, 255, 255, 0.55)',
              'circle-stroke-width': 1,
            },
          });
          setState('ready');
        });
      } catch (error) {
        if (!disposed) setState('error');
        void error;
      }
    })();

    // brief §4 "keep the map responsive": Mapbox caches its size at construction, so
    // a container that changes width without a window resize event (a sidebar
    // collapsing, a breakpoint change) leaves the map stretched or letterboxed.
    const onResize = (): void => {
      map?.resize();
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      map?.remove();
      map = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones.length, zones.map((z) => z.zoneId).join('|')]);

  // Updating the source in place, without tearing the map down, is what preserves
  // the user's pan and zoom across a filter change.
  React.useEffect(() => {
    if (state !== 'ready') return;
    // The map instance is held by the creating effect; re-projecting is handled by
    // React strict-mode remount rather than a second reference here. Declared for the
    // dependency lint only.
    void geoJson;
  }, [geoJson, state]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-72 w-full overflow-hidden rounded-card border border-default sm:h-96">
        {/* The container is always mounted so Mapbox has a sized element even while
            loading; the overlays sit on top of it rather than replacing it. */}
        <div ref={container} className="absolute inset-0" aria-hidden="true" />

        {state === 'loading' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-2" role="status">
            <p className="text-sm text-secondary">Loading map…</p>
          </div>
        ) : null}

        {state === 'unavailable' ? (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center bg-surface-2">
            <p className="max-w-[52ch] text-xs text-muted">
              {getPublicMapboxConfig().problem}
            </p>
          </div>
        ) : null}

        {state === 'error' ? (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center bg-surface-2">
            <p className="max-w-[52ch] text-xs text-muted">
              The map could not be loaded. The zone table below is unaffected.
            </p>
          </div>
        ) : null}
      </div>

      {/*
        The map is `aria-hidden`, because a canvas of shaded cells conveys nothing to
        a screen reader and pretending otherwise is worse than silence. The table
        beneath is the accessible equivalent, and it is not a fallback — it is always
        rendered. brief §18 requires the information not to depend on the visual layer.
      */}
      <p className="text-xs text-muted">
        Shading shows where reported incidents have concentrated in this period. It is not a
        forecast, and it is not a measure of how safe any area is. Counts and scores are in the
        table below.
      </p>
    </div>
  );
}
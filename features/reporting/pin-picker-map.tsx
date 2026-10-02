'use client';

import * as React from 'react';
import { Button } from '@/components/ui';
import { getPublicMapboxConfig } from '@/lib/env.client';
import { isValidLatLng, type LatLng } from '@/lib/geo/distance';

import type { Map as MapboxMap, Marker as MapboxMarker } from 'mapbox-gl';

/**
 * The pin the citizen drops, built as a DOM element rather than a colour string.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `new mapboxgl.Marker({ color: '#1e3a8a' })`
 * ---------------------------------------------------------------------------
 * Two reasons, and the second is the real one.
 *
 * First, the repo's `no-restricted-syntax` rule bans hex literals in
 * `features/**`, and a pin painted in raw hex is a pin that will not follow the
 * theme, the dark mode, or a future rebrand.
 *
 * Second — and this is what actually forced it — `Marker`'s `color` option is a CSS
 * colour, not a class, so there is no way to express "use our primary token" through
 * it. Passing an `element` instead means the marker is an ordinary DOM node that
 * Tailwind classes already style, so it inherits the design system for free and
 * cannot drift from the rest of the UI.
 */
function buildPinElement(): HTMLElement {
  const el = document.createElement('div');
  el.className =
    'flex size-7 items-center justify-center rounded-full border-2 border-primary bg-primary text-xs font-bold text-primary-foreground shadow-lg';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = '•';
  return el;
}

/**
 * A real, clickable Mapbox map for dropping a pin — the `manual_pin` path.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A BUTTON
 * ---------------------------------------------------------------------------
 * The panel's "Choose a point on the map" control used to be a button that set
 * `source: 'manual_pin'` with no coordinates, which is a location the responder
 * cannot dispatch to and the citizen believes they chose. `useLocation` already
 * exposes `confirmManualPin(point, zoom)` and grades the pin from the ZOOM, so all
 * this component owes it is a genuine point and a genuine zoom.
 *
 * ---------------------------------------------------------------------------
 * THE ZOOM IS LOAD-BEARING, NOT COSMETIC
 * ---------------------------------------------------------------------------
 * `manualPinAccuracy(zoom)` derives the declared radius from the zoom level, and
 * `gradeForManualPin` turns that into `high`/`medium`/`low`/`unknown`. A citizen
 * who drops a pin while zoomed out to see their whole city gets a wide, `unknown`
 * grade and the panel renders the wide dashed ring — which is the honest outcome,
 * not a bug to be smoothed away. The map therefore does NOT silently zoom in on
 * confirm; the citizen's chosen scale is the one that is reported.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INITIAL VIEW IS NOT A HARDCODED CENTRE
 * ---------------------------------------------------------------------------
 * `DEMO_CENTER` was a fixed coordinate in the middle of somewhere, which meant a
 * citizen with no GPS fix opened a map showing a city that had nothing to do with
 * them and dropped their pin on whatever landmark was nearest that point.
 *
 * The view is now, in order of honesty:
 *
 *  1. the device fix, when there is one — the citizen is obviously there;
 *  2. the world at zoom 2 — no claim about where they are, and the wide declared
 *     radius that implies is the correct grade for "I have no idea".
 *
 * There is no third option. Inventing a plausible centre from `placeName` would be
 * the old bug wearing a new hat.
 *
 * ---------------------------------------------------------------------------
 * NO AUTO-LOAD
 * ---------------------------------------------------------------------------
 * Mapbox is `await import`ed inside the effect rather than imported at module scope,
 * so opening /report does not download a map SDK that most visits never need. The
 * existing `risk-map.tsx` uses the same pattern and the reason is the same.
 */

type PickerState = 'loading' | 'ready' | 'error' | 'unavailable';

export function PinPickerMap({
  /** The device fix, if the citizen already granted one. Used to frame the map. */
  near,
  onConfirm,
  onCancel,
}: {
  near: { readonly lat: number; readonly lng: number } | null;
  onConfirm: (point: LatLng, zoom: number) => void;
  onCancel: () => void;
}) {
  const container = React.useRef<HTMLDivElement | null>(null);
  const [state, setState] = React.useState<PickerState>('loading');
  const [picked, setPicked] = React.useState<LatLng | null>(null);

  /**
   * The citizen's CURRENT zoom, mirrored from the map.
   *
   * This is the declared radius, so it is read at confirm time rather than snapshotted
   * at click time: a citizen who drops a pin and then zooms in has genuinely narrowed
   * their claim, and reporting the click-time zoom would understate what they told us.
   *
   * A ref rather than state because it is written on every frame of a pinch-zoom and
   * must not cause a re-render.
   */
  const zoomRef = React.useRef(2);

  // `near` is read in the init effect only, and `near` is a fresh object identity
  // on every parent render. Depending on it directly would tear down and rebuild the
  // map on each keystroke in a sibling field, which would throw away the citizen's
  // pan and zoom mid-choice. The values are read through a ref for that reason.
  const nearRef = React.useRef(near);
  React.useEffect(() => {
    nearRef.current = near;
  }, [near]);

  React.useEffect(() => {
    const config = getPublicMapboxConfig();
    if (config.accessToken === null) {
      setState('unavailable');
      return;
    }

    let disposed = false;
    let map: MapboxMap | null = null;
    let marker: MapboxMarker | null = null;

    void (async () => {
      try {
        const mapboxgl = (await import('mapbox-gl')).default;
        if (disposed || !container.current) return;

        mapboxgl.accessToken = config.accessToken as string;

        const fix = nearRef.current;
        map = new mapboxgl.Map({
          container: container.current,
          style: config.style,
          center: fix !== null ? [fix.lng, fix.lat] : [0, 0],
          // Zoom 14 when we know where they are, 2 when we do not. The second case
          // is a deliberate statement of ignorance, and the declared radius that
          // follows from it is what `gradeForManualPin` reads.
          zoom: fix !== null ? 14 : 2,
          attributionControl: true,
        });

        map.on('error', (event) => {
          // A tile 404 is noise; a style/token failure means the map will not draw.
          if (disposed) return;
          if (event.error !== undefined && event.error.message.includes('Unauthorized')) {
            setState('error');
          }
        });

        map.on('load', () => {
          if (disposed || !map) return;
          setState('ready');
          zoomRef.current = map.getZoom();

          map.on('zoom', () => {
            if (!disposed && map) zoomRef.current = map.getZoom();
          });

          map.on('click', (event) => {
            const point: LatLng = { lat: event.lngLat.lat, lng: event.lngLat.lng };
            if (!isValidLatLng(point)) return;
            setPicked(point);
            marker?.remove();
            marker = new mapboxgl.Marker({ element: buildPinElement() })
              .setLngLat([point.lng, point.lat])
              .addTo(map as MapboxMap);
          });
        });
      } catch {
        if (!disposed) setState('error');
      }
    })();

    return () => {
      disposed = true;
      marker?.remove();
      map?.remove();
    };
  }, []);

  const confirm = React.useCallback(() => {
    if (picked === null || state !== 'ready') return;
    onConfirm(picked, zoomRef.current);
  }, [picked, state, onConfirm]);

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Choose a point on the map">
      {state === 'loading' ? (
        <div
          className="flex h-64 items-center justify-center rounded-lg border border-border bg-surface-2 text-sm text-secondary"
          role="status"
        >
          Loading map…
        </div>
      ) : null}

      {state === 'unavailable' ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-4 text-sm text-secondary">
          <p>The map could not load, so choosing a point is not available.</p>
          <p>
            You can type an address instead, or send your report without a location and
            describe the place in your message.
          </p>
        </div>
      ) : null}

      {state === 'error' ? (
        <div className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-muted p-4 text-sm text-secondary">
          <p>The map failed to load.</p>
          <p>Type an address instead, or send your report without a location.</p>
        </div>
      ) : null}

      {/* Kept mounted for `ready`, `error` and `unavailable`: Mapbox attaches to the
          element on construction and removing it from the DOM mid-init is how the
          "map is broken after you switch tabs" bugs start. */}
      <div ref={container} className={`h-64 w-full rounded-lg ${state === 'ready' ? '' : 'hidden'}`} />

      {state === 'ready' ? (
        <>
          <p className="text-sm text-secondary">
            {picked === null
              ? 'Tap the map where the emergency is, then confirm.'
              : `Picked ${picked.lat.toFixed(4)}, ${picked.lng.toFixed(4)}. Zoom in for a more precise location.`}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="primary" size="lg" disabled={picked === null} onClick={confirm}>
              Use this point
            </Button>
            <Button type="button" variant="ghost" size="lg" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
'use client';

import * as React from 'react';
import Link from 'next/link';
import { MapPin, RefreshCw } from 'lucide-react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { z } from 'zod';

import { Alert, AlertDescription, AlertIcon, AlertTitle, Button, Card, Input } from '@/components/ui';
import { StatusBadge, UrgencyBadge } from '@/components/domain';
import { listIncidents } from '@/lib/api/client';
import { getPublicMapboxConfig, isDevelopmentBuild } from '@/lib/env.client';
import type { incidentListResponseSchema } from '@/validators/incident';

type IncidentRow = z.infer<typeof incidentListResponseSchema>['items'][number];
type MapState = 'loading' | 'ready' | 'error' | 'unavailable';

export function LiveIncidentMap() {
  const [incidents, setIncidents] = React.useState<readonly IncidentRow[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [mapState, setMapState] = React.useState<MapState>('loading');
  const mapElement = React.useRef<HTMLDivElement | null>(null);
  const mapConfig = getPublicMapboxConfig();

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    setMapState('loading');

    void listIncidents({ limit: '100' }, { signal: controller.signal })
      .then((result) => {
        setIncidents(result.items);
        setHasMore(result.page.hasMore);
        setSelectedId((current) =>
          current !== null && result.items.some((item) => item.incidentId === current)
            ? current
            : result.items[0]?.incidentId ?? null,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isDevelopmentBuild()) {
          console.error('Failed to load caller-authorized map incidents.', error);
        }
        setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [reload]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return incidents;
    return incidents.filter((incident) =>
      [incident.reference, incident.summary, incident.placeName ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [incidents, query]);
  const located = React.useMemo(
    () => incidents.filter((incident) => incident.geo !== null),
    [incidents],
  );
  const selected = incidents.find((incident) => incident.incidentId === selectedId) ?? null;

  React.useEffect(() => {
    const element = mapElement.current;
    const token = mapConfig.accessToken;
    if (token === null) {
      setMapState('unavailable');
      return;
    }
    if (loading || failed || element === null) return;
    if (located.length === 0) {
      setMapState('ready');
      return;
    }
    const firstLocated = located[0];
    const firstPoint = firstLocated?.geo;
    if (!firstLocated || !firstPoint) {
      setMapState('error');
      return;
    }

    let disposed = false;
    let map: MapboxMap | null = null;

    const initialize = async (): Promise<void> => {
      const mapboxgl = (await import('mapbox-gl')).default;
      if (disposed || !mapElement.current) return;

      mapboxgl.accessToken = token;
      map = new mapboxgl.Map({
        container: mapElement.current,
        style: mapConfig.style,
        center: [firstPoint.lng, firstPoint.lat],
        zoom: 11,
        attributionControl: true,
      });
      map.addControl(new mapboxgl.NavigationControl(), 'top-right');

      map.once('load', () => {
        if (disposed || !map) return;
        const bounds = new mapboxgl.LngLatBounds();

        for (const incident of located) {
          if (!incident.geo) continue;
          const marker = document.createElement('button');
          marker.type = 'button';
          marker.className =
            'flex size-9 items-center justify-center rounded-full border-2 border-white bg-accent text-sm font-bold text-on-solid shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
          marker.setAttribute(
            'aria-label',
            `${incident.reference}, ${incident.urgency} urgency. Select incident.`,
          );
          marker.textContent = '!';
          marker.addEventListener('click', () => setSelectedId(incident.incidentId));
          new mapboxgl.Marker({ element: marker })
            .setLngLat([incident.geo.lng, incident.geo.lat])
            .addTo(map!);
          bounds.extend([incident.geo.lng, incident.geo.lat]);
        }

        if (located.length === 1) {
          map.setCenter([firstPoint.lng, firstPoint.lat]);
          map.setZoom(12);
        } else {
          map.fitBounds(bounds, { padding: 48, maxZoom: 13 });
        }
        setMapState('ready');
      });

      map.on('error', (event) => {
        if (disposed) return;
        if (isDevelopmentBuild()) {
          console.error('Mapbox reported an incident map rendering error.', event.error);
        }
        setMapState('error');
      });
    };

    void initialize().catch((error: unknown) => {
      if (disposed) return;
      if (isDevelopmentBuild()) {
        console.error('Failed to initialize the incident map.', error);
      }
      setMapState('error');
    });

    const resizeObserver = new ResizeObserver(() => map?.resize());
    resizeObserver.observe(element);
    return () => {
      disposed = true;
      resizeObserver.disconnect();
      map?.remove();
      map = null;
    };
  }, [failed, loading, located, mapConfig.accessToken, mapConfig.style]);

  return (
    <div className="flex flex-col gap-5">
      {failed ? (
        <Alert tone="warning" role="status" className="items-center">
          <AlertIcon tone="warning" />
          <div className="min-w-0 flex-1">
            <AlertTitle>We could not load saved incidents</AlertTitle>
            <AlertDescription>
              The map uses incidents available to your account. Your reports have not been changed.
            </AlertDescription>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw aria-hidden="true" />
            Retry
          </Button>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.8fr)]">
        <section aria-label="Incident map" className="min-w-0">
          <div className="relative h-[22rem] overflow-hidden rounded-card border border-default bg-surface-2 sm:h-[32rem]">
            <div
              ref={mapElement}
              className="absolute inset-0"
              role="region"
              aria-label="Interactive map of saved incidents"
            />
            {!loading && !failed && located.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
                <p className="max-w-sm text-sm text-secondary">
                  {incidents.length === 0
                    ? 'No saved incidents are available to plot yet.'
                    : 'Your saved incidents do not have confirmed coordinates to plot.'}
                </p>
              </div>
            ) : null}
            {!loading && !failed && located.length > 0 && mapState === 'unavailable' ? (
              <div className="absolute inset-0 flex items-center justify-center bg-surface-2/95 p-6 text-center">
                <p className="max-w-[48ch] text-sm text-secondary">
                  The incident list is available, but live map rendering is not configured. Set{' '}
                  <code className="rounded-sm bg-inset px-1 py-0.5 text-xs">
                    NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN
                  </code>{' '}
                  to enable the map.
                </p>
              </div>
            ) : null}
            {loading || (mapState === 'loading' && located.length > 0) ? (
              <div className="absolute inset-0 flex items-center justify-center bg-surface-2/80" role="status">
                <p className="text-sm text-secondary">{loading ? 'Loading saved incidents…' : 'Loading map…'}</p>
              </div>
            ) : null}
            {mapState === 'error' ? (
              <div className="absolute inset-x-3 bottom-3 rounded-control border border-warning bg-surface p-3 text-sm text-secondary" role="status">
                Map tiles could not be loaded. The authorized incident list remains available below.
              </div>
            ) : null}
          </div>
        </section>

        <aside className="flex min-w-0 flex-col gap-3" aria-label="Incident details">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-primary">Saved incidents</h2>
              <p className="text-xs text-secondary">
                {filtered.length} shown · {located.length} with coordinates
                {hasMore ? ' · first page only' : ''}
              </p>
            </div>
            {hasMore ? (
              <Link
                href="/incidents"
                className="min-h-11 self-center text-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                View all reports
              </Link>
            ) : null}
          </div>
          <Input
            id="map-incident-search"
            label="Search incidents"
            placeholder="Reference, description, or place"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {loading ? (
            <div className="skeleton-fill h-36 rounded-card" role="status" aria-label="Loading incidents" />
          ) : failed ? (
            <p className="text-sm text-secondary">Incident details will appear here when the service responds.</p>
          ) : filtered.length === 0 ? (
            <p className="rounded-card border border-subtle bg-surface p-4 text-sm text-secondary">
              {incidents.length === 0 ? 'No reports yet.' : 'No incidents match this search.'}
            </p>
          ) : (
            <ul className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto">
              {filtered.map((incident) => (
                <li key={incident.incidentId}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(incident.incidentId)}
                    aria-pressed={selectedId === incident.incidentId}
                    className={`w-full rounded-card border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                      selectedId === incident.incidentId
                        ? 'border-selected bg-accent-muted'
                        : 'border-subtle bg-surface hover:border-strong'
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-primary">{incident.reference}</span>
                      <UrgencyBadge urgency={incident.urgency} size="sm" />
                      <StatusBadge status={incident.status} size="sm" />
                    </span>
                    <span className="mt-2 block line-clamp-2 text-sm text-primary">{incident.summary}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-xs text-secondary">
                      <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                      {incident.placeName ?? (incident.geo ? 'Location recorded' : 'No coordinates available')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selected ? (
            <Card className="p-4">
              <p className="text-xs font-medium text-secondary">Selected incident</p>
              <p className="mt-1 font-mono text-sm font-semibold text-primary">{selected.reference}</p>
              <Link
                href={`/incidents/${selected.incidentId}`}
                className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Open incident details
              </Link>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

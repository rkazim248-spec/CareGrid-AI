'use client';

import * as React from 'react';
import { MapPinOff } from 'lucide-react';

import { URGENCY_META } from '@/config';
import { DEMO_SPAN_M, clampPercent, projectToPercent } from '@/lib/format';
import { DUPLICATE_RADIUS_M } from '@/components/domain';
import type { Incident, IncidentLocation, Urgency } from '@/types';

/**
 * MapCanvas — the Phase 1 map placeholder (docs/04 §5.30, §11.1, FR-086).
 *
 * PHASE 6 REPLACES THIS FILE. It draws a stylised stand-in using the map
 * palette tokens in `app/styles/globals.css` (`--color-map-land`, `-block`,
 * `-road-major`, `-road-minor`, `-water`) and projects coordinates with the
 * equirectangular helper in `lib/format/geo.ts`. Its only job is to make the
 * layout, the overlays, and the marker language reviewable before a Maps SDK key
 * exists. Phase 6 swaps the projection; nothing above this file changes.
 *
 * Three rules from §11.1 are honoured here because they are LANGUAGE rules, not
 * rendering details, and a rewrite would lose them:
 *
 *  1. Marker SHAPE carries urgency as a second, non-colour channel:
 *     octagon → triangle → circle → hollow circle, plus a hatched square for an
 *     incident with no location at all.
 *  2. An incident with `location === null` gets a visible LOCATION UNKNOWN
 *     marker. It is never dropped and never guessed at.
 *  3. The 500 m duplicate ring is a DASHED circle at true radius, labelled, and
 *     only drawn for the selected incident.
 *
 * The whole canvas is `aria-hidden`. The accessible content of this page is the
 * list beside it (docs/04 §5.30 accessibility, FR-085), which is why the list is
 * always in the DOM.
 */

const RING_SIZE_PCT = Math.round((DUPLICATE_RADIUS_M / DEMO_SPAN_M) * 200);

type Shape = 'octagon' | 'triangle' | 'circle' | 'hollow-circle' | 'unknown';

const SHAPE_FOR_URGENCY: Record<Urgency, Shape> = {
  critical: 'octagon',
  high: 'triangle',
  medium: 'circle',
  low: 'hollow-circle',
};

export function MapCanvas({
  incidents,
  selectedId,
  onSelect,
  showDuplicateRing,
  className,
}: {
  incidents: readonly Incident[];
  selectedId: string | null;
  onSelect: (incident: Incident) => void;
  showDuplicateRing: boolean;
  className?: string;
}) {
  const located = incidents.filter((incident) => incident.location !== null);
  const unknown = incidents.filter((incident) => incident.location === null);
  const selected = incidents.find((incident) => incident.incidentId === selectedId);

  return (
    <div
      aria-hidden="true"
      className={`relative h-full w-full overflow-hidden rounded-card border border-default bg-map-land ${className ?? ''}`}
    >
      <Terrain />

      {showDuplicateRing && selected?.location ? (
        <DuplicateRing location={selected.location} />
      ) : null}

      {located.map((incident) => (
        <PlacedMarker
          key={incident.incidentId}
          incident={incident}
          selected={incident.incidentId === selectedId}
          onSelect={onSelect}
        />
      ))}

      {unknown.map((incident, index) => (
        <UnknownMarker key={incident.incidentId} index={index} />
      ))}
    </div>
  );
}

/** A stylised block/road/water pattern. Decorative, so it carries no text. */
function Terrain() {
  return (
    <div className="absolute inset-0">
      <div className="absolute top-[8%] left-[6%] h-[22%] w-[28%] rounded-sm bg-map-block" />
      <div className="absolute top-[38%] left-[4%] h-[26%] w-[34%] rounded-sm bg-map-block" />
      <div className="absolute top-[12%] right-[8%] h-[30%] w-[30%] rounded-sm bg-map-block" />
      <div className="absolute right-[6%] bottom-[10%] h-[34%] w-[38%] rounded-sm bg-map-block" />
      <div className="absolute bottom-[6%] left-[30%] h-[16%] w-[22%] rounded-sm bg-map-block" />

      <div className="absolute inset-x-0 top-[32%] h-1 bg-map-road-major" />
      <div className="absolute inset-y-0 left-[42%] w-1 bg-map-road-major" />
      <div className="absolute inset-x-0 top-[68%] h-1 bg-map-road-minor" />
      <div className="absolute inset-y-0 left-[76%] w-1 bg-map-road-minor" />
      <div className="absolute top-[10%] left-[18%] h-1 w-[40%] bg-map-road-minor" />
      <div className="absolute right-[16%] bottom-[22%] h-1 w-[30%] bg-map-road-minor" />

      <div className="absolute top-0 right-[2%] h-[46%] w-[16%] bg-map-water" />
    </div>
  );
}

function PlacedMarker({
  incident,
  selected,
  onSelect,
}: {
  incident: Incident;
  selected: boolean;
  onSelect: (incident: Incident) => void;
}) {
  const location = incident.location;
  if (!location) return null;

  const { x, y } = projectToPercent(location);
  const shape = SHAPE_FOR_URGENCY[incident.urgency];
  const tone = URGENCY_META[incident.urgency].textClass;

  return (
    <button
      type="button"
      onClick={() => onSelect(incident)}
      className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-sm p-1 ${tone} ${selected ? 'ring-2 ring-selected' : ''}`}
      // Geometry from the projection helper; colour comes from the token class.
      style={{ left: `${clampPercent(x)}%`, top: `${clampPercent(y)}%` }}
    >
      <MarkerShape shape={shape} />
      <span className="sr-only">{incident.reference}</span>
    </button>
  );
}

/** The hatched square used when an incident has no location at all (docs/04 §11.1). */
function UnknownMarker({ index }: { index: number }) {
  return (
    <span
      className="absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-dashed border-status-new text-status-new"
      style={{ left: `${clampPercent(12 + index * 6)}%`, top: `${clampPercent(84 - index * 4)}%` }}
    >
      <MapPinOff className="size-3.5" />
    </span>
  );
}

function DuplicateRing({ location }: { location: IncidentLocation }) {
  const { x, y } = projectToPercent(location);
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2 rounded-pill border border-dashed border-accent bg-accent/12"
      // Geometry only: true 500 m radius against the demo span. The colour is
      // the accent token at 12% (docs/04 §11.4), applied as a class.
      style={{
        left: `${clampPercent(x)}%`,
        top: `${clampPercent(y)}%`,
        width: `${RING_SIZE_PCT}%`,
        paddingBottom: `${RING_SIZE_PCT}%`,
      }}
    />
  );
}

/** Urgency as SHAPE. §11.1: a map that can draw shapes must use them. */
function MarkerShape({ shape }: { shape: Shape }) {
  const common = { fill: 'currentColor', stroke: 'var(--cg-bg-app)', strokeWidth: 1.5 };

  if (shape === 'octagon') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M4 1h6l3 3v6l-3 3H4l-3-3V4z" {...common} />
      </svg>
    );
  }
  if (shape === 'triangle') {
    return (
      <svg width="15" height="15" viewBox="0 0 15 15">
        <path d="M7.5 1l6.5 12H1z" {...common} />
      </svg>
    );
  }
  if (shape === 'hollow-circle') {
    return (
      <svg width="13" height="13" viewBox="0 0 13 13">
        <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  }
  if (shape === 'unknown') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <rect x="1" y="1" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 13 13">
      <circle cx="6.5" cy="6.5" r="6" {...common} />
    </svg>
  );
}

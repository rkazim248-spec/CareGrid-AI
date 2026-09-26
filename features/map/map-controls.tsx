'use client';

import * as React from 'react';
import { Crosshair, List, Maximize, Minus, Plus, RotateCcw } from 'lucide-react';

import { Button, Card, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { cn } from '@/lib/cn';
import { DUPLICATE_RADIUS_M } from '@/components/domain';

/**
 * MapControls — the overlay control cluster (docs/04 §5.30, §13.10).
 *
 * `+` / `−`, "Centre on me", "Fit to results", "Layers", "Show list", and the
 * 500 m duplicate-ring toggle. Every control is a real button with a real label
 * (anti-pattern A10) and a 44 px hit area, because this cluster sits over a map
 * where a mis-tap moves a person's view of an emergency.
 *
 * The duplicate ring is `on` by default for a dispatcher or an admin and `off`
 * for everyone else (docs/04 §11.4) — the caller decides, because only the caller
 * knows the role. Phase 1 zoom and centre are local state: the numbers exist so
 * the controls are reviewable, and nothing is panned or animated (docs/04 §5.30
 * "never auto-pan").
 */

const ZOOM_LABEL = 'Map zoom level';
const ZOOM_MIN = 10;
const ZOOM_MAX = 20;

export function MapControls({
  zoom,
  onZoomChange,
  showList,
  onShowListChange,
  showRing,
  onShowRingChange,
  ringAvailable,
  onCentreOnMe,
  onFitToResults,
  className,
}: {
  zoom: number;
  onZoomChange: (next: number) => void;
  showList: boolean;
  onShowListChange: (next: boolean) => void;
  showRing: boolean;
  onShowRingChange: (next: boolean) => void;
  /** False for a responder: the ring is a dispatcher tool (docs/04 §11.4). */
  ringAvailable: boolean;
  onCentreOnMe: () => void;
  onFitToResults: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-card border border-default bg-surface p-2',
        className,
      )}
    >
      <div role="group" aria-label={ZOOM_LABEL} className="flex flex-col gap-1">
        <Button
          variant="secondary"
          size="lg"
          className="min-h-11 min-w-11"
          onClick={() => onZoomChange(Math.min(ZOOM_MAX, zoom + 1))}
        >
          <Plus aria-hidden="true" />
          <span className="sr-only">Zoom in</span>
        </Button>
        <p className="text-center text-2xs text-muted tabular" aria-live="polite">
          {zoom}
        </p>
        <Button
          variant="secondary"
          size="lg"
          className="min-h-11 min-w-11"
          onClick={() => onZoomChange(Math.max(ZOOM_MIN, zoom - 1))}
        >
          <Minus aria-hidden="true" />
          <span className="sr-only">Zoom out</span>
        </Button>
      </div>

      <Button variant="secondary" size="sm" onClick={onCentreOnMe} className="min-h-11">
        <Crosshair aria-hidden="true" />
        Centre on me
      </Button>

      <Button variant="secondary" size="sm" onClick={onFitToResults} className="min-h-11">
        <Maximize aria-hidden="true" />
        Fit to results
      </Button>

      <LayersControl />

      <Button
        variant={showList ? 'secondary' : 'outline'}
        size="sm"
        onClick={() => onShowListChange(!showList)}
        aria-pressed={showList}
        className="min-h-11"
      >
        <List aria-hidden="true" />
        {showList ? 'Hide list' : 'Show list'}
      </Button>

      {ringAvailable ? (
        <Button
          variant={showRing ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => onShowRingChange(!showRing)}
          aria-pressed={showRing}
          className="min-h-11"
        >
          <RotateCcw aria-hidden="true" />
          {DUPLICATE_RADIUS_M} m ring
        </Button>
      ) : null}
    </div>
  );
}

/** Layers is a `Select` because it is a choice, not a toggle (docs/04 §5.5). */
function LayersControl() {
  const id = React.useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-2xs font-semibold tracking-[0.06em] text-muted uppercase">
        Layers
      </label>
      <Select defaultValue="incidents">
        <SelectTrigger id={id} className="min-h-11">
          <SelectValue placeholder="Incidents" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="incidents">Incidents</SelectItem>
          <SelectItem value="incidents+responders">Incidents and responders</SelectItem>
          <SelectItem value="incidents+accuracy">Incidents with accuracy radius</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/** Small legend card. Rendered beside the map, never inside it. */
export function MapLegend({ className }: { className?: string }) {
  return (
    <Card className={cn('p-3', className)}>
      <h2 className="uppercase-label mb-2 text-muted">Map legend</h2>
      <ul className="flex flex-col gap-1.5">
        <LegendRow label="Critical incident" shape="octagon" swatch="text-urgency-critical" />
        <LegendRow label="High incident" shape="triangle" swatch="text-urgency-high" />
        <LegendRow label="Medium incident" shape="circle" swatch="text-urgency-medium" />
        <LegendRow label="Low incident" shape="hollow" swatch="text-urgency-low" />
        <LegendRow label="Location unknown" shape="unknown" swatch="text-status-new" />
        <li className="mt-1 flex items-center gap-2 text-xs text-secondary">
          <span
            aria-hidden="true"
            className="inline-block size-3.5 rounded-pill border border-dashed border-accent"
          />
          {DUPLICATE_RADIUS_M} m duplicate zone
        </li>
        <li className="flex items-center gap-2 text-xs text-secondary">
          <span aria-hidden="true" className="inline-block size-3.5 rounded-pill border border-control" />
          GPS accuracy radius
        </li>
      </ul>
    </Card>
  );
}

function LegendRow({
  label,
  shape,
  swatch,
}: {
  label: string;
  shape: 'octagon' | 'triangle' | 'circle' | 'hollow' | 'unknown';
  swatch: string;
}) {
  return (
    <li className="flex items-center gap-2 text-xs text-secondary">
      <span className={cn('inline-block size-3.5 shrink-0', swatch)} aria-hidden="true">
        {shape === 'circle' ? <span className="block size-3.5 rounded-pill bg-current" /> : null}
        {shape === 'hollow' ? (
          <span className="block size-3.5 rounded-pill border-2 border-current" />
        ) : null}
        {shape === 'unknown' ? (
          <span className="block size-3.5 rounded-sm border-2 border-dashed border-current" />
        ) : null}
        {shape === 'octagon' ? <OctagonSwatch /> : null}
        {shape === 'triangle' ? <TriangleSwatch /> : null}
      </span>
      {label}
    </li>
  );
}

function OctagonSwatch() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="block">
      <path d="M4 1h6l3 3v6l-3 3H4l-3-3V4z" fill="currentColor" />
    </svg>
  );
}

function TriangleSwatch() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="block">
      <path d="M7 1l6 12H1z" fill="currentColor" />
    </svg>
  );
}

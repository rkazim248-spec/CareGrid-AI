'use client';

import * as React from 'react';
import { Layers, LocateFixed, Maximize2, Minus, Plus, List, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui/icon-button';
import { MarkerShapeGlyph } from '@/components/map/map-marker';
import { URGENCY_META } from '@/config/urgencies';
import { URGENCIES } from '@/types/enums';
import type { Urgency } from '@/types/enums';

/**
 * MarkerLegend — docs/04 §5.31
 *
 * Every row repeats the SHAPE **and** the COLOUR in its accessible name
 * ("Critical incident: octagon, red"), because a legend drawn as coloured chips
 * alone is unreadable to a screen-reader user and ambiguous to a colour-blind
 * one.
 *
 * Collapses to a single button below 768px. Always rendered as a `role="list"`
 * even when visually collapsed.
 */
export function MarkerLegend({ className }: { className?: string }) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className={cn('rounded-card border border-default bg-surface', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-subtle px-3 py-2">
        <h2 className="uppercase-label text-muted">Map legend</h2>
        <IconButton
          label={open ? 'Hide the map legend' : 'Show the map legend'}
          icon={open ? Minus : Layers}
          size="sm"
          onClick={() => setOpen((v) => !v)}
          className="min-h-8 min-w-8 md:hidden"
        />
      </div>

      <ul
        aria-label="Map legend"
        className={cn('flex flex-col gap-2 px-3 py-3', open ? 'flex' : 'hidden md:flex')}
      >
        <li className="uppercase-label text-muted" aria-hidden="true">
          Incidents
        </li>
        {URGENCIES.map((urgency) => (
          <li
            key={urgency}
            className="flex items-center gap-2"
            aria-label={`${URGENCY_META_LABEL[urgency]} incident: ${SHAPE_SPOKEN[urgency]}`}
          >
            <span className="flex size-4 items-center justify-center">
              <MarkerShapeGlyph
                shape={URGENCY_META[urgency].shape}
                size={13}
                className={COLOUR[urgency]}
              />
            </span>
            <span className="text-xs text-secondary" aria-hidden="true">
              {URGENCY_META_LABEL[urgency]} — {URGENCY_META_SLA[urgency]}
            </span>
          </li>
        ))}

        <li className="mt-1 flex items-center gap-2">
          <span className="flex size-4 items-center justify-center text-neutral">
            <MarkerShapeGlyph shape="unknown" size={13} />
          </span>
          <span className="text-xs text-secondary">Location unknown</span>
        </li>

        <li className="mt-2 flex items-center gap-2">
          <span className="size-4 rounded-pill border border-dashed border-accent" aria-hidden="true" />
          <span className="text-xs text-secondary">500 m duplicate zone</span>
        </li>

        <li className="mt-2 flex items-center gap-2">
          <span className="size-4 rounded-pill bg-success" aria-hidden="true" />
          <span className="text-xs text-secondary">Responder available</span>
        </li>
        <li className="flex items-center gap-2">
          <span className="size-4 rounded-pill bg-warning" aria-hidden="true" />
          <span className="text-xs text-secondary">Responder busy</span>
        </li>
        <li className="flex items-center gap-2">
          <span className="size-4 rounded-pill border border-dashed border-control" aria-hidden="true" />
          <span className="text-xs text-secondary">Location out of date</span>
        </li>
        <li className="mt-1 text-2xs text-muted">
          An offline responder is not shown, so nobody is assigned to an empty marker.
        </li>
      </ul>
    </div>
  );
}

const URGENCY_META_LABEL: Record<Urgency, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const URGENCY_META_SLA: Record<Urgency, string> = {
  critical: '5 min target',
  high: '15 min target',
  medium: '60 min target',
  low: '240 min target',
};
const COLOUR: Record<Urgency, string> = {
  critical: 'text-urgency-critical',
  high: 'text-urgency-high',
  medium: 'text-urgency-medium',
  low: 'text-urgency-low',
};
const SHAPE_SPOKEN: Record<Urgency, string> = {
  critical: 'octagon, red',
  high: 'triangle, orange',
  medium: 'filled circle, amber',
  low: 'hollow circle, blue',
};

/**
 * MapControls — the control cluster. Every control is a real, labelled button.
 * Zoom and centre are UI-only in Phase 1; they update local state and toast.
 */
export function MapControls({
  onFit,
  onCentre,
  onToggleList,
  listOpen,
  onRetry,
  ringVisible,
  onToggleRing,
  className,
}: {
  onFit?: () => void;
  onCentre?: () => void;
  onToggleList?: () => void;
  listOpen?: boolean;
  onRetry?: () => void;
  ringVisible?: boolean;
  onToggleRing?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <IconButton label="Zoom in" icon={Plus} size="sm" onClick={onFit} className="min-h-8 min-w-8" />
      <IconButton label="Zoom out" icon={Minus} size="sm" onClick={onFit} className="min-h-8 min-w-8" />
      <IconButton label="Centre on me" icon={LocateFixed} size="sm" onClick={onCentre} className="min-h-8 min-w-8" />
      <IconButton label="Fit to results" icon={Maximize2} size="sm" onClick={onFit} className="min-h-8 min-w-8" />
      {onToggleRing ? (
        <IconButton
          label={ringVisible ? 'Hide the 500 m duplicate zone' : 'Show the 500 m duplicate zone'}
          icon={Layers}
          size="sm"
          tone={ringVisible ? 'accent' : 'default'}
          aria-pressed={ringVisible}
          onClick={onToggleRing}
          className="min-h-8 min-w-8"
        />
      ) : null}
      {onToggleList ? (
        <IconButton
          label={listOpen ? 'Show the map instead of the list' : 'Show the list instead of the map'}
          icon={List}
          size="sm"
          aria-pressed={listOpen}
          onClick={onToggleList}
          className="min-h-8 min-w-8"
        />
      ) : null}
      {onRetry ? (
        <IconButton label="Retry the map" icon={RefreshCw} size="sm" onClick={onRetry} className="min-h-8 min-w-8" />
      ) : null}
    </div>
  );
}

'use client';

import * as React from 'react';

import { cn } from '@/lib/cn';
import { URGENCY_META } from '@/config/urgencies';
import { clampPercent, projectToPercent } from '@/lib/format';
import type { GeoPoint } from '@/types/domain';
import type { MarkerShape, ResponderStatus, Urgency } from '@/types/enums';

/**
 * MapMarker — docs/04 §11.1
 *
 * SHAPE is the second, non-colour channel for urgency (a map that can draw
 * shapes must use them). A map that only had colour would fail WCAG 1.4.1 and
 * would be unreadable to a protanope at 2 m on a projector.
 *
 * The shape is drawn in CSS/SVG rather than a bitmap so it is crisp, has no
 * network cost, and recolours automatically under the light theme.
 */
export function MarkerShapeGlyph({
  shape,
  className,
  size = 14,
}: {
  shape: MarkerShape;
  className?: string;
  size?: number;
}) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true } as const;

  switch (shape) {
    case 'octagon':
      return (
        <svg {...common} className={className}>
          <polygon
            points="5.6,1 10.4,1 15,5.6 15,10.4 10.4,15 5.6,15 1,10.4 1,5.6"
            fill="currentColor"
            stroke="var(--cg-bg-app)"
            strokeWidth="1.5"
          />
        </svg>
      );
    case 'triangle':
      return (
        <svg {...common} className={className}>
          <polygon
            points="8,1 15.5,14.5 0.5,14.5"
            fill="currentColor"
            stroke="var(--cg-bg-app)"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'hollow-circle':
      return (
        <svg {...common} className={className}>
          <circle cx="8" cy="8" r="6" fill="transparent" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case 'unknown':
      return (
        <svg {...common} className={className}>
          <rect
            x="1.5"
            y="1.5"
            width="13"
            height="13"
            rx="1"
            fill="transparent"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="3 2"
          />
        </svg>
      );
    case 'circle':
    default:
      return (
        <svg {...common} className={className}>
          <circle cx="8" cy="8" r="6" fill="currentColor" stroke="var(--cg-bg-app)" strokeWidth="1.5" />
        </svg>
      );
  }
}

const URGENCY_FILL: Record<Urgency, string> = {
  critical: 'text-urgency-critical',
  high: 'text-urgency-high',
  medium: 'text-urgency-medium',
  low: 'text-urgency-low',
};

export type MapMarkerProps = {
  urgency: Urgency;
  shape?: MarkerShape;
  position: { x: number; y: number };
  label: string;
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
};

export function MapMarker({
  urgency,
  shape,
  position,
  label,
  selected = false,
  onSelect,
  className,
}: MapMarkerProps) {
  const resolvedShape = shape ?? URGENCY_META[urgency].shape;
  const size = shape === 'unknown' ? 14 : urgency === 'high' ? 15 : 13;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      // The accessible name repeats SHAPE and COLOUR, so a screen-reader user
      // gets the same information a sighted user gets from the drawing
      // (docs/04 §5.31).
      aria-label={`${label}. ${urgency} incident: ${describeShape(resolvedShape)}`}
      style={{ left: `${clampPercent(position.x)}%`, top: `${clampPercent(position.y)}%` }}
      className={cn(
        'absolute -translate-x-1/2 -translate-y-1/2 rounded-pill p-0.5',
        'transition-transform duration-[--motion-duration-fast] motion-reduce:transition-none',
        'hover:scale-110 motion-reduce:hover:scale-100',
        'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
        URGENCY_FILL[urgency],
        selected && 'z-10 scale-125 ring-2 ring-focus ring-offset-2 ring-offset-app motion-reduce:scale-100',
        className,
      )}
    >
      <MarkerShapeGlyph shape={resolvedShape} size={size} />
    </button>
  );
}

const RESPONDER_STYLE: Record<ResponderStatus, { className: string; label: string; glyph: 'star' | 'half' }> = {
  available: { className: 'text-success', label: 'Available responder', glyph: 'star' },
  busy: { className: 'text-warning', label: 'Busy responder', glyph: 'half' },
  offline: { className: 'text-muted', label: 'Offline responder', glyph: 'star' },
};

export function ResponderMarker({
  status,
  position,
  label,
  stale = false,
  selected = false,
  onSelect,
}: {
  status: ResponderStatus;
  position: { x: number; y: number };
  label: string;
  stale?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  // FR-081: an offline responder is NOT rendered. Hiding a real person is
  // better than showing a dot that invites a dispatcher to assign to nobody.
  if (status === 'offline' && !stale) return null;

  const style = RESPONDER_STYLE[status];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${label}. ${style.label}${stale ? ', location is out of date' : ''}.`}
      style={{ left: `${clampPercent(position.x)}%`, top: `${clampPercent(position.y)}%` }}
      className={cn(
        'absolute -translate-x-1/2 -translate-y-1/2 rounded-pill p-0.5',
        'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
        stale ? 'text-control' : style.className,
        selected && 'z-10 ring-2 ring-focus ring-offset-2 ring-offset-app',
      )}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
        <circle
          cx="8"
          cy="8"
          r="7"
          fill="currentColor"
          stroke={stale ? 'var(--cg-border-focus)' : 'var(--cg-bg-app)'}
          strokeWidth="1.5"
          strokeDasharray={stale ? '3 2' : undefined}
        />
        {style.glyph === 'star' ? (
          <path
            d="M8 4.5l1 2.2 2.4.3-1.8 1.6.5 2.4L8 9.8 5.9 11l.5-2.4L4.6 7l2.4-.3z"
            fill="var(--cg-bg-app)"
          />
        ) : (
          <path d="M8 1a7 7 0 000 14z" fill="var(--cg-bg-app)" />
        )}
      </svg>
    </button>
  );
}

/** The 500 m duplicate ring, drawn true-to-scale against the placeholder. */
export function DuplicateRadiusRing({
  centre,
  radiusM,
  visible = true,
}: {
  centre: GeoPoint;
  radiusM: number;
  visible?: boolean;
}) {
  if (!visible) return null;
  const position = projectToPercent(centre);
  // DEMO_SPAN_M spans the viewport width; a ring of radiusM is radiusM/span of
  // half the width, so the diameter as a percentage of the width is
  // 2 * radiusM / span * 50.
  const diameterPct = (2 * radiusM) / 4000 * 100;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute rounded-pill border border-dashed border-accent bg-accent/12"
      style={{
        left: `${clampPercent(position.x)}%`,
        top: `${clampPercent(position.y)}%`,
        width: `${diameterPct}%`,
        aspectRatio: '1',
        transform: 'translate(-50%, -50%)',
      }}
    />
  );
}

function describeShape(shape: MarkerShape): string {
  switch (shape) {
    case 'octagon':
      return 'octagon';
    case 'triangle':
      return 'triangle';
    case 'hollow-circle':
      return 'hollow circle';
    case 'unknown':
      return 'dashed square, location unknown';
    case 'circle':
    default:
      return 'filled circle';
  }
}

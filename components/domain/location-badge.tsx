import * as React from 'react';

import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { DUPLICATE_DEFAULTS, ACCURACY_THRESHOLDS } from '@/config/limits';
import { MapPin, MapPinOff, Target } from 'lucide-react';
import type { AccuracyGrade, DuplicateStatus, LocationSource } from '@/types/enums';

/**
 * LocationBadge — docs/04 §2.12
 *
 * Location honesty is a first-class UI state (principle P2). An accuracy that
 * is worse than 1000 m says so; an unknown location says THAT, loudly enough
 * to sort above a merely-approximate one. A dispatcher must never have to guess
 * whether a pin is precise (anti-pattern A5).
 */
export type LocationBadgeProps = React.ComponentProps<typeof Badge> & {
  accuracyGrade: AccuracyGrade | null;
  accuracyM?: number | null;
  source?: LocationSource;
  compact?: boolean;
};

const GRADE: Record<AccuracyGrade, { text: string; bg: string; border: string; word: string }> = {
  high: { text: 'text-success', bg: 'bg-success-muted', border: 'border-success', word: 'Accurate' },
  medium: { text: 'text-warning', bg: 'bg-warning-muted', border: 'border-warning', word: 'Approximate' },
  low: { text: 'text-warning', bg: 'bg-warning-muted', border: 'border-warning', word: 'Approximate' },
  unknown: { text: 'text-neutral', bg: 'bg-neutral-muted', border: 'border-default', word: 'Unknown' },
};

export function LocationBadge({
  accuracyGrade,
  accuracyM,
  compact = false,
  className,
  ...props
}: LocationBadgeProps) {
  const isUnknown = !accuracyGrade || accuracyGrade === 'unknown';
  const grade = isUnknown ? GRADE.unknown : GRADE[accuracyGrade];
  const Icon = isUnknown ? MapPinOff : accuracyGrade === 'high' ? MapPin : Target;

  const label = isUnknown
    ? 'LOCATION UNKNOWN'
    : compact
      ? grade.word
      : `${grade.word} ±${Math.round(accuracyM ?? 0)} m`;

  const spoken = isUnknown
    ? 'Location unknown. A dispatcher will need to contact the reporter.'
    : `Location is ${grade.word.toLowerCase()} to about ${Math.round(accuracyM ?? 0)} metres`;

  return (
    <Badge
      variant="default"
      size="sm"
      className={cn(grade.bg, grade.border, grade.text, className)}
      aria-label={spoken}
      {...props}
    >
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** Short helper for the sort rule: unknown sorts above merely-approximate. */
export function locationSortWeight(grade: AccuracyGrade | null): number {
  if (!grade || grade === 'unknown') return 0;
  if (grade === 'low') return 1;
  if (grade === 'medium') return 2;
  return 3;
}

/**
 * DuplicateChip — the "this may be the same incident" signal.
 *
 * A suggestion is NEVER presented as a merge. Only a dispatcher performs a
 * merge, and it is reversible for 24 hours (FR-041, FR-046, FR-047).
 */
export function DuplicateChip({
  status,
  primaryReference,
  distanceM,
  className,
}: {
  status: DuplicateStatus;
  primaryReference?: string;
  distanceM?: number;
  className?: string;
}) {
  if (status === 'none' || status === 'separate_incident') return null;

  const confirmed = status === 'confirmed_duplicate';

  return (
    <Badge
      variant="default"
      size="sm"
      className={cn(
        confirmed ? 'border-accent bg-accent-muted text-accent-fg-muted' : 'border-warning bg-warning-muted text-warning-fg-muted',
        className,
      )}
      aria-label={
        confirmed
          ? `Confirmed duplicate of ${primaryReference ?? 'an earlier report'}. A dispatcher linked it.`
          : `Possible duplicate of ${primaryReference ?? 'an earlier report'}${distanceM ? `, ${distanceM} metres away` : ''}. A dispatcher has not confirmed it.`
      }
    >
      {confirmed ? 'Duplicate linked' : 'Possible duplicate'}
      {primaryReference ? <span className="font-mono text-2xs">{primaryReference}</span> : null}
    </Badge>
  );
}

/** The 500 m duplicate radius, so the map ring and the copy agree. */
export const DUPLICATE_RADIUS_M = DUPLICATE_DEFAULTS.radiusM;

/** Accuracy thresholds, re-exported so a form helper can quote the real number. */
export { ACCURACY_THRESHOLDS };

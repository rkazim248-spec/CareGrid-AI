import * as React from 'react';
import { Check, CircleHelp, Eye } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { CONFIDENCE_THRESHOLDS } from '@/config/limits';
import type { ConfidenceBand } from '@/types/domain';

/**
 * ConfidenceBadge — docs/04 §2.8
 *
 * Three bands. The LOW band does NOT say "0.31" — it says **"Needs review"**,
 * because a number invites a reader to treat 0.31 as meaningfully better than
 * 0.28, and the operational truth is that below 0.60 a person must read the
 * original report.
 *
 * `aiNeedsReview` is a SERVER-provided boolean (docs/09 §2.8). The client
 * derives only the BAND from `confidence`; it never recomputes needsReview
 * from a different threshold, because two thresholds would drift.
 */
export type ConfidenceBadgeProps = React.ComponentProps<typeof Badge> & {
  confidence: number;
  needsReview?: boolean;
  size?: 'sm' | 'md';
};

type BandStyle = {
  label: string;
  textClass: string;
  bgClass: string;
  borderClass: string;
  icon: LucideIcon;
};

const BANDS: Record<ConfidenceBand, BandStyle> = {
  high: {
    label: 'AI estimate',
    textClass: 'text-success',
    bgClass: 'bg-success-muted',
    borderClass: 'border-success',
    icon: Check,
  },
  medium: {
    label: 'AI estimate',
    textClass: 'text-warning',
    bgClass: 'bg-warning-muted',
    borderClass: 'border-warning',
    icon: CircleHelp,
  },
  low: {
    label: 'Needs review',
    textClass: 'text-confidence-low',
    bgClass: 'bg-warning-muted',
    borderClass: 'border-warning',
    icon: Eye,
  },
};

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE_THRESHOLDS.highAtOrAbove) return 'high';
  if (confidence >= CONFIDENCE_THRESHOLDS.needsReviewBelow) return 'medium';
  return 'low';
}

export function ConfidenceBadge({
  confidence,
  needsReview,
  size = 'md',
  className,
  ...props
}: ConfidenceBadgeProps) {
  const band = confidenceBand(confidence);
  const style = BANDS[band];
  const Icon = style.icon;
  const isLow = band === 'low';

  return (
    <Badge
      variant="default"
      size={size}
      className={cn(style.bgClass, style.borderClass, style.textClass, className)}
      aria-label={
        isLow
          ? `AI confidence ${confidence.toFixed(2)}, low. Needs review — read the original report.`
          : `AI confidence ${confidence.toFixed(2)}, ${band}. AI estimate, check the original report.`
      }
      title={isLow ? 'Needs review' : `AI estimate ${confidence.toFixed(2)}`}
      data-needs-review={needsReview ? 'true' : undefined}
      {...props}
    >
      <Icon aria-hidden="true" />
      {isLow ? 'Needs review' : `${style.label} ${confidence.toFixed(2)}`}
    </Badge>
  );
}

/**
 * ConfidenceBar — docs/04 §5.29
 * 4px track with a tick at the needs-review threshold. The bar is
 * `aria-hidden`: the adjacent badge already carries the meaning, and a bare
 * bar has nothing to announce.
 */
export function ConfidenceBar({
  confidence,
  className,
}: {
  confidence: number;
  className?: string;
}) {
  const band = confidenceBand(confidence);
  const pct = Math.max(0, Math.min(1, confidence)) * 100;
  const fillClass =
    band === 'high' ? 'bg-success' : band === 'medium' ? 'bg-warning' : 'bg-confidence-low';

  return (
    <div
      aria-hidden="true"
      className={cn('relative h-1 w-full min-w-16 overflow-hidden rounded-pill bg-inset', className)}
    >
      <div className={cn('h-full rounded-pill', fillClass)} style={{ width: `${pct}%` }} />
      <span
        className="absolute inset-y-0 w-px bg-control"
        style={{ left: `${CONFIDENCE_THRESHOLDS.needsReviewBelow * 100}%` }}
      />
    </div>
  );
}

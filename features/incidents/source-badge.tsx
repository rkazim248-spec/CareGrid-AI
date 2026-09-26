import { BadgeCheck, Sparkles, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { VerificationSource } from '@/types';

/**
 * SourceBadge — the verification/source column of the queue (FR-072) and the
 * `triageSource` qualifier wherever a triage value is shown.
 *
 * docs/04 §14.2 fixes the three strings exactly: "AI triaged", "Fallback
 * triage", "Human verified". docs/04 §2.12 also rules that a verification
 * source is a TEXT BADGE ONLY — it is provenance, not a severity, so it never
 * borrows a status colour.
 */
type SourceStyle = {
  label: string;
  className: string;
  Icon: LucideIcon;
  spoken: string;
};

const SOURCE: Record<VerificationSource, SourceStyle> = {
  human: {
    label: 'Human verified',
    className: 'border-success bg-success-muted text-success',
    Icon: BadgeCheck,
    spoken: 'A person verified this report.',
  },
  ai: {
    label: 'AI triaged',
    className: 'border-accent bg-accent-muted text-accent-fg-muted',
    Icon: Sparkles,
    spoken: 'Triaged by an automated estimate. A person reviews it before it is verified.',
  },
  fallback: {
    label: 'Fallback triage',
    className: 'border-warning bg-warning-muted text-warning-fg-muted',
    Icon: TriangleAlert,
    spoken: 'Automated triage was unavailable, so this report is waiting for a person.',
  },
};

export function SourceBadge({
  source,
  size = 'sm',
  className,
}: {
  source: VerificationSource;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const meta = SOURCE[source];
  const Icon = meta.Icon;

  return (
    <Badge
      variant="default"
      size={size}
      className={cn(meta.className, className)}
      aria-label={meta.spoken}
      title={meta.label}
    >
      <Icon aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

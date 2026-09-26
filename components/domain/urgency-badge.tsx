import * as React from 'react';

import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { URGENCY_META } from '@/config/urgencies';
import type { Urgency, UrgencySource } from '@/types/enums';

/**
 * UrgencyBadge — docs/04 §2.6, §7.1
 *
 * THE reason this component exists. An urgency must never be a coloured dot or
 * a coloured row (anti-pattern A2, WCAG 1.4.1). Every rendering carries:
 *
 *   1. a fixed icon per urgency level
 *   2. visible text
 *   3. colour
 *   4. an `aria-label` that is a full sentence including the response target
 *
 * `size="lg"` is the only variant allowed to use 16px+ text, and it exists for
 * the responder primary card where the badge is read at arm's length in
 * daylight.
 */
export type UrgencyBadgeProps = Omit<React.ComponentProps<typeof Badge>, 'size'> & {
  urgency: Urgency;
  /**
   * Who set it. Rendered as a text qualifier in the accessible name and as a
   * tooltip — never as colour (docs/04 §7.2). An AI-set urgency and a
   * human-set one look different to a reader, because they ARE different.
   */
  source?: UrgencySource;
  /** `lg` is the only variant allowed to use 16px+ text (responder card). */
  size?: 'sm' | 'md' | 'lg';
  /** Set false only when the surrounding context already names the urgency. */
  withIcon?: boolean;
};

const SOURCE_LABEL: Record<UrgencySource, string> = {
  ai: 'AI estimate',
  human: 'Set by a person',
  fallback: 'Automatic fallback',
};

export function UrgencyBadge({
  urgency,
  source,
  size = 'md',
  withIcon = true,
  className,
  ...props
}: UrgencyBadgeProps) {
  const meta = URGENCY_META[urgency];
  const Icon = meta.icon;
  const sourceLabel = source ? SOURCE_LABEL[source] : undefined;

  return (
    <Badge
      variant="default"
      size={size === 'lg' ? 'md' : size}
      className={cn(
        meta.bgClass,
        meta.borderClass,
        meta.textClass,
        size === 'lg' && 'h-8 px-3 text-base font-semibold',
        className,
      )}
      // The accessible name is a sentence, not the label.
      aria-label={[meta.ariaTemplate(meta.slaMinutes), sourceLabel].filter(Boolean).join('. ')}
      title={sourceLabel ? `${meta.label} · ${sourceLabel}` : meta.label}
      {...props}
    >
      {withIcon ? <Icon aria-hidden="true" /> : null}
      <span className={size === 'lg' ? 'text-base' : undefined}>{meta.label}</span>
    </Badge>
  );
}

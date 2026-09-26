import * as React from 'react';

import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { STATUS_META } from '@/config/statuses';
import type { IncidentStatus } from '@/types/enums';

/**
 * StatusBadge — docs/04 §6
 *
 * One fixed icon per status plus always-visible text. A StatusBadge never
 * appears without the incident reference nearby: the reference is the anchor,
 * the status is the state (docs/04 §6).
 */
export type StatusBadgeProps = React.ComponentProps<typeof Badge> & {
  status: IncidentStatus;
  size?: 'sm' | 'md';
  withIcon?: boolean;
};

export function StatusBadge({
  status,
  size = 'md',
  withIcon = true,
  className,
  ...props
}: StatusBadgeProps) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;

  return (
    <Badge
      variant="default"
      size={size}
      className={cn(meta.bgClass, meta.borderClass, meta.textClass, className)}
      aria-label={`Status: ${meta.label}`}
      title={meta.label}
      {...props}
    >
      {withIcon ? <Icon aria-hidden="true" /> : null}
      {meta.label}
    </Badge>
  );
}

/**
 * The `closed` status uses `text-secondary` for its label rather than its own
 * token, because `--color-status-closed` is only 4.06:1 and badge text is
 * 12px semibold (below the 18.66px large-text threshold, so 4.5:1 applies).
 * See docs/04 §2.7 note. `STATUS_META.closed.textClass` encodes this.
 */

import * as React from 'react';

import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { ROLE_META } from '@/config/roles';
import type { ActorRole } from '@/types/enums';

/**
 * RoleBadge — docs/04 §5.27
 *
 * An outline badge, never a filled pill: a role is informational, not a
 * severity. The `admin` variant is distinguished by a warning-coloured BORDER,
 * not a filled background, so it does not compete with a status badge sitting
 * next to it.
 *
 * `actorUid: "system"` renders as "CareGrid AI", never as the word "system"
 * (docs/04 §5.26) — "system" is a storage detail, not a name.
 */
export type RoleBadgeProps = React.ComponentProps<typeof Badge> & {
  role: ActorRole;
  size?: 'sm' | 'md';
};

export function RoleBadge({ role, size = 'sm', className, ...props }: RoleBadgeProps) {
  const meta = ROLE_META[role];
  const Icon = meta.icon;

  return (
    <Badge
      variant="outline"
      size={size}
      className={cn(
        meta.emphasised ? 'border-warning text-warning' : 'border-control text-neutral',
        className,
      )}
      aria-label={`Role: ${meta.label}`}
      {...props}
    >
      <Icon aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/cn';

/**
 * Badge — docs/04 §5.10
 *
 * Generic badge. Status, urgency and confidence have their OWN components
 * (StatusBadge / UrgencyBadge / ConfidenceBadge) because each of those carries a
 * contractual `aria-label` and must never be assembled ad hoc.
 *
 * `sm` is the uppercase label variant; `md` is sentence case.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-pill border font-medium whitespace-nowrap [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-default bg-elevated text-primary',
        outline: 'border-control bg-transparent text-secondary',
        muted: 'border-transparent bg-neutral-muted text-secondary',
      },
      size: {
        sm: 'h-5 px-2 text-2xs uppercase tracking-[0.06em] [&_svg:not([class*="size-"])]:size-3.5',
        md: 'h-6 px-2.5 text-xs [&_svg:not([class*="size-"])]:size-3.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type BadgeProps = React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };

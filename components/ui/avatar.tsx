'use client';

import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { UserRound } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * Avatar — docs/04 §5.26
 *
 * `alt` is empty when the name is adjacent text and set to the name only when
 * the avatar stands alone. Phase 1 renders initials only — `photoURL` support
 * arrives with the session in Phase 2, and an <img> to nothing would be a
 * broken-image icon in an operations console.
 */
function Avatar({
  className,
  name,
  size = 'md',
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  name: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}) {
  const sizes = {
    xs: 'size-5 text-[9px]',
    sm: 'size-6 text-[10px]',
    md: 'size-8 text-xs',
    lg: 'size-10 text-sm',
    xl: 'size-16 text-lg',
  } as const;

  const initials =
    name
      ?.split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') ?? '';

  return (
    <AvatarPrimitive.Root
      className={cn(
        'relative flex shrink-0 overflow-hidden rounded-pill border border-default bg-elevated',
        sizes[size],
        className,
      )}
      {...props}
    >
      {name ? (
        <AvatarPrimitive.Fallback
          // Adjacent text carries the name in every current usage, so the
          // fallback glyph is decorative.
          aria-hidden="true"
          className="flex size-full items-center justify-center font-semibold text-secondary"
          delayMs={0}
        >
          {initials || <UserRound className="size-3.5" aria-hidden="true" />}
        </AvatarPrimitive.Fallback>
      ) : (
        <span className="flex size-full items-center justify-center text-muted">
          <UserRound className="size-1/2" aria-hidden="true" />
          <span className="sr-only">No user</span>
        </span>
      )}
    </AvatarPrimitive.Root>
  );
}

export { Avatar };

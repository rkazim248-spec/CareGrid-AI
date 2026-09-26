'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { buttonVariants, type ButtonProps } from '@/components/ui/button';

/**
 * IconButton — docs/04 §5.2
 *
 * Anti-pattern A10: an icon-only control with no accessible name is a defect,
 * so `label` is REQUIRED at the type level, not optional. There is deliberately
 * no overload that lets it be omitted.
 *
 * `label` also becomes the tooltip text, and a non-zero `badge` is appended to
 * the accessible name ("Notifications, 4 unread") because the badge glyph
 * itself is `aria-hidden`.
 */
export type IconButtonProps = Omit<ButtonProps, 'children' | 'aria-label' | 'asChild'> & {
  /** Required. Becomes both `aria-label` and the tooltip. */
  label: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'accent' | 'danger' | 'ghost';
  /** Unread/pending count. Rendered as an aria-hidden dot with a count. */
  badge?: number;
  /**
   * Render an anchor/child element instead of a <button>. Used when the control
   * is a navigation target (e.g. the notification bell). The `label` is still
   * the accessible name of whatever renders.
   */
  asChild?: boolean;
  href?: string;
};

const TONE_CLASSES: Record<NonNullable<IconButtonProps['tone']>, string> = {
  default: 'text-secondary hover:text-primary',
  accent: 'text-accent hover:text-accent-hover',
  danger: 'text-danger hover:bg-danger-muted',
  ghost: 'text-muted hover:text-primary',
};

const BOX: Record<NonNullable<IconButtonProps['size']>, string> = {
  // sm is 32px and is for dense table rows only. md and lg are padded to
  // 44x44 on touch via min-h-11/min-w-11 (docs/04 §5.2).
  sm: 'size-8 min-h-8 min-w-8',
  md: 'size-10 min-h-11 min-w-11',
  lg: 'size-12 min-h-11 min-w-11',
};

const ICON_SIZE: Record<NonNullable<IconButtonProps['size']>, string> = {
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-5',
};

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { label, icon: Icon, size = 'md', tone = 'default', badge, loading, className, asChild, href, ...props },
    ref,
  ) => {
    const hasBadge = typeof badge === 'number' && badge > 0;
    const accessibleName = hasBadge ? `${label}, ${badge} unread` : label;

    if (asChild) {
      // A navigation control. The label still has to reach the rendered element.
      return (
        <a
          ref={ref as React.Ref<HTMLAnchorElement>}
          href={href ?? '#'}
          aria-label={accessibleName}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon' }),
            'relative inline-flex shrink-0 items-center justify-center p-0',
            TONE_CLASSES[tone],
            BOX[size],
            'hover:bg-elevated',
            'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
            className,
          )}
          {...(props as React.ComponentProps<'a'>)}
        >
          <Icon className={ICON_SIZE[size]} aria-hidden="true" />
          {hasBadge ? <BadgePip count={badge} /> : null}
        </a>
      );
    }

    return (
      <button
        ref={ref}
        type="button"
        aria-label={accessibleName}
        aria-busy={loading || undefined}
        disabled={props.disabled ?? loading}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon' }),
          'relative shrink-0 p-0',
          TONE_CLASSES[tone],
          BOX[size],
          'hover:bg-elevated',
          className,
        )}
        {...props}
      >
        {loading ? (
          <Loader2
            className={cn('animate-[var(--animate-spin-slow)] motion-reduce:animate-none', ICON_SIZE[size])}
            aria-hidden="true"
          />
        ) : (
          <Icon className={ICON_SIZE[size]} aria-hidden="true" />
        )}
        {hasBadge ? <BadgePip count={badge} /> : null}
      </button>
    );
  },
);
IconButton.displayName = 'IconButton';

/** The count pip. `aria-hidden` because the number is in the button's label. */
function BadgePip({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-pill bg-danger px-1 text-2xs leading-4 font-semibold text-inverse tabular',
        count > 99 && 'text-[9px]',
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export { IconButton };

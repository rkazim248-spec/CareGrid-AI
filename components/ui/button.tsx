'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * Button — docs/04 §5.1
 *
 * Variants: primary, secondary, outline, ghost, link, danger, danger-outline.
 * Sizes: sm 32 / md 40 / lg 48 / xl 56 / icon 40.
 *
 * Two rules that are not negotiable:
 *  - `type` defaults to "button" so a button inside a form cannot submit it
 *    by accident.
 *  - The `loading` state keeps the label in the DOM (screen-reader text) and
 *    sets `aria-busy`; it does NOT swap the label for "Submitting…". The
 *    label never changes (docs/04 §10.5).
 */
const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control',
    'font-medium transition-[background-color,border-color,color,transform]',
    'duration-[--motion-duration-fast] ease-[--motion-ease-standard]',
    'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-app',
    'disabled:pointer-events-none disabled:opacity-45',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
    '[&_svg:not([class*="size-"])]:size-4',
  ].join(' '),
  {
    variants: {
      variant: {
        // `primary` is the name the UI/UX spec uses; `default` is shadcn's name
        // for the same thing. Both resolve to the accent fill.
        primary: 'bg-accent text-on-solid hover:bg-accent-hover active:bg-accent-active',
        default: 'bg-accent text-on-solid hover:bg-accent-hover active:bg-accent-active',
        secondary:
          'bg-elevated text-primary border border-default hover:border-strong hover:bg-elevated/80',
        outline:
          'border border-control bg-transparent text-primary hover:bg-elevated hover:border-strong',
        ghost: 'bg-transparent text-secondary hover:bg-elevated hover:text-primary',
        link: 'text-accent underline-offset-4 hover:underline',
        danger: 'bg-danger text-inverse hover:brightness-110 active:brightness-95',
        'danger-outline':
          'border border-danger bg-transparent text-danger hover:bg-danger-muted',
      },
      size: {
        // sm is table-only. It must sit inside a padded cell so the effective
        // hit area is >= 44px on touch (docs/04 §5.1 accessibility).
        sm: 'h-8 px-3 text-xs [&_svg:not([class*="size-"])]:size-3.5',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-5 text-base',
        xl: 'h-14 px-6 text-base',
        icon: 'size-10 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a <button>. Keeps a11y on the child. */
    asChild?: boolean;
    /** Shows a spinner, sets aria-busy, and preserves the label for screen readers. */
    loading?: boolean;
  };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled ?? loading}
        aria-busy={loading || undefined}
        {...(asChild ? {} : { type: type ?? 'button' })}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="animate-[var(--animate-spin-slow)] motion-reduce:animate-none" aria-hidden="true" />
            <span className="sr-only">{children}</span>
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };

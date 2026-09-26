import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * Alert / Banner — docs/04 §5.11
 *
 * Tone → fill, border and icon is a fixed mapping. `danger` is RESERVED for
 * critical urgency and real errors (anti-pattern A3): a red alert that does not
 * mean something is wrong destroys the signal when something is.
 */
const alertVariants = cva('relative w-full rounded-card border px-4 py-3 text-sm', {
  variants: {
    tone: {
      info: 'border-info bg-info-muted text-info-fg-muted',
      success: 'border-success bg-success-muted text-success-fg-muted',
      warning: 'border-warning bg-warning-muted text-warning-fg-muted',
      danger: 'border-danger bg-danger-muted text-danger-fg-muted',
      neutral: 'border-default bg-neutral-muted text-secondary',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

const TONE_ICON: Record<string, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: OctagonAlert,
  neutral: Info,
};

export type AlertProps = React.ComponentProps<'div'> &
  VariantProps<typeof alertVariants> & {
    /** Announced immediately. Use only when action is required. */
    role?: 'status' | 'alert';
  };

function Alert({ className, tone, role, children, ...props }: AlertProps) {
  return (
    <div
      data-slot="alert"
      role={role}
      aria-live={role === 'alert' ? 'assertive' : undefined}
      className={cn('flex w-full items-start gap-3', alertVariants({ tone }), className)}
      {...props}
    >
      {children}
    </div>
  );
}

function AlertIcon({ tone = 'neutral', className }: { tone?: string; className?: string }) {
  const Icon = TONE_ICON[tone] ?? Info;
  return <Icon className={cn('mt-px size-icon-md shrink-0', className)} aria-hidden="true" />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('mb-0.5 text-sm font-semibold', className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('max-w-[72ch] text-sm text-inherit opacity-90', className)} {...props} />;
}

function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('ml-auto shrink-0', className)} {...props} />;
}

export { Alert, AlertIcon, AlertTitle, AlertDescription, AlertAction, alertVariants, CircleAlert };

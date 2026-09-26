'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';

import { cn } from '@/lib/cn';

/**
 * Switch — docs/04 §5.8
 * 44x26 track, 20px thumb, `role="switch"` via Radix. Used for responder
 * availability and notification preferences.
 *
 * `SwitchField` is the correct wrapper for a labelled switch: it renders the
 * visible label, the helper text, and — when disabled — the REASON, which
 * FR-017 and docs/04 §10.4 require. A disabled control is never left
 * unexplained.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-[26px] w-11 shrink-0 cursor-pointer items-center rounded-pill border-2 border-transparent',
        'transition-colors duration-[--motion-duration-instant]',
        'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'data-[state=checked]:bg-accent data-[state=unchecked]:bg-control',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-5 rounded-pill bg-primary shadow-sm ring-0',
          'transition-transform duration-[--motion-duration-fast] motion-reduce:transition-none',
          'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export type SwitchFieldProps = React.ComponentProps<typeof SwitchPrimitive.Root> & {
  id: string;
  label: string;
  helperText?: React.ReactNode;
  /** Required when `disabled`. Rendered visibly and linked by aria-describedby. */
  disabledReason?: string;
  className?: string;
};

function SwitchField({
  id,
  label,
  helperText,
  disabledReason,
  disabled,
  className,
  ...props
}: SwitchFieldProps) {
  const helperId = `${id}-helper`;
  const reasonId = `${id}-reason`;
  const describedBy =
    [helperText ? helperId : null, disabled && disabledReason ? reasonId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className={cn('flex items-start justify-between gap-4 py-2', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium text-primary select-none">
          {label}
        </label>
        {helperText ? (
          <p id={helperId} className="text-xs text-secondary">
            {helperText}
          </p>
        ) : null}
        {disabled && disabledReason ? (
          <p id={reasonId} className="text-xs text-warning">
            {disabledReason}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        disabled={disabled}
        aria-describedby={describedBy}
        className="mt-0.5 min-h-11 min-w-11"
        {...props}
      />
    </div>
  );
}

export { Switch, SwitchField };

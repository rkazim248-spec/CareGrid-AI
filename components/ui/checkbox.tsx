'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * Checkbox — docs/04 §5.6
 * 20x20 box inside a 44x44 label hit area. Supports the indeterminate state,
 * which the queue needs for "some rows selected".
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer size-5 shrink-0 rounded-[4px] border border-control bg-elevated',
        'transition-colors duration-[--motion-duration-instant]',
        'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-on-solid',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-on-solid',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {props.checked === 'indeterminate' ? (
          <Minus className="size-3.5" aria-hidden="true" />
        ) : (
          <Check className="size-3.5" aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/** A checkbox with a 44px label hit area and helper text. */
function CheckboxField({
  id,
  label,
  helperText,
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  id: string;
  label: React.ReactNode;
  helperText?: React.ReactNode;
}) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <Checkbox id={id} className="mt-2.5" {...props} />
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="cursor-pointer text-sm text-primary select-none">
          {label}
        </label>
        {helperText ? <p className="text-xs text-secondary">{helperText}</p> : null}
      </div>
    </div>
  );
}

export { Checkbox, CheckboxField };

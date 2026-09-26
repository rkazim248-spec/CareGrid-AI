'use client';

import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { Circle } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * RadioGroup — docs/04 §5.7
 * Used for the reason picker (false alarm), the resolution code, and a severity
 * override. Options stack vertically on mobile and go 2-up at >= 640px; there
 * is never a horizontal radio row at 360px.
 */
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      className={cn('grid gap-2 sm:grid-cols-2', className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'flex aspect-square size-4 shrink-0 rounded-pill border border-control text-accent',
        'transition-colors focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'data-[state=checked]:border-accent',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
        <Circle className="size-2.5 fill-current" aria-hidden="true" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

/** A radio with a 44px label hit area and optional description. */
function RadioCard({
  id,
  value,
  label,
  description,
  disabled,
}: {
  id: string;
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <RadioGroupItem id={id} value={value} disabled={disabled} className="mt-3" />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm text-primary select-none">
          {label}
        </label>
        {description ? <p className="text-xs text-secondary">{description}</p> : null}
      </div>
    </div>
  );
}

export { RadioGroup, RadioGroupItem, RadioCard };

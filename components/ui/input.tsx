'use client';

import * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * Input — docs/04 §5.3
 *
 * Anatomy is label → control → helper → error. The label is ALWAYS visible and
 * `htmlFor` is bound to `id`; a placeholder is an example, never a label
 * (docs/04 §5.3, §10.1).
 *
 * On mobile the control is 48px and the font is 16px — a 14px input makes iOS
 * zoom on focus, which is a real failure mode in a one-handed emergency flow.
 *
 * `errorMessage` sets `aria-invalid` and `aria-errormessage` and renders with
 * `role="alert"` so it is announced on first appearance.
 */
export type InputProps = Omit<React.ComponentProps<'input'>, 'size'> & {
  label?: string;
  helperText?: React.ReactNode;
  errorMessage?: string;
  /** Mono + tabular, for a reference or requestId field. */
  mono?: boolean;
  /** Reserves space for a trailing adornment (e.g. a clear button). */
  trailingSlot?: React.ReactNode;
  containerClassName?: string;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    containerClassName,
    label,
    helperText,
    errorMessage,
    mono = false,
    trailingSlot,
    id,
    type = 'text',
    required,
    ...props
  },
  ref,
) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const helperId = `${inputId}-helper`;
  const errorId = `${inputId}-error`;

  const describedBy =
    [helperText ? helperId : null, errorMessage ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className={cn('flex w-full flex-col gap-2', containerClassName)}>
      {label ? (
        <label htmlFor={inputId} className="text-sm font-medium text-secondary">
          {label}
          {required ? <span className="ml-1 text-muted">(required)</span> : null}
        </label>
      ) : null}

      <div className="relative">
        <input
          id={inputId}
          ref={ref}
          type={type}
          required={required}
          aria-invalid={errorMessage ? true : undefined}
          aria-errormessage={errorMessage ? errorId : undefined}
          aria-describedby={describedBy}
          className={cn(
            // 48px on touch, 40px from md up. The 16px font is what actually
            // stops iOS zooming on focus (docs/04 §5.3).
            'flex h-12 w-full rounded-control border bg-elevated px-3 text-base md:h-10 md:text-sm',
            'text-primary placeholder:text-muted',
            'border-control transition-colors duration-[--motion-duration-instant]',
            'hover:border-strong',
            'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
            'disabled:cursor-not-allowed disabled:opacity-45',
            'file:border-0 file:bg-transparent file:text-sm file:text-primary',
            mono && 'font-mono tracking-[0.02em]',
            errorMessage ? 'border-danger' : null,
            trailingSlot ? 'pr-10' : null,
            className,
          )}
          {...props}
        />
        {trailingSlot ? (
          <div className="absolute inset-y-0 right-0 flex items-center pr-1">{trailingSlot}</div>
        ) : null}
      </div>

      {helperText ? (
        <p id={helperId} className="text-xs text-secondary">
          {helperText}
        </p>
      ) : null}

      {errorMessage ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
});

export { Input };

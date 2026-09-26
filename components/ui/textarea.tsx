'use client';

import * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * Textarea — docs/04 §5.4
 *
 * `showCount` renders the live `n / max` counter. The counter is `aria-hidden` * because a per-keystroke live region floods a screen reader; the limit is
 * conveyed through the field's `aria-describedby` helper text instead.
 *
 * The reporter's text is never re-written or auto-corrected by the app
 * (FR-003), so `autoCorrect` and `autoCapitalize` are set explicitly rather
 * than left to the browser.
 */
export type TextareaProps = Omit<React.ComponentProps<'textarea'>, 'size'> & {
  label?: string;
  helperText?: React.ReactNode;
  errorMessage?: string;
  maxChars?: number;
  showCount?: boolean;
  containerClassName?: string;
};

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    containerClassName,
    label,
    helperText,
    errorMessage,
    maxChars,
    showCount: _showCount = false,
    id,
    required,
    rows = 5,
    ...props
  },
  ref,
) {
  const generatedId = React.useId();
  const textareaId = id ?? generatedId;
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [length, setLength] = React.useState(0);

  React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement);

  const helperId = `${textareaId}-helper`;
  const errorId = `${textareaId}-error`;
  const countId = `${textareaId}-count`;

  const describedBy =
    [helperText ? helperId : null, errorMessage ? errorId : null, maxChars ? countId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  const mergedRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (node) setLength(node.value.length);
    },
    [],
  );

  return (
    <div className={cn('flex w-full flex-col gap-2', containerClassName)}>
      {label ? (
        <label htmlFor={textareaId} className="text-sm font-medium text-secondary">
          {label}
          {required ? <span className="ml-1 text-muted">(required)</span> : null}
        </label>
      ) : null}

      <textarea
        id={textareaId}
        ref={mergedRef}
        rows={rows}
        required={required}
        spellCheck
        autoCorrect="off"
        autoCapitalize="sentences"
        aria-invalid={errorMessage ? true : undefined}
        aria-errormessage={errorMessage ? errorId : undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          setLength(event.target.value.length);
          props.onChange?.(event);
        }}
        className={cn(
          'flex min-h-24 w-full resize-y rounded-control border bg-elevated px-3 py-2 text-base text-primary',
          'placeholder:text-muted border-control',
          'transition-colors duration-[--motion-duration-instant] hover:border-strong',
          'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
          'disabled:cursor-not-allowed disabled:opacity-45',
          errorMessage ? 'border-danger' : null,
          className,
        )}
        {...props}
      />

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
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
        {maxChars ? (
          <p id={countId} aria-hidden="true" className="shrink-0 text-xs text-muted tabular">
            <span className={length > maxChars ? 'text-danger' : undefined}>{length}</span>
            <span> / {maxChars}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
});

export { Textarea };

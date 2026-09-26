'use client';

/**
 * ============================================================================
 * CareGrid AI — the auth form kit
 * ============================================================================
 *
 * `RevealableInput`, `PasswordStrength`, and `AuthErrorSummary`. Three small
 * pieces that every one of the four auth screens needs and that must behave
 * identically, because a password field that behaves differently on `/login`
 * and on `/signup` is a support ticket.
 *
 * ---------------------------------------------------------------------------
 * THE PASSWORD VISIBILITY TOGGLE
 * ---------------------------------------------------------------------------
 * An icon-only control needs an accessible name, so the toggle's label is
 * computed from the current state — "Show password" when hidden, "Hide password"
 * when shown. A static label would be wrong half the time, and a screen-reader
 * user pressing a button labelled "Show password" that is already showing it is
 * a genuinely confusing failure.
 *
 * It also carries `aria-pressed` and a live region announcing the change, because
 * the visual result is invisible to a screen-reader user: the input's type
 * changes, and nothing about that is announced by default.
 */

import * as React from 'react';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { InputProps } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { passwordSchema } from '@/validators/enums';

/* ========================================================================== */
/* RevealableInput                                                             */
/* ========================================================================== */

export function RevealableInput({
  value,
  onValueChange,
  label,
  autoComplete,
  errorMessage,
  helperText,
  id,
  required,
  disabled,
  ...props
}: Omit<InputProps, 'type' | 'value' | 'onChange' | 'trailingSlot' | 'id'> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Optional. A stable id is generated when absent, which is the common case. */
  id?: string;
}) {
  // `useId` FIRST, unconditionally. Calling it inside `id ?? React.useId()` looks
  // equivalent and is not: the short-circuit means the hook is skipped whenever
  // `id` is supplied, which is a rules-of-hooks violation and produces a real bug
  // the first time a caller passes an id on only one render.
  const generatedId = React.useId();
  const [revealed, setRevealed] = React.useState(false);
  const inputId = id ?? generatedId;

  const toggleLabel = revealed ? 'Hide the password' : 'Show the password';

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-sm font-medium text-secondary">
        {label}
        {required ? <span className="ml-1 text-muted">(required)</span> : null}
      </label>

      <div className="relative">
        <input
          id={inputId}
          // `password` and `text` are the only two values. Never `search` or
          // `email` — a password manager keys off the type.
          type={revealed ? 'text' : 'password'}
          value={value}
          required={required}
          disabled={disabled}
          autoComplete={autoComplete}
          aria-invalid={errorMessage ? true : undefined}
          aria-describedby={errorMessage ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined}
          onChange={(event) => onValueChange(event.target.value)}
          className={cn(
            // 48px on touch, 40px from md. 16px font prevents iOS zoom on focus,
            // which in a one-handed emergency flow is a real failure, not a
            // cosmetic one (docs/04 §5.3).
            'flex h-12 w-full rounded-control border border-control bg-elevated px-3 pr-12 text-base md:h-10 md:text-sm',
            'text-primary placeholder:text-muted',
            'transition-colors duration-[--motion-duration-instant] hover:border-strong',
            'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
            'disabled:cursor-not-allowed disabled:opacity-45',
            errorMessage && 'border-danger',
          )}
          {...props}
        />

        <div className="absolute inset-y-0 right-0 flex items-center pr-1">
          <IconButton
            label={toggleLabel}
            icon={revealed ? EyeOff : Eye}
            size="sm"
            onClick={() => setRevealed((previous) => !previous)}
            // The input's own type changed, which is invisible to a screen
            // reader unless something says so.
            aria-pressed={revealed}
            aria-controls={inputId}
            className="min-h-8 min-w-8"
            disabled={disabled}
          />
        </div>
      </div>

      {/* Announces the change, because the visual result is not perceivable. */}
      <span role="status" aria-live="polite" className="sr-only">
        {revealed ? 'Password is now visible.' : 'Password is now hidden.'}
      </span>

      {helperText && !errorMessage ? (
        <p id={`${inputId}-helper`} className="text-xs text-secondary">
          {helperText}
        </p>
      ) : null}
      {errorMessage ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-danger">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* PasswordStrength                                                            */
/* ========================================================================== */

/**
 * A four-point strength meter with the rules written out.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RULES ARE WRITTEN, NOT JUST A BAR
 * ---------------------------------------------------------------------------
 * A bar on its own tells a person they are "not strong enough" without saying
 * why, and the most common fix is a longer-but-still-weak password. Naming the
 * unmet rule turns it into a task. A strength bar with no explanation is a
 * judgement; a checklist is an instruction.
 *
 * The checks are the CLIENT's (from `validators/me.ts`) so they run per
 * keystroke with no round trip. Firebase's `validatePassword` remains the
 * authority and its message wins if the two disagree.
 */
export function PasswordStrength({ password }: { password: string }) {
  const checks = React.useMemo(() => {
    const parsed = passwordSchema.safeParse(password);
    return [
      { label: 'At least 8 characters', met: password.length >= 8 },
      { label: 'Includes a number', met: /\d/.test(password) },
      { label: 'Not only letters', met: /[^A-Za-z0-9]/.test(password) },
      { label: 'Long enough to be hard to guess', met: parsed.success },
    ];
  }, [password]);

  if (password === '') return null;

  const met = checks.filter((check) => check.met).length;
  const tone =
    met <= 1 ? 'text-danger' : met === 2 ? 'text-warning' : met === 3 ? 'text-info' : 'text-success';
  const word = met <= 1 ? 'Weak' : met === 2 ? 'Fair' : met === 3 ? 'Good' : 'Strong';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div
          className="h-1 flex-1 overflow-hidden rounded-pill bg-inset"
          role="meter"
          aria-valuenow={met}
          aria-valuemin={0}
          aria-valuemax={4}
          aria-label={`Password strength: ${word}`}
          aria-valuetext={`${word} — ${met} of 4 checks met`}
        >
          <div
            className={cn('h-full rounded-pill transition-[width] duration-[--motion-duration-base] motion-reduce:transition-none', tone)}
            style={{ width: `${(met / 4) * 100}%` }}
          />
        </div>
        {/* Colour is never the only channel: the word is always present. */}
        <span className={cn('shrink-0 text-xs font-semibold', tone)}>{word}</span>
      </div>

      <ul className="flex flex-col gap-1">
        {checks.map((check) => (
          <li
            key={check.label}
            className={cn('flex items-center gap-1.5 text-xs', check.met ? 'text-success' : 'text-secondary')}
          >
            <span aria-hidden="true" className="text-[10px]">
              {check.met ? '●' : '○'}
            </span>
            <span>
              <span className="sr-only">{check.met ? 'Met: ' : 'Not met: '}</span>
              {check.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ========================================================================== */
/* AuthErrorSummary                                                            */
/* ========================================================================== */

/**
 * The error block at the top of a form.
 *
 * ---------------------------------------------------------------------------
 * IT TAKES FOCUS WHEN IT APPEARS
 * ---------------------------------------------------------------------------
 * An `aria-live` region is not announced if it exists before the text arrives in
 * some screen-reader/browser combinations, and a person who pressed "Sign in" and
 * heard nothing has no idea whether it worked. Moving focus to the summary makes
 * the outcome unavoidable. The focus moves to the CONTAINER, not the button, so
 * the submit control is not re-focused and re-triggered.
 *
 * `role="alert"` rather than `role="status"`: the person has taken an action and
 * needs to know it did not work, which is the definition of an alert.
 */
export function AuthErrorSummary({
  title,
  message,
  onRetry,
  retryLabel = 'Try again',
  className,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const isNew = React.useRef(true);

  React.useEffect(() => {
    if (!isNew.current) return;
    isNew.current = false;
    ref.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className={cn('rounded-card focus-visible:outline-none', className)}
    >
      <Alert tone="danger">
        <AlertIcon />
        <div className="min-w-0 flex-1">
          {title ? <AlertTitle>{title}</AlertTitle> : null}
          <AlertDescription>{message}</AlertDescription>
        </div>
        {onRetry ? (
          <div className="shrink-0 self-center">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-control px-2 py-1 text-xs font-medium text-danger-fg-muted underline underline-offset-4 hover:opacity-80 focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus"
            >
              {retryLabel}
            </button>
          </div>
        ) : null}
      </Alert>
    </div>
  );
}

function AlertIcon() {
  return <AlertCircle className="mt-px size-icon-md shrink-0" aria-hidden="true" />;
}

/* ========================================================================== */
/* Field-level error helper                                                   */
/* ========================================================================== */

/**
 * The message to show under a field, from either the Zod issue or the
 * `AuthError.field` classification.
 *
 * The submitted state matters: showing "Enter your email" before the person has
 * pressed anything is the most common way a form becomes noise. So the caller
 * only asks for a message once it has been submitted or the field has been
 * blurred.
 */
export function fieldError(options: {
  submitted: boolean;
  touched: boolean;
  zodIssue?: string | undefined;
  serverIssue?: string | null | undefined;
}): string | undefined {
  if (!options.submitted && !options.touched) return undefined;
  return options.zodIssue ?? options.serverIssue ?? undefined;
}

'use client';

import * as React from 'react';
import Link from 'next/link';
import { MailCheck } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle, Button, Input } from '@/components/ui';
import { AuthErrorSummary, RevealableInput, fieldError } from '@/components/auth/auth-form-kit';
import { AuthError, confirmNewPassword, resetPassword } from '@/lib/firebase/auth';
import { emailSchema } from '@/validators/enums';

/**
 * ============================================================================
 * /forgot-password — CONNECTED TO FIREBASE AUTH
 *
 * /login?mode=reset&oobCode=… — the reset completion half of the flow.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * THE RESPONSE IS IDENTICAL IN BOTH CASES, AND IT MUST STAY THAT WAY
 * ---------------------------------------------------------------------------
 * Whether or not the address has an account, the screen says: "If that address
 * has an account, a reset link is on its way." Firebase's
 * `sendPasswordResetEmail` already returns success for an unknown address, and
 * `resetPassword()` swallows `auth/user-not-found` for the same reason.
 *
 * Anything else — a distinct message, a different delay, a redirect to a
 * "that account does not exist" page — turns this form into an account-existence
 * oracle. That is a privacy failure for a product where someone may be asking
 * whether their neighbour is a CareGrid user.
 *
 * ---------------------------------------------------------------------------
 * WHY RESET IS A CLIENT-ONLY FLOW
 * ---------------------------------------------------------------------------
 * `confirmPasswordReset` is called with the one-time `oobCode` from the email
 * link. The server is not involved and cannot be: the code has not been exchanged
 * for anything at this point, and it carries no role information. docs/10 §3.4
 * step 4 records that a reset changes no authorisation state.
 */

const SENT_COPY =
  'If that address has an account, a reset link is on its way. The link expires in one hour.';

type Phase = 'idle' | 'loading' | 'sent';

/**
 * Chooses between the two halves of the flow.
 *
 * The mode arrives as a PROP from the page, which read the query string in a
 * Server Component. Reading it with `useSearchParams()` here would opt this
 * subtree out of server rendering, leaving the initial HTML with no form in it.
 *
 * The two halves are separate COMPONENTS, not a conditional: whichever one
 * renders is then the only one whose hooks are ever called. Branching inside a
 * single component would put `useState` after an early return, which is a
 * rules-of-hooks violation and produces a real bug when the mode changes without
 * a navigation — React keeps the same element instance, so a hook count that
 * changes is undefined behaviour.
 *
 * `key` forces a remount if the mode does change, so neither half's state is
 * ever carried across from the other.
 */
export function ForgotPasswordForm({
  isResetMode = false,
  oobCode = null,
}: {
  isResetMode?: boolean;
  oobCode?: string | null;
}) {
  return isResetMode && oobCode !== null ? (
    <CompleteResetForm key={oobCode} oobCode={oobCode} />
  ) : (
    <RequestResetForm key="request" />
  );
}

/* ========================================================================== */
/* Request a reset                                                            */
/* ========================================================================== */

function RequestResetForm() {
  const [email, setEmail] = React.useState('');
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setTouched(true);
      return;
    }

    setPhase('loading');
    try {
      await resetPassword(parsed.data);
      setPhase('sent');
    } catch (caught) {
      // A real failure — a rate limit, a network problem, Firebase down — gets
      // an honest message. The account-existence question is still not answered.
      setError(
        caught instanceof AuthError
          ? caught.message
          : 'We could not send the reset email. Try again in a moment.',
      );
      setPhase('idle');
    }
  };

  if (phase === 'sent') {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success" role="status">
          <MailCheck className="mt-px size-icon-md shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1">
            <AlertTitle>Check your email</AlertTitle>
            <AlertDescription>{SENT_COPY}</AlertDescription>
          </div>
        </Alert>
        <Button
          type="button"
          variant="outline"
          onClick={() => setPhase('idle')}
          className="w-full"
        >
          Use a different address
        </Button>
        <p className="text-center text-sm text-secondary">
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center text-accent underline-offset-4 hover:underline focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
      {error ? <AuthErrorSummary title="We could not send that email" message={error} /> : null}

      <p className="text-sm text-secondary">We will email you a link to set a new password.</p>

      <Input
        id="reset-email"
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        value={email}
        placeholder="you@example.com"
        onChange={(event) => setEmail(event.target.value)}
        onBlur={() => setTouched(true)}
        errorMessage={fieldError({
          submitted: touched,
          touched,
          zodIssue: touched && !emailSchema.safeParse(email).success
            ? emailSchema.safeParse(email).error?.issues[0]?.message
            : undefined,
        })}
      />

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={phase === 'loading'}>
        Send reset link
      </Button>

      <p className="text-center text-sm text-secondary">
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center text-accent underline-offset-4 hover:underline focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
        >
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

/* ========================================================================== */
/* Complete a reset                                                            */
/* ========================================================================== */

function CompleteResetForm({ oobCode }: { oobCode: string }) {
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (password.length < 8 || !/\d/.test(password)) {
      setError('Choose a stronger password: at least 8 characters, including a number.');
      return;
    }
    if (password !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await confirmNewPassword(oobCode, password);
      setDone(true);
    } catch (caught) {
      // The most common real failure: the link was already used, or it expired.
      // Both are one sentence, because the remedy is the same — request a new
      // link.
      setError(
        caught instanceof AuthError
          ? caught.message
          : 'That reset link is no longer valid. Request a new one.',
      );
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success" role="status">
          <MailCheck className="mt-px size-icon-md shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1">
            <AlertTitle>Your password has been changed</AlertTitle>
            <AlertDescription>
              Sign in with your new password. Any other sessions you had open may need to sign in
              again.
            </AlertDescription>
          </div>
        </Alert>
        <Button asChild variant="primary" size="lg" className="w-full">
          <a href="/login">Go to sign in</a>
        </Button>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
      {error ? <AuthErrorSummary title="We could not change your password" message={error} /> : null}

      <p className="text-sm text-secondary">Choose a new password.</p>

      <RevealableInput
        id="new-password"
        label="New password"
        autoComplete="new-password"
        required
        value={password}
        onValueChange={setPassword}
        helperText="At least 8 characters, including one number."
      />

      <RevealableInput
        id="new-password-confirm"
        label="Confirm new password"
        autoComplete="new-password"
        required
        value={confirmPassword}
        onValueChange={setConfirmPassword}
      />

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
        Change password
      </Button>
    </form>
  );
}

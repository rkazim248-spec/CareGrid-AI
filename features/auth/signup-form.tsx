'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle, Button, CheckboxField, Input } from '@/components/ui';
import {
  AuthErrorSummary,
  PasswordStrength,
  RevealableInput,
  fieldError,
} from '@/components/auth/auth-form-kit';
import { AuthError, signUp, signInWithGoogle } from '@/lib/firebase/auth';
import { signUpFormSchema } from '@/validators/me';
import { APP_TIMEZONE } from '@/lib/format';
import { GoogleMark } from '@/features/auth/google-mark';

/**
 * ============================================================================
 * /signup — CONNECTED TO FIREBASE AUTH
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO ROLE PICKER, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * `POST /api/me/bootstrap` writes `role: 'citizen'` on the server. The form has
 * no role field, the Zod schema declares `role` as `z.literal('citizen')` so it
 * literally cannot submit anything else, and `firestore.rules` sets
 * `users: allow write: if false`. Three independent blocks — the strongest of
 * which is the last, because it does not depend on any application code being
 * correct.
 *
 * A `responder` additionally needs `responders/{uid}.verification = 'verified'`,
 * set by an admin (FR-063/FR-064). Offering the role here would put an unvouched
 * person into the candidate list, which is the one list where being wrong sends
 * a stranger to an emergency.
 *
 * ---------------------------------------------------------------------------
 * THE PASSWORD CONFIRMATION NEVER LEAVES THE BROWSER
 * ---------------------------------------------------------------------------
 * It is a UI affordance for catching a typo. Sending a second copy of a password
 * to a server buys nothing, so `signUpFormSchema` is a CLIENT schema and the
 * server receives only `{ displayName, timezone, locale }`.
 */

const PASSWORD_MIN = 8;

type FieldErrors = {
  displayName?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  acceptedDemoNotice?: string;
};

export function SignupForm() {
  const router = useRouter();

  const [displayName, setDisplayName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [accepted, setAccepted] = React.useState(false);

  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSubmitted(true);
      setFormError(null);

      const parsed = signUpFormSchema.safeParse({
        displayName,
        email,
        password,
        confirmPassword,
        role: 'citizen',
        acceptedDemoNotice: accepted,
      });

      if (!parsed.success) {
        const next: FieldErrors = {};
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? 'form');
          if (next[key as keyof FieldErrors] === undefined) {
            next[key as keyof FieldErrors] = issue.message;
          }
        }
        setErrors(next);
        return;
      }

      setErrors({});
      setLoading(true);

      try {
        await signUp({
          email: parsed.data.email,
          password: parsed.data.password,
          displayName: parsed.data.displayName,
        });

        // The Firebase user now exists. `SessionProvider` observes the auth
        // change, finds no `users/{uid}` document, and bootstraps it. So there
        // is nothing to do here except wait — navigating now would race the
        // bootstrap and land on a page with no role yet.
        //
        // The `?` keeps the query string if one was present on /signup.
        router.replace('/dashboard');
      } catch (error) {
        if (error instanceof AuthError) {
          if (error.field !== 'form') {
            setErrors({ [error.field]: error.message });
          } else {
            setFormError(error.message);
          }
        } else {
          setFormError('We could not create your account. Try again in a moment.');
        }
      } finally {
        setLoading(false);
      }
    },
    [displayName, email, password, confirmPassword, accepted, router],
  );

  const handleGoogle = React.useCallback(async () => {
    setFormError(null);
    setLoading(true);
    try {
      const result = await signInWithGoogle();
      if (result === null) return;
      router.replace('/dashboard');
    } catch (error) {
      setFormError(error instanceof AuthError ? error.message : 'We could not sign you in.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  const failureCount = Object.keys(errors).length;

  return (
    <form noValidate onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
      {formError ? <AuthErrorSummary title="We could not create your account" message={formError} /> : null}

      {failureCount > 0 && submitted ? (
        <AuthErrorSummary
          title="Check these before sending"
          message={
            failureCount === 1
              ? 'One field needs attention.'
              : `${failureCount} fields need attention.`
          }
        />
      ) : null}

      <Input
        id="signup-name"
        label="Full name"
        autoComplete="name"
        required
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        onBlur={() => setTouched((t) => ({ ...t, displayName: true }))}
        errorMessage={fieldError({
          submitted,
          touched: touched.displayName ?? false,
          zodIssue: errors.displayName,
        })}
        helperText="Dispatchers and the assigned responder never see your name."
      />

      <Input
        id="signup-email"
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
        onBlur={() => setTouched((t) => ({ ...t, email: true }))}
        errorMessage={fieldError({
          submitted,
          touched: touched.email ?? false,
          zodIssue: errors.email,
        })}
        helperText="Every new account is created as a citizen. An administrator can change a role later."
      />

      <div className="flex flex-col gap-3">
        <RevealableInput
          id="signup-password"
          label="Password"
          autoComplete="new-password"
          required
          value={password}
          onValueChange={setPassword}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))}
          errorMessage={fieldError({
            submitted,
            touched: touched.password ?? false,
            zodIssue: errors.password,
          })}
          helperText={`At least ${PASSWORD_MIN} characters, including one number.`}
        />
        <PasswordStrength password={password} />
      </div>

      <RevealableInput
        id="signup-confirm"
        label="Confirm password"
        autoComplete="new-password"
        required
        value={confirmPassword}
        onValueChange={setConfirmPassword}
        onBlur={() => setTouched((t) => ({ ...t, confirmPassword: true }))}
        errorMessage={fieldError({
          submitted,
          touched: touched.confirmPassword ?? false,
          zodIssue: errors.confirmPassword,
        })}
      />

      <Alert tone="info">
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>What happens to a report</AlertTitle>
          <AlertDescription>
            Your report text, any photos, and an approximate location are shown to dispatchers and
            to the responder assigned to it. Responders never see your name.
          </AlertDescription>
        </div>
      </Alert>

      <div className="flex flex-col gap-1.5">
        <CheckboxField
          id="signup-consent"
          checked={accepted}
          onCheckedChange={(checked) => setAccepted(checked === true)}
          label="I understand CareGrid AI does not replace emergency services."
        />
        {fieldError({
          submitted,
          touched: false,
          zodIssue: errors.acceptedDemoNotice,
        }) ? (
          <p role="alert" className="text-xs text-danger">
            {errors.acceptedDemoNotice}
          </p>
        ) : null}
      </div>

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
        <UserPlus className="size-4" aria-hidden="true" />
        Create account
      </Button>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-subtle" aria-hidden="true" />
        <span className="shrink-0 text-xs text-muted">or</span>
        <span className="h-px flex-1 bg-subtle" aria-hidden="true" />
      </div>

      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full"
        loading={loading}
        onClick={() => void handleGoogle()}
      >
        <GoogleMark className="size-4" />
        Continue with Google
      </Button>

      <p className="text-center text-sm text-secondary">
        Already registered?{' '}
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center text-accent underline-offset-4 hover:underline focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
        >
          Sign in
        </Link>
      </p>

      {/* The timezone a new account is bootstrapped with. Visible because it is a
          real stored value, not a hidden default the user cannot find later. */}
      <p className="sr-only">Your account timezone will be set to {APP_TIMEZONE}.</p>
    </form>
  );
}

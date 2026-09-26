'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { LogIn } from 'lucide-react';

import { Button, Input, Separator } from '@/components/ui';
import {
  AuthErrorSummary,
  RevealableInput,
  fieldError,
} from '@/components/auth/auth-form-kit';
import { GoogleMark } from '@/features/auth/google-mark';
import { AuthError, signIn, signInWithGoogle } from '@/lib/firebase/auth';
import { authEvent } from '@/lib/api/client';
import { useSession } from '@/components/providers/session-provider';
import { signInFormSchema } from '@/validators/me';
import { landingFor } from '@/lib/auth/roles';
import { sanitiseNextPath } from '@/validators/me';
import type { UserRole } from '@/types/enums';

/**
 * ============================================================================
 * /login — CONNECTED TO FIREBASE AUTH
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * THE ONE PROPERTY THIS SCREEN MUST NOT BREAK
 * ---------------------------------------------------------------------------
 * It is not an account-existence oracle. Firebase returns the same
 * `auth/invalid-credential` for a wrong password and for an address with no
 * account, and every failure path here renders the SAME sentence. A "no account
 * found with this email" message would let anyone test whether a person uses the
 * service — which for a platform where a member may be reporting an emergency
 * they do not want traced to them is a real privacy failure, not a UX nicety.
 *
 * docs/04 §13.4's copy is therefore kept verbatim, and the mapper in
 * `lib/firebase/auth.ts` is what produces it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE USER GOES AFTERWARDS
 * ---------------------------------------------------------------------------
 * `/login?next=…` when the path is safe (see `sanitiseNextPath` for the
 * open-redirect rules), otherwise the ROLE landing route. A citizen lands on
 * `/report`, not on a dispatcher console they have no permission to use.
 *
 * `SessionProvider` observes the auth change and loads `/api/me`; this form does
 * not fetch anything itself. One owner of the session, not two.
 */

/** Phase 1's copy, kept verbatim so the docs and the screen agree. */
export const LOGIN_FAILED_COPY =
  'That email and password combination did not work, or the account is not available.';

type FieldErrors = { email?: string; password?: string; form?: string };

/**
 * `nextPath` is a PROP, not `useSearchParams()`.
 *
 * The page (a Server Component) reads `?next=` and sanitises it, then passes it
 * down. Reading it here would opt the whole form out of server rendering, so the
 * initial HTML would contain no form at all — a real failure on a slow
 * connection, and one that looks like a working page to anyone viewing source.
 *
 * The `nextPath` is already through `sanitiseNextPath`, but the prop is
 * re-checked below because a component should not have to trust that it was
 * called from the one place that sanitises.
 */
export function LoginForm({ nextPath: rawNext = null }: { nextPath?: string | null }) {
  const router = useRouter();
  const { authStatus, role } = useSession();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [touched, setTouched] = React.useState<{ email?: boolean; password?: boolean }>({});
  const [submitted, setSubmitted] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // A signed-in person who opens /login is shown where they would go, rather
  // than a form that would immediately fail (docs/05 §8.5).
  const alreadySignedIn = authStatus === 'signed-in';

  const nextPath = sanitiseNextPath(rawNext);

  React.useEffect(() => {
    if (!alreadySignedIn || role === null) return;
    const destination = (nextPath ?? landingFor(role)) as Route;
    router.replace(destination);
  }, [alreadySignedIn, role, nextPath, router]);

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSubmitted(true);
      setFormError(null);

      const parsed = signInFormSchema.safeParse({ email, password });
      if (!parsed.success) {
        const next: FieldErrors = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path[0] === 'email' ? 'email' : 'password';
          if (next[key] === undefined) next[key] = issue.message;
        }
        setErrors(next);
        return;
      }

      setErrors({});
      setLoading(true);

      try {
        await signIn({ email: parsed.data.email, password: parsed.data.password });
        // The session provider takes over from here. Navigating immediately
        // would race the `/api/me` fetch and land on a page that has no role yet.
      } catch (error) {
        if (error instanceof AuthError) {
          // Per-field errors go under the input; everything else is the neutral
          // summary sentence.
          if (error.field === 'email' || error.field === 'password') {
            setErrors({ [error.field]: error.message });
          } else {
            setFormError(error.message);
          }

          if (error.code === 'AUTH_INVALID_CREDENTIAL') {
            // Best-effort audit of the failed attempt (FR-135). It must not
            // delay or block the error message, so it is not awaited.
            void authEvent({
              type: 'login_failed',
              provider: 'password',
              reason: 'INVALID_PASSWORD',
            });
          }
        } else {
          setFormError(LOGIN_FAILED_COPY);
        }
      } finally {
        setLoading(false);
      }
    },
    [email, password],
  );

  const handleGoogle = React.useCallback(async () => {
    setFormError(null);
    setLoading(true);
    try {
      const result = await signInWithGoogle();
      // `null` means the person closed the picker. Not an error; leave the form
      // exactly as it was.
      if (result === null) return;
    } catch (error) {
      setFormError(error instanceof AuthError ? error.message : LOGIN_FAILED_COPY);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <form noValidate onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
      {formError ? (
        <AuthErrorSummary title="We could not sign you in" message={formError} />
      ) : null}

      <Input
        id="login-email"
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
      />

      <RevealableInput
        id="login-password"
        label="Password"
        autoComplete="current-password"
        required
        value={password}
        onValueChange={setPassword}
        errorMessage={fieldError({
          submitted,
          touched: touched.password ?? false,
          zodIssue: errors.password,
        })}
        onBlur={() => setTouched((t) => ({ ...t, password: true }))}
      />

      <div className="flex items-center justify-end">
        <Link
          href="/forgot-password"
          className="-mr-1 inline-flex min-h-11 items-center px-1 text-sm text-accent underline-offset-4 hover:underline focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
        >
          Forgot password
        </Link>
      </div>

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
        <LogIn className="size-4" aria-hidden="true" />
        Sign in
      </Button>

      <div className="flex items-center gap-3">
        <Separator />
        <span className="shrink-0 text-xs text-muted">or</span>
        <Separator />
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
        New here?{' '}
        <Link
          href="/signup"
          className="inline-flex min-h-11 items-center text-accent underline-offset-4 hover:underline focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}

/** Re-exported so `/forgot-password` can use the same rule for its redirect. */
export { sanitiseNextPath };
export type { UserRole };

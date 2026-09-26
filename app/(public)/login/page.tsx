import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthShell } from '@/features/auth/auth-shell';
import { LoginForm } from '@/features/auth/login-form';
import { LoginFormSkeleton } from '@/features/auth/auth-form-skeleton';
import { sanitiseNextPath } from '@/validators/me';

export const metadata: Metadata = {
  title: 'Sign in',
  description:
    'Sign in to CareGrid AI to report a community incident, track a report, or review assigned work.',
};

/**
 * /login
 *
 * ---------------------------------------------------------------------------
 * WHY `searchParams` IS READ HERE AND NOT WITH `useSearchParams`
 * ---------------------------------------------------------------------------
 * In Next 15 a page receives `searchParams` as a PROMISE, and reading it in a
 * Server Component keeps the whole subtree server-rendered. Reading it with
 * `useSearchParams()` in a Client Component opts that subtree out of SSR
 * entirely — the form is then absent from the initial HTML and appears only
 * after hydration, which is exactly the state a slow connection or a
 * "View source" inspection reveals.
 *
 * The `Suspense` boundary is kept as a safety net for a client-side navigation
 * into this route, and it costs nothing on the server render.
 *
 * ---------------------------------------------------------------------------
 * WHY `next` IS SANITISED ON THE SERVER
 * ---------------------------------------------------------------------------
 * `?next=` is attacker-controlled. `sanitiseNextPath` rejects `https://evil…`,
 * `//evil…` (protocol-relative), `/\evil…` (which browsers normalise to `//`),
 * and control characters. Unvalidated, the sign-in form becomes a phishing tool:
 * sign in, get redirected to a convincing copy of the login page elsewhere, retype
 * the password.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;

  return (
    <AuthShell
      title="Sign in"
      description="Report an incident, follow its progress, or pick up an assignment."
      width="max-w-[400px]"
    >
      <Suspense fallback={<LoginFormSkeleton />}>
        <LoginForm nextPath={sanitiseNextPath(rawNext)} />
      </Suspense>
    </AuthShell>
  );
}

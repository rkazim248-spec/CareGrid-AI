import { AuthShell } from '@/features/auth/auth-shell';
import { LoginFormSkeleton } from '@/features/auth/auth-form-skeleton';

/**
 * Route-level loading state for /login.
 *
 * The form is client-rendered behind a `Suspense` boundary because it reads
 * `?next=` / `?mode=` from the query string. This file is what a person sees
 * during a client-side navigation into the route, so the form does not appear
 * in a different position than the page it replaces.
 */
export default function Loading() {
  return (
    <AuthShell title="Sign in" description="Report an incident, follow its progress, or pick up an assignment." width="max-w-[400px]">
      <LoginFormSkeleton />
    </AuthShell>
  );
}
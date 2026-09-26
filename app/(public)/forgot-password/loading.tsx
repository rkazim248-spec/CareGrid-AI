import { AuthShell } from '@/features/auth/auth-shell';
import { ForgotPasswordFormSkeleton } from '@/features/auth/auth-form-skeleton';

/**
 * Route-level loading state for /forgot-password.
 *
 * The form is client-rendered behind a `Suspense` boundary because it reads
 * `?next=` / `?mode=` from the query string. This file is what a person sees
 * during a client-side navigation into the route, so the form does not appear
 * in a different position than the page it replaces.
 */
export default function Loading() {
  return (
    <AuthShell title="Reset your password" description="We will email you a link to set a new password." width="max-w-[400px]">
      <ForgotPasswordFormSkeleton />
    </AuthShell>
  );
}
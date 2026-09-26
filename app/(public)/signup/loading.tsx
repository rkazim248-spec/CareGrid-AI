import { AuthShell } from '@/features/auth/auth-shell';
import { SignupFormSkeleton } from '@/features/auth/auth-form-skeleton';

/**
 * Route-level loading state for `/signup`.
 *
 * The form itself server-renders (it reads no search params), so this shows
 * during a client-side navigation into the route rather than on first load. It
 * still matters: without it, navigating from `/` to `/signup` would leave the
 * previous page's scroll position and focus while the new form mounted, which
 * for a form with a password field means a person starts typing into nothing.
 */
export default function Loading() {
  return (
    <AuthShell
      title="Create an account"
      description="Report an incident, follow its progress, or volunteer as a responder."
      width="max-w-[440px]"
    >
      <SignupFormSkeleton />
    </AuthShell>
  );
}

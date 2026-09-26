import type { Metadata } from 'next';

import { AuthShell } from '@/features/auth/auth-shell';
import { SignupForm } from '@/features/auth/signup-form';

export const metadata: Metadata = {
  title: 'Create an account',
  description:
    'Create a CareGrid AI account to report a community incident and follow its progress.',
};

/**
 * /signup
 *
 * No `<Suspense>` is needed here: `SignupForm` reads no search params, so it
 * server-renders fully and the form is in the initial HTML. That matters more
 * than it looks — a sign-up form that only exists after hydration is a form
 * that fails for anyone on a slow connection or with JavaScript still loading.
 */
export default function Page() {
  return (
    <AuthShell
      title="Create an account"
      description="Report an incident, follow its progress, or volunteer as a responder."
      width="max-w-[440px]"
    >
      <SignupForm />
    </AuthShell>
  );
}

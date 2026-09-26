import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthShell } from '@/features/auth/auth-shell';
import { ForgotPasswordForm } from '@/features/auth/forgot-password-form';
import { ForgotPasswordFormSkeleton } from '@/features/auth/auth-form-skeleton';

export const metadata: Metadata = {
  title: 'Reset your password',
  description:
    'Request a CareGrid AI password reset link. The response is the same whether or not an account exists.',
};

/**
 * /forgot-password
 *
 * TWO modes in one route, selected by the query string:
 *   - default                  → request a reset link
 *   - `?mode=reset&oobCode=…`   → set a new password, from the email link
 *
 * The query is read HERE, in the Server Component, and passed down as a prop.
 * `useSearchParams()` inside the form would opt the subtree out of server
 * rendering, so the initial HTML would be an empty shell.
 *
 * `oobCode` is a single-use, time-limited code from Firebase. It carries no role
 * information, and the server is not involved in completing the reset
 * (docs/10 §3.4 step 4) — which is why a reset changes no authorisation state.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string | string[]; oobCode?: string | string[] }>;
}) {
  const params = await searchParams;
  const mode = Array.isArray(params.mode) ? params.mode[0] : params.mode;
  const oobCode = Array.isArray(params.oobCode) ? params.oobCode[0] : params.oobCode;

  const isResetMode = mode === 'reset' && typeof oobCode === 'string' && oobCode !== '';

  return (
    <AuthShell
      title="Reset your password"
      description="We will email you a link to set a new password."
      width="max-w-[400px]"
    >
      <Suspense fallback={<ForgotPasswordFormSkeleton />}>
        <ForgotPasswordForm isResetMode={isResetMode} oobCode={isResetMode ? oobCode : null} />
      </Suspense>
    </AuthShell>
  );
}

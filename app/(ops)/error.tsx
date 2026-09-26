'use client';

import { ErrorState, ERROR_COPY } from '@/components/feedback';
/**
 * Per-group error boundary for the admin routes. Renders in place inside the
 * shell, so the navigation and the user's context survive a failed fetch —
 * being thrown to a full-page error would lose the place they were.
 */
export default function AdminGroupError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorState
      title={ERROR_COPY.readFailed.title}
      description={ERROR_COPY.readFailed.description}
      code={error.digest}
      onRetry={reset}
      retryLabel="Try again"
      secondaryAction={{ label: 'Go to the admin overview' }}
    />
  );
}

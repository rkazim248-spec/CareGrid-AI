'use client';

import { ErrorState } from '@/components/feedback';

/**
 * `(auth)` error boundary — docs/04 §13.22.
 *
 * `error.message` is NEVER rendered: it can contain internals. Only `digest` is
 * shown, in mono, so a report can be correlated (docs/04 §5.23).
 *
 * The group layout already provides `<main>`, so this boundary contributes the
 * single `<h1>` and nothing else.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-5 py-10 sm:px-6">
      <h1 className="text-2xl leading-tight font-bold text-primary">Something went wrong</h1>
      <p className="max-w-[72ch] text-sm text-secondary">
        The page could not be loaded. Nothing has been sent or changed.
      </p>
      <ErrorState
        title="We could not load this report"
        description="The page could not be loaded. Your session is still active."
        onRetry={reset}
        retryLabel="Try again"
        secondaryAction={{ label: 'Look up another report', href: '/track' }}
      />
      {error.digest ? (
        <p className="font-mono text-xs text-muted">Reference {error.digest}</p>
      ) : null}
    </div>
  );
}

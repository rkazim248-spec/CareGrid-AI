'use client';

import * as React from 'react';
import { RefreshCw, LayoutDashboard } from 'lucide-react';

import { ErrorState, ERROR_COPY } from '@/components/feedback';
import { Button } from '@/components/ui/button';

/**
 * Root error boundary — docs/04 §13.22.
 *
 * `error.message` is NEVER rendered directly. It can contain an internal string,
 * a Firestore path, or a fragment of a rule name. Only `digest` is shown, in
 * mono, so it can be matched to a server log.
 *
 * "Report this problem" copies a pre-filled string with the reference, the
 * route, and the time — no stack trace, no user data.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [reported, setReported] = React.useState(false);

  const reportText = [
    'CareGrid AI — problem report',
    `Reference: ${error.digest ?? 'unavailable'}`,
    `Route: ${typeof window === 'undefined' ? 'unknown' : window.location.pathname}`,
    `When: ${new Date().toISOString()}`,
  ].join('\n');

  const copyReport = React.useCallback(() => {
    void navigator.clipboard
      ?.writeText(reportText)
      .then(() => {
        setReported(true);
        setTimeout(() => setReported(false), 3000);
      })
      .catch(() => setReported(false));
  }, [reportText]);

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center px-4">
      <ErrorState
        title={ERROR_COPY.generic.title}
        description={ERROR_COPY.generic.description}
        code={error.digest}
      />
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button variant="secondary" onClick={reset}>
          <RefreshCw className="size-4" aria-hidden="true" />
          Try again
        </Button>
        <Button variant="ghost" asChild>
          <a href="/dashboard">
            <LayoutDashboard className="size-4" aria-hidden="true" />
            Go to dashboard
          </a>
        </Button>
        <Button variant="link" onClick={copyReport}>
          {reported ? 'Report copied' : 'Report this problem'}
        </Button>
      </div>
    </main>
  );
}

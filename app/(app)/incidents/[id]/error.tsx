'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { ErrorState, ERROR_COPY } from '@/components/feedback';

/**
 * `/incidents/[id]` error boundary — docs/04 §9.3, §13.22.
 *
 * `error` arrives as `unknown`, so it is narrowed before anything is read from
 * it, and even then only its own message is used. `ErrorState` deliberately
 * refuses to render a stack trace, an internal string, or a Firestore path, so
 * this boundary passes a catalogue `code` rather than the raw error object.
 *
 * The copy is `ERROR_COPY.generic`, verbatim from the table, including the "your
 * session is still active" reassurance — a person who has just lost their place
 * in an incident needs to know they have not been signed out.
 *
 * The component is named `RouteError`, not `Error`, because a local `Error`
 * binding shadows the global constructor and makes `error instanceof Error`
 * resolve to a component type instead of narrowing anything.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: unknown;
  reset: () => void;
}) {
  useEffect(() => {
    // `console.error` is the only sanctioned console call in app code; from
    // Phase 6 it is replaced by lib/server/logging on the server.
    if (error instanceof Error) {
      console.error('incident detail route failed', error.message);
    }
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <ErrorState
        title={ERROR_COPY.generic.title}
        description={ERROR_COPY.generic.description}
        code="INCIDENT_LOAD_FAILED"
        onRetry={reset}
      />
      <div className="mt-4 flex justify-center">
        <Link
          href="/incidents"
          className="text-sm text-accent underline-offset-4 hover:underline"
        >
          Go to all incidents
        </Link>
      </div>
    </div>
  );
}

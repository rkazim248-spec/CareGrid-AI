'use client';

import * as React from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';

import { Button, Input } from '@/components/ui';
import { ErrorState, NotFoundState } from '@/components/feedback';
import { IncidentDetailRecord } from '@/features/incidents/incident-detail-record';
import { listIncidents } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { TRACK_COPY } from '@/features/track/track-copy';
import type { z } from 'zod';
import type { incidentListResponseSchema } from '@/validators/incident';

type IncidentRow = z.infer<typeof incidentListResponseSchema>['items'][number];

function normalise(value: string): string {
  return value.trim().toUpperCase();
}

export function TrackView({ requestedRef }: { requestedRef: string | undefined }) {
  const initialRef = requestedRef ? normalise(requestedRef) : '';
  const [query, setQuery] = React.useState(initialRef);
  const [activeRef, setActiveRef] = React.useState(initialRef);
  const [incident, setIncident] = React.useState<IncidentRow | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [moreAvailable, setMoreAvailable] = React.useState(false);
  const [loading, setLoading] = React.useState(Boolean(initialRef));
  const [error, setError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    if (!activeRef) {
      setIncident(null);
      setNotFound(false);
      setMoreAvailable(false);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setIncident(null);
    setNotFound(false);
    setMoreAvailable(false);
    setError(null);

    void listIncidents({ limit: '100' }, { signal: controller.signal })
      .then((result) => {
        const match = result.items.find((entry) => normalise(entry.reference) === activeRef);
        setIncident(match ?? null);
        setNotFound(match === undefined);
        setMoreAvailable(match === undefined && result.page.hasMore);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(isApiError(caught) ? caught.code : 'NETWORK');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [activeRef, reload]);

  const lookUp = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActiveRef(normalise(query));
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl leading-tight font-bold text-primary">{TRACK_COPY.title}</h1>
        <p className="max-w-[72ch] text-sm leading-6 text-secondary">{TRACK_COPY.description}</p>
      </div>

      <form noValidate onSubmit={lookUp} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            id="track-reference"
            label={TRACK_COPY.referenceLabel}
            mono
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            helperText={TRACK_COPY.referenceHelper}
            autoComplete="off"
            inputMode="text"
            spellCheck={false}
            maxLength={32}
            placeholder="CG-..."
          />
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full shrink-0 sm:w-auto">
          <Search aria-hidden="true" />
          {TRACK_COPY.lookUp}
        </Button>
      </form>

      {loading ? (
        <div className="flex flex-col gap-3" role="status" aria-live="polite">
          <span className="sr-only">Looking for your saved report</span>
          <div className="skeleton-fill h-8 w-56 rounded-sm" />
          <div className="skeleton-fill h-48 rounded-card" />
        </div>
      ) : error !== null ? (
        <ErrorState
          title="We could not look up this report"
          description="Check your connection and retry. Your report has not been changed."
          code={error}
          onRetry={() => setReload((value) => value + 1)}
        />
      ) : incident ? (
        <IncidentDetailRecord incidentId={incident.incidentId} />
      ) : notFound ? (
        <div className="flex flex-col gap-4">
          <NotFoundState variant="reference" />
          {moreAvailable ? (
            <p className="text-sm text-secondary">
              The reference was not in the latest 100 reports.{' '}
              <Link href="/incidents" className="font-medium text-accent underline-offset-4 hover:underline">
                Browse all reports
              </Link>
              {' '}to continue through older records.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-card border border-subtle bg-surface px-4 py-5 text-sm text-secondary">
          Enter the reference from a saved report. You can also browse your reports directly.
          {' '}
          <Link href="/incidents" className="font-medium text-accent underline-offset-4 hover:underline">
            Open reports
          </Link>
        </p>
      )}
    </div>
  );
}

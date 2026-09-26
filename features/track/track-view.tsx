'use client';

import * as React from 'react';
import { Search } from 'lucide-react';

import { Alert, AlertDescription, AlertIcon, AlertTitle, Button, Input } from '@/components/ui';
import { NotFoundState } from '@/components/feedback';
import { MOCK_INCIDENTS } from '@/lib/mock-data';
import { TRACK_COPY } from '@/features/track/track-copy';
import { TrackIncidentCard } from '@/features/track/track-incident-card';

/**
 * /track — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.3.
 *
 * Reads `?ref=` and, when none is given, falls back to the demo reference so
 * the route is never a blank screen. The sample is announced in visible text,
 * because a page full of plausible incident data with no provenance marker is
 * exactly how a demo gets mistaken for a live system (docs/04 §15.5).
 *
 * An unknown reference and a reference the caller may not see produce the SAME
 * `NotFoundState variant="reference"`. Two different messages would turn the
 * page into an existence oracle (US-005 AC4).
 */
const DEMO_REFERENCE = 'CG-7QK4M2';

function normalise(value: string): string {
  return value.trim().toUpperCase();
}

export function TrackView({ requestedRef }: { requestedRef: string | undefined }) {
  const fromUrl = requestedRef ? normalise(requestedRef) : null;
  const [query, setQuery] = React.useState(fromUrl ?? DEMO_REFERENCE);
  const [activeRef, setActiveRef] = React.useState<string | null>(fromUrl);

  // No reference in the URL: show the sample and say so.
  const usingSample = activeRef === null;
  const shownRef = usingSample ? DEMO_REFERENCE : activeRef;
  const incident = MOCK_INCIDENTS.find((entry) => entry.reference === shownRef);

  const lookUp = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActiveRef(normalise(query));
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl leading-tight font-bold text-primary">{TRACK_COPY.title}</h1>
        <p className="max-w-[72ch] text-sm text-secondary">{TRACK_COPY.description}</p>
      </div>

      <form noValidate onSubmit={lookUp} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            id="track-reference"
            label={TRACK_COPY.referenceLabel}
            mono
            className="h-12 md:h-10"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            helperText={TRACK_COPY.referenceHelper}
            autoComplete="off"
            inputMode="text"
            spellCheck={false}
            maxLength={12}
            placeholder={DEMO_REFERENCE}
          />
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full shrink-0 sm:w-auto">
          <Search aria-hidden="true" />
          {TRACK_COPY.lookUp}
        </Button>
      </form>

      <Alert tone="neutral">
        <AlertIcon tone="neutral" />
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>Sample data</AlertTitle>
          <AlertDescription>
            {usingSample ? TRACK_COPY.sampleNotice : TRACK_COPY.sampleNoticeFor(shownRef)}
          </AlertDescription>
        </div>
      </Alert>

      {incident ? (
        <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_240px] lg:items-start lg:gap-6">
          <TrackIncidentCard incident={incident} />
          <aside className="hidden lg:sticky lg:top-20 lg:block">
            <Alert tone="info">
              <AlertIcon tone="info" />
              <div className="flex min-w-0 flex-col gap-1">
                <AlertTitle>Who can see this</AlertTitle>
                <AlertDescription>
                  Dispatchers and the assigned responder can see this report. Responders cannot see
                  your name.
                </AlertDescription>
              </div>
            </Alert>
          </aside>
        </div>
      ) : (
        <NotFoundState variant="reference" />
      )}
    </div>
  );
}

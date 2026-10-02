'use client';

import * as React from 'react';
import { ArrowLeft, MapPin, Paperclip, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';

import { Button, Card, CardContent } from '@/components/ui';
import { ErrorState, ERROR_COPY } from '@/components/feedback';
import { StatusBadge, Timestamp, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META } from '@/config';
import { getIncident, uploadsSignedUrl } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import type { incidentDetailResponseSchema } from '@/validators/incident';

type IncidentDetails = z.infer<typeof incidentDetailResponseSchema>;
type Evidence =
  | { readonly mediaId: string; readonly status: 'ready'; readonly url: string; readonly contentType: string; readonly displayName: string }
  | { readonly mediaId: string; readonly status: 'unavailable' };

export function IncidentDetailRecord({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const [record, setRecord] = React.useState<IncidentDetails | null>(null);
  const [evidence, setEvidence] = React.useState<readonly Evidence[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setLoading(true);
    setError(null);
    setRecord(null);
    setEvidence([]);

    void getIncident(incidentId, { signal: controller.signal })
      .then(async (details) => {
        if (!active) return;
        setRecord(details);

        const resolved = await Promise.all(
          details.evidenceIds.map(async (mediaId): Promise<Evidence> => {
            try {
              const signed = await uploadsSignedUrl(mediaId, { signal: controller.signal });
              return {
                mediaId,
                status: 'ready',
                url: signed.url,
                contentType: signed.contentType,
                displayName: signed.displayName,
              };
            } catch {
              return { mediaId, status: 'unavailable' };
            }
          }),
        );
        if (active) setEvidence(resolved);
      })
      .catch((caught: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(isApiError(caught) ? caught.code : 'NETWORK');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [incidentId, reload]);

  if (loading) {
    return (
      <div className="flex flex-col gap-5" role="status" aria-live="polite">
        <span className="sr-only">Loading saved incident</span>
        <div className="skeleton-fill h-8 w-56 rounded-sm" />
        <div className="skeleton-fill h-24 rounded-card" />
        <div className="skeleton-fill h-48 rounded-card" />
      </div>
    );
  }

  if (record === null) {
    return (
      <ErrorState
        title={error === 'NOT_FOUND' ? 'Incident not found' : ERROR_COPY.readFailed.title}
        description={
          error === 'NOT_FOUND'
            ? 'We could not find that incident, or it is not available to this account.'
            : ERROR_COPY.readFailed.description
        }
        code={error ?? undefined}
        onRetry={() => setReload((value) => value + 1)}
        secondaryAction={{ label: 'Back to reports', onClick: () => router.push('/incidents') }}
      />
    );
  }

  const { incident, aiAnalysis } = record;
  const category = incident.category ? CATEGORY_META[incident.category].label : 'Not classified';

  return (
    <article className="flex min-w-0 flex-col gap-5">
      <Button variant="ghost" size="sm" asChild className="-ml-3 min-h-11 self-start">
        <Link href="/incidents">
          <ArrowLeft aria-hidden="true" />
          Back to reports
        </Link>
      </Button>

      <header className="flex flex-col gap-3">
        <p className="ref-code text-sm text-secondary">{incident.reference}</p>
        <h1 className="text-balance text-3xl leading-tight font-semibold tracking-tight text-primary sm:text-4xl">
          Incident details
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={incident.status} />
          <UrgencyBadge urgency={incident.urgency} />
          {incident.createdAt ? <Timestamp iso={incident.createdAt.toISOString()} /> : null}
        </div>
      </header>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <h2 className="text-lg font-semibold text-primary">Your report</h2>
            <p className="max-w-[72ch] whitespace-pre-wrap text-sm leading-6 text-secondary">
              {incident.originalText?.trim() || incident.summary}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-primary">
              <MapPin className="size-4 text-accent" aria-hidden="true" />
              Reported location
            </h2>
            <p className="text-sm text-secondary">
              {incident.locationText || incident.placeName || 'No location was included.'}
            </p>
            {incident.geo ? (
              <p className="font-mono text-xs text-muted tabular-nums">
                {incident.geo.lat.toFixed(5)}, {incident.geo.lng.toFixed(5)}
                {incident.geo.accuracyM === null ? '' : ` · ±${Math.round(incident.geo.accuracyM)} m`}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <h2 className="text-lg font-semibold text-primary">Gemini analysis</h2>
            {aiAnalysis ? (
              <>
                <p className="max-w-[72ch] text-sm leading-6 text-secondary">{aiAnalysis.summary}</p>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted">Category</dt>
                    <dd className="mt-1 text-primary">{aiAnalysis.category ? CATEGORY_META[aiAnalysis.category].label : category}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Urgency</dt>
                    <dd className="mt-1 capitalize text-primary">{aiAnalysis.urgency}</dd>
                  </div>
                  {aiAnalysis.confidence !== null ? (
                    <div>
                      <dt className="text-xs text-muted">Confidence</dt>
                      <dd className="mt-1 tabular-nums text-primary">{Math.round(aiAnalysis.confidence * 100)}%</dd>
                    </div>
                  ) : null}
                </dl>
                {aiAnalysis.needsReview ? (
                  <p className="rounded-control border border-warning bg-warning-muted px-3 py-2 text-sm text-warning-fg-muted">
                    This assessment needs human review.
                  </p>
                ) : null}
                {aiAnalysis.safetyFlags.length > 0 ? (
                  <p className="text-sm text-secondary">
                    Safety notes: {aiAnalysis.safetyFlags.join(', ')}
                  </p>
                ) : null}
                {aiAnalysis.requiredResources.length > 0 ? (
                  <p className="text-sm text-secondary">
                    Suggested resources: {aiAnalysis.requiredResources.join(', ')}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-secondary">
                Gemini did not produce an analysis for this report. No generated or estimated analysis is shown.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-primary">
              <Paperclip className="size-4 text-accent" aria-hidden="true" />
              Uploaded media
            </h2>
            {evidence.length === 0 ? (
              <p className="text-sm text-secondary">No photos or voice notes were attached.</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {evidence.map((item) => (
                  <li key={item.mediaId} className="min-w-0">
                    {item.status === 'unavailable' ? (
                      <p className="rounded-control border border-default bg-elevated px-3 py-2 text-sm text-muted">
                        This file is currently unavailable.
                      </p>
                    ) : item.contentType.startsWith('image/') ? (
                      <a href={item.url} target="_blank" rel="noreferrer" className="block">
                        {/* Signed evidence URLs are authorization-scoped, short-lived remote assets. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.url}
                          alt={`Uploaded photo: ${item.displayName}`}
                          width={960}
                          height={640}
                          className="aspect-video w-full rounded-control border border-subtle object-cover"
                        />
                        <span className="mt-1 block truncate text-xs text-secondary">{item.displayName}</span>
                      </a>
                    ) : (
                      <div className="rounded-control border border-subtle bg-elevated p-3">
                        <p className="mb-2 truncate text-xs text-secondary">{item.displayName}</p>
                        <audio controls preload="none" src={item.url} className="w-full">
                          Your browser cannot play this voice note.
                        </audio>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Button variant="outline" size="sm" className="self-start" onClick={() => setReload((value) => value + 1)}>
        <RefreshCw aria-hidden="true" />
        Refresh saved details
      </Button>
    </article>
  );
}

'use client';

import * as React from 'react';
import { Camera, MapPin, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button, Card, CardContent, CardHeader } from '@/components/ui';
import { LocationBadge, RelativeTime, StatusBadge, Timeline, UrgencyBadge } from '@/components/domain';
import { STATUS_META, REPORT_LIMITS } from '@/config';
import { MOCK_HISTORY_BY_INCIDENT } from '@/lib/mock-data';
import { ProgressHeader, ProgressStepper } from '@/features/track/progress-stepper';
import { TRACK_COPY } from '@/features/track/track-copy';
import { buildTrackSteps } from '@/features/track/track-progress';
import type { Incident } from '@/types';

/**
 * The incident card on /track — docs/04 §13.3.
 *
 * Deliberately narrow. A citizen sees the reference, the two badges, what was
 * reported, how good the location is, when it last changed, and what happens
 * next. No urgency SLA countdown, no confidence score, no duplicate internals
 * (docs/04 §12.1 "deliberately de-emphasised").
 */
export function TrackIncidentCard({ incident }: { incident: Incident }) {
  const history = MOCK_HISTORY_BY_INCIDENT[incident.incidentId] ?? [];
  const steps = buildTrackSteps(incident, history);
  const statusMeta = STATUS_META[incident.status];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="ref-code text-sm text-primary">{incident.reference}</span>
          <StatusBadge status={incident.status} />
          <UrgencyBadge urgency={incident.urgency} size="sm" />
        </div>
        <p className="mt-1 text-sm text-secondary">
          <span className="text-muted">Last update </span>
          <RelativeTime iso={incident.updatedAt} />
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <p className="uppercase-label text-muted">{TRACK_COPY.summaryLabel}</p>
          <p className="max-w-[72ch] text-base text-primary">{incident.summary}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {incident.location ? (
            <LocationBadge
              accuracyGrade={incident.location.accuracyGrade}
              accuracyM={incident.location.accuracyM}
              source={incident.location.source}
            />
          ) : (
            <LocationBadge accuracyGrade={null} />
          )}
          {incident.location?.placeName ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-secondary">
              <MapPin className="size-3.5" aria-hidden="true" />
              {incident.location.placeName}
            </span>
          ) : null}
        </div>

        <NextCard statusLabel={statusMeta.label} body={statusMeta.citizenNext} />

        <div className="flex flex-col gap-3">
          <ProgressHeader />
          <ProgressStepper steps={steps} />
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-primary">{TRACK_COPY.timelineTitle}</h3>
            <p className="text-xs text-secondary">{TRACK_COPY.timelineLead}</p>
          </div>
          <Timeline events={history} />
        </div>

        <TrackActions incident={incident} />
      </CardContent>
    </Card>
  );
}

/** "What happens next", as a card of its own inside the incident card. */
function NextCard({ statusLabel, body }: { statusLabel: string; body: string }) {
  return (
    <div className="rounded-card border border-default bg-elevated px-3 py-3">
      <p className="uppercase-label text-muted">{TRACK_COPY.whatNextTitle}</p>
      <p className="mt-1 text-sm text-primary">{body}</p>
      <p className="mt-1 text-xs text-muted">Current status: {statusLabel}.</p>
    </div>
  );
}

/**
 * Two affordances, both UI only in Phase 1 (FR-012 supplement window,
 * FR-019 cancellation window). Each is disabled WITH A REASON when the report
 * has moved past the window, because a control that is quietly switched off is
 * how a citizen concludes the product is broken (docs/04 §10.4, FR-017).
 */
function TrackActions({ incident }: { incident: Incident }) {
  const photoReasonRef = React.useRef<HTMLParagraphElement | null>(null);
  const cancelReasonRef = React.useRef<HTMLParagraphElement | null>(null);
  const photoReasonId = 'track-photo-reason';
  const cancelReasonId = 'track-cancel-reason';

  const photoAllowed = incident.ageMin <= REPORT_LIMITS.supplementWindowHours * 60;
  const cancelAllowed = incident.status === 'new' || incident.status === 'triaged';

  const notConnected = (what: string) => {
    toast.info(`${what} is not connected in this build`, {
      description: 'The action was not sent. Nothing has changed.',
    });
  };

  return (
    <div className="flex flex-col gap-3 border-t border-subtle pt-3">
      <div className="flex flex-col gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full sm:w-auto"
          aria-disabled={photoAllowed ? undefined : true}
          aria-describedby={photoReasonId}
          onClick={() => {
            if (!photoAllowed) {
              photoReasonRef.current?.focus();
              return;
            }
            notConnected('Adding a photo');
          }}
        >
          <Camera aria-hidden="true" />
          {TRACK_COPY.addPhoto}
        </Button>
        <p ref={photoReasonRef} id={photoReasonId} tabIndex={-1} className="text-xs text-warning focus:outline-none">
          {photoAllowed ? ' ' : TRACK_COPY.photoWindowClosed}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Button
          type="button"
          variant="danger-outline"
          size="lg"
          className="w-full sm:w-auto"
          aria-disabled={cancelAllowed ? undefined : true}
          aria-describedby={cancelReasonId}
          onClick={() => {
            if (!cancelAllowed) {
              cancelReasonRef.current?.focus();
              return;
            }
            notConnected('Cancelling a report');
          }}
        >
          <X aria-hidden="true" />
          {TRACK_COPY.cancelReport}
        </Button>
        <p ref={cancelReasonRef} id={cancelReasonId} tabIndex={-1} className="text-xs text-warning focus:outline-none">
          {cancelAllowed ? TRACK_COPY.cancelAllowed : TRACK_COPY.cancelBlocked}
        </p>
      </div>
    </div>
  );
}

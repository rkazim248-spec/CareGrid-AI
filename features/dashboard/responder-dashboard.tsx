'use client';

import * as React from 'react';
import { Check, CircleDot, MapPin, Navigation } from 'lucide-react';
import { toast } from 'sonner';

import { Button, Card, CardContent, CardHeader, SwitchField } from '@/components/ui';
import { PageHeader, SectionHeader } from '@/components/layout';
import { EmptyState, EMPTY_COPY } from '@/components/feedback';
import { RequiredResourceChips, StatusBadge, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META, STATUS_META, URGENCY_META } from '@/config';
import { ResponderDispatchAlerts } from '@/features/dispatch/responder-dispatch-alerts';
import { formatDistance, formatRelative } from '@/lib/format';
import { MOCK_DISPATCHES, MOCK_INCIDENTS, MOCK_RESPONDERS } from '@/lib/mock-data';
import type { Dispatch, Incident, IncidentStatus, Responder } from '@/types';

/**
 * ResponderDashboard — docs/04 §12.2, §13.7.
 *
 * The screen is ordered by what a responder in gloves, in daylight, on a bad
 * signal needs in the order they need it:
 *
 *   1. the availability toggle, 56 px tall, with its reason when it is off-limits
 *      (US-010 AC3: disabled with "Your account is awaiting admin verification");
 *   2. one card per active assignment, most urgent first, each with exactly ONE
 *      primary action — the next permitted lifecycle transition (US-012 AC1);
 *   3. a four-step progress indicator so "how far along is this" needs no reading.
 *
 * The action label is DERIVED from `STATUS_META[status].nextActions`, not
 * hard-coded, so a change to the transition table in `config/statuses.ts` cannot
 * leave this screen offering an illegal move.
 */

/** The responder's own slice of the lifecycle, in order. */
const RESPONDER_CHAIN: readonly IncidentStatus[] = ['en_route', 'on_scene', 'resolved'];

const ACTION_LABEL: Partial<Record<IncidentStatus, string>> = {
  en_route: "I'm en route",
  on_scene: "I've arrived",
  resolved: 'Resolve',
};

const PROGRESS_STEPS = [
  { status: 'assigned', label: 'Accept' },
  { status: 'en_route', label: 'En Route' },
  { status: 'on_scene', label: 'On Scene' },
  { status: 'resolved', label: 'Resolved' },
] as const satisfies readonly { status: IncidentStatus; label: string }[];

const AWAITING_VERIFICATION_REASON = 'Your account is awaiting admin verification';

/** Region and list names come from constants, never a literal in JSX (docs/04 §5.2). */
const ASSIGNMENTS_REGION = 'Active assignments';
const TRAIL_LIST = 'Actions you took';
const PROGRESS_LIST = 'Assignment progress';

export function ResponderDashboard({ userUid }: { userUid: string }) {
  const self: Responder | undefined =
    MOCK_RESPONDERS.find((r) => r.uid === userUid) ?? MOCK_RESPONDERS[0];

  const [available, setAvailable] = React.useState(self?.status === 'available');

  if (!self) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="My work" />
        <EmptyState
          icon={Navigation}
          title={EMPTY_COPY.dispatches.title}
          description={EMPTY_COPY.dispatches.description}
        />
      </div>
    );
  }

  const blocked = self.verification !== 'verified';
  const assignments = activeAssignmentsFor(self.uid);

  return (
    <div className="flex flex-col gap-6">
      {/*
        The live alert is keyed to the REAL session uid (L6 + L2a), not to the
        demo identity driving the cards below. A responder with no live
        dispatch sees nothing from it.
      */}
      <ResponderDispatchAlerts />

      <PageHeader
        title="My work"
        description="Set yourself available, then work the assignments below. One action per assignment."
      />

      <AvailabilityCard
        available={available}
        blocked={blocked}
        onChange={(next) => {
          setAvailable(next);
          toast.success(next ? 'You are available.' : 'You are offline.', {
            description: 'Demo build — nothing was sent. Dispatchers would see this change.',
          });
        }}
      />

      <section aria-label={ASSIGNMENTS_REGION} className="flex flex-col gap-3">
        <SectionHeader
          title="Active assignments"
          description="Most urgent first. Each card has one action: the next step in the lifecycle."
        />

        {assignments.length === 0 ? (
          <EmptyState
            icon={Navigation}
            title={EMPTY_COPY.dispatches.title}
            description={EMPTY_COPY.dispatches.description}
          />
        ) : (
          assignments.map((assignment) => (
            <AssignmentCard
              key={assignment.dispatch.dispatchId}
              dispatch={assignment.dispatch}
              incident={assignment.incident}
            />
          ))
        )}
      </section>
    </div>
  );
}

/**
 * Row 1 of §12.2. The 56 px switch is the single most important control on the
 * screen, so it gets a card of its own above everything else rather than being
 * folded into a settings panel.
 */
function AvailabilityCard({
  available,
  blocked,
  onChange,
}: {
  available: boolean;
  blocked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Card>
      <CardContent className="py-2">
        <SwitchField
          id="responder-availability"
          label={available ? 'Available for assignments' : 'Offline'}
          helperText="Dispatchers can see you while you are available."
          {...(blocked ? { disabled: true, disabledReason: AWAITING_VERIFICATION_REASON } : {})}
          checked={available}
          onCheckedChange={onChange}
          className="min-h-14 py-3"
        />
      </CardContent>
    </Card>
  );
}

type Assignment = { dispatch: Dispatch; incident: Incident | undefined };

/** The responder's own dispatches that are not finished, most urgent first. */
export function activeAssignmentsFor(responderUid: string): Assignment[] {
  return MOCK_DISPATCHES.filter(
    (dispatch) =>
      dispatch.responder.uid === responderUid &&
      dispatch.status !== 'completed' &&
      dispatch.status !== 'withdrawn' &&
      dispatch.status !== 'expired',
  )
    .map((dispatch) => ({
      dispatch,
      incident: MOCK_INCIDENTS.find((i) => i.incidentId === dispatch.incidentId),
    }))
    .sort((a, b) => urgencyWeight(a.incident) - urgencyWeight(b.incident));
}

function urgencyWeight(incident: Incident | undefined): number {
  return incident ? URGENCY_META[incident.urgency].rank : 99;
}

/** One local transition: what the responder pressed, and what it moved to. */
type TrailStep = { from: IncidentStatus; to: IncidentStatus };

function AssignmentCard({ dispatch, incident }: Assignment) {
  const [status, setStatus] = React.useState<IncidentStatus>(incident?.status ?? 'assigned');
  const [trail, setTrail] = React.useState<readonly TrailStep[]>([]);

  if (!incident) return null;

  const next = nextResponderAction(status);

  const advance = () => {
    if (!next) return;
    const from = status;
    setTrail((current) => [...current, { from, to: next }]);
    setStatus(next);
    toast.success(ACTION_LABEL[next] ?? 'Updated.', {
      description: `Demo build — nothing was sent. ${incident.reference} moved from ${STATUS_META[from].label} to ${STATUS_META[next].label}.`,
    });
  };

  return (
    <Card className="border-default">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="ref-code text-sm text-primary">{incident.reference}</span>
          <UrgencyBadge urgency={incident.urgency} size="lg" />
          <StatusBadge status={status} />
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-secondary">
          <span>{CATEGORY_META[incident.category].label}</span>
          <span className="tabular">{formatDistance(dispatch.distanceM)}</span>
          <span className="text-xs text-muted">assigned {formatRelative(dispatch.dispatchedAt)}</span>
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <ProgressSteps status={status} />

        <div className="flex flex-col gap-1.5">
          <span className="uppercase-label text-muted">Bring</span>
          <RequiredResourceChips resources={incident.requiredResources} />
        </div>

        <div className="rounded-sm border border-subtle bg-inset p-3">
          <p className="uppercase-label mb-1 text-muted">Where</p>
          <p className="flex items-center gap-1.5 text-sm text-primary">
            <MapPin className="size-3.5 text-muted" aria-hidden="true" />
            {incident.location?.placeName ?? 'No location on this report yet.'}
          </p>
          {incident.location ? (
            <p className="mt-1 font-mono text-2xs text-muted tabular">
              {incident.location.lat.toFixed(5)}, {incident.location.lng.toFixed(5)}
            </p>
          ) : null}
        </div>

        {trail.length > 0 ? (
          <ol className="flex flex-col gap-1 text-xs text-secondary" aria-label={TRAIL_LIST}>
            {trail.map((step, index) => (
              <li key={`${step.from}-${index}`} className="flex items-center gap-1.5">
                <Check className="size-3.5 text-success" aria-hidden="true" />
                {STATUS_META[step.from].label} → {STATUS_META[step.to].label}
              </li>
            ))}
          </ol>
        ) : null}

        {next ? (
          <Button
            variant="primary"
            size="xl"
            onClick={advance}
            className="w-full min-h-14 text-base"
          >
            {ACTION_LABEL[next] ?? 'Continue'}
          </Button>
        ) : (
          <p className="text-sm text-secondary">
            Nothing further is needed from you on this incident.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The next legal move for a responder, read from the transition table. */
export function nextResponderAction(status: IncidentStatus): IncidentStatus | null {
  const allowed = STATUS_META[status].nextActions;
  return RESPONDER_CHAIN.find((candidate) => allowed.includes(candidate)) ?? null;
}

function ProgressSteps({ status }: { status: IncidentStatus }) {
  const currentIndex = PROGRESS_STEPS.findIndex((step) => step.status === status);

  return (
    <ol className="flex items-center gap-1" aria-label={PROGRESS_LIST}>
      {PROGRESS_STEPS.map((step, index) => {
        const done = currentIndex >= 0 && index < currentIndex;
        const current = step.status === status;
        const Icon = done ? Check : current ? CircleDot : null;

        return (
          <li key={step.status} className="flex flex-1 flex-col items-center gap-1">
            <span
              className={
                current
                  ? 'h-1 w-full rounded-pill bg-accent'
                  : done
                    ? 'h-1 w-full rounded-pill bg-success'
                    : 'h-1 w-full rounded-pill bg-elevated'
              }
            />
            <span
              className={
                current
                  ? 'flex items-center gap-1 text-2xs font-semibold text-primary'
                  : done
                    ? 'flex items-center gap-1 text-2xs text-secondary'
                    : 'text-2xs text-muted'
              }
            >
              {Icon ? <Icon className="size-3" aria-hidden="true" /> : null}
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

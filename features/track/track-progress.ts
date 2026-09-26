/**
 * The citizen progress stepper model — docs/04 §13.3, §5.15.
 *
 * The step LIST comes from `CITIZEN_PROGRESS_STEPS` so it can never fall out of
 * step with the lifecycle. The TIMESTAMPS come from the incident record and its
 * history; a step that has not been reached has `at: null` and is rendered as
 * pending. A timestamp is never invented to fill a gap (docs/04 §1.2 P2, P5).
 */

import { CITIZEN_PROGRESS_STEPS } from '@/config';
import type { HistoryEvent, Incident, IncidentStatus } from '@/types';

export type TrackStepState = 'done' | 'current' | 'pending';

export type TrackStep = {
  readonly status: IncidentStatus;
  readonly label: string;
  /** ISO string, or null when the step has not happened. */
  readonly at: string | null;
  readonly state: TrackStepState;
};

/** Plain-language step labels. Never a raw `eventType` code. docs/04 §13.3. */
const STEP_LABEL: Record<(typeof CITIZEN_PROGRESS_STEPS)[number], string> = {
  new: 'Reported',
  triaged: 'AI triaged',
  verified: 'Verified',
  assigned: 'Responder assigned',
  en_route: 'En route',
  on_scene: 'On scene',
  resolved: 'Resolved',
};

function firstEvent(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
): string | null {
  const match = history.find(predicate);
  return match ? match.createdAt : null;
}

/** Where the timestamp for each step comes from, in order of preference. */
function timestampFor(
  status: IncidentStatus,
  incident: Incident,
  history: readonly HistoryEvent[],
): string | null {
  switch (status) {
    case 'new':
      return incident.createdAt;
    case 'triaged':
      return (
        firstEvent(history, (event) => event.eventType === 'ai_triaged') ??
        firstEvent(history, (event) => event.toStatus === 'triaged')
      );
    case 'verified':
      return incident.verifiedAt ?? firstEvent(history, (event) => event.eventType === 'verified');
    case 'assigned':
      return (
        incident.respondedAt ??
        firstEvent(history, (event) => event.eventType === 'assigned')
      );
    case 'en_route':
      return firstEvent(history, (event) => event.toStatus === 'en_route');
    case 'on_scene':
      return incident.arrivedAt;
    case 'resolved':
      return incident.resolvedAt;
    default:
      return null;
  }
}

export function buildTrackSteps(
  incident: Incident,
  history: readonly HistoryEvent[],
): readonly TrackStep[] {
  const currentIndex = CITIZEN_PROGRESS_STEPS.indexOf(
    incident.status as (typeof CITIZEN_PROGRESS_STEPS)[number],
  );

  return CITIZEN_PROGRESS_STEPS.map((status, index) => {
    const at = timestampFor(status, incident, history);

    // A terminal status outside the lifecycle (closed, cancelled, false alarm,
    // merged) means every lifecycle step was reached. The StatusBadge and
    // citizenNext sentence carry the terminal state, so the stepper does not
    // invent a "final" step that is not in the status table.
    const state: TrackStepState =
      currentIndex === -1
        ? 'done'
        : index < currentIndex
          ? 'done'
          : index === currentIndex
            ? 'current'
            : 'pending';

    return { status, label: STEP_LABEL[status], at, state };
  });
}

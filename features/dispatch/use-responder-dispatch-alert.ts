'use client';

/**
 * ============================================================================
 * CareGrid AI — L6: the responder's own dispatches (+ the alert target)
 * ============================================================================
 *
 * `docs/11 §2.2` **L6**, Phase 13 brief §3.
 *
 * Two hooks live here because the alert is a JOIN of two listeners:
 *
 *   - `useResponderDispatches` attaches L6 (this responder's live dispatch rows,
 *     `active` | `accepted`, newest first) and may be used directly by the
 *     assignment list;
 *   - `useResponderDispatchAlert` picks the alert target — the newest row still
 *     `active`, i.e. awaiting this responder's answer — and attaches L2a as a
 *     single-document listener on THAT incident.
 *
 * The split matters because the dispatch document deliberately carries no
 * incident fields (no reference, no category, no urgency, no location) — the
 * denormalisation in `services/dispatch/assign.ts` puts those on the incident,
 * which the responder may read because the assignment names them as
 * `assigneeUid`. So the alert needs the second, targeted listener rather than a
 * wider dispatch query, and the incident listener must not exist until there is
 * a target (`enabled: incidentId !== null`).
 *
 * Budget: L7 + L5 + **L6** + **L2a** = 4 ≤ `MAX_REALTIME_LISTENERS`. The two
 * hooks share the L6 channel through the registry when mounted together — the
 * identical `(id, queryKey)` pair refcounts to one Firestore watch.
 */

import * as React from 'react';

import { useRealtimeListener, type RealtimeStateShape } from '@/hooks/use-realtime-listener';
import { incidentQuery, responderDispatchQuery } from '@/lib/firestore/queries';
import { useSession } from '@/components/providers/session-provider';
import {
  toAlertIncident,
  toLiveDispatchRow,
  type AlertIncident,
  type LiveDispatchRow,
} from '@/features/dispatch/live-dispatch-row';

/** L6 — every live dispatch row for the signed-in responder. */
export function useResponderDispatches(): RealtimeStateShape<LiveDispatchRow> & {
  readonly hasReceivedSnapshot: boolean;
} {
  const { user, role } = useSession();
  const uid = user?.uid ?? null;

  // A responder-only listener. Any other role (and an unresolved session) never
  // constructs the query at all — `docs/11 §11.3` SEC-6.
  const enabled = uid !== null && role === 'responder';

  const queryKey = React.useMemo(() => JSON.stringify(['L6', 'dispatches', uid]), [uid]);

  const state = useRealtimeListener<LiveDispatchRow>({
    id: 'responderAssignments',
    queryKey,
    enabled,
    limit: 20,
    buildQuery: (db) => responderDispatchQuery(db, uid ?? ''),
    map: toLiveDispatchRow,
  });

  return {
    ...state,
    hasReceivedSnapshot: state.lastSyncedAt !== null,
  };
}

export type ResponderDispatchAlert = {
  /** The newest dispatch still awaiting this responder's answer, if any. */
  readonly alertDispatch: LiveDispatchRow | null;
  /** The alert target's incident, or `null` until its snapshot lands. */
  readonly alertIncident: AlertIncident | null;
  readonly isLoadingDispatches: boolean;
  readonly hasReceivedSnapshot: boolean;
  readonly dispatchError: RealtimeStateShape<LiveDispatchRow>['error'];
};

/**
 * The full-screen alert's data. `alertDispatch` is the first row with status
 * `active` — the query already orders newest-first — and once it is answered or
 * expires, the next one (or none) takes its place on the next snapshot.
 */
export function useResponderDispatchAlert(): ResponderDispatchAlert {
  const dispatches = useResponderDispatches();

  const alertDispatch = dispatches.items.find((row) => row.status === 'active') ?? null;
  const incidentId = alertDispatch?.incidentId ?? null;

  const incidentQueryKey = React.useMemo(
    () => JSON.stringify(['L2a', 'alert-incident', incidentId]),
    [incidentId],
  );

  const incident = useRealtimeListener<AlertIncident>({
    id: 'incidentDetail',
    queryKey: incidentQueryKey,
    enabled: incidentId !== null,
    limit: 1,
    kind: 'document',
    buildQuery: (db) => incidentQuery(db, incidentId ?? ''),
    map: toAlertIncident,
  });

  return {
    alertDispatch,
    alertIncident: incident.items[0] ?? null,
    isLoadingDispatches: dispatches.isLoading,
    hasReceivedSnapshot: dispatches.hasReceivedSnapshot,
    dispatchError: dispatches.error,
  };
}

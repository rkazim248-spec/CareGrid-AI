'use client';

/**
 * ============================================================================
 * CareGrid AI — L1: the live incident queue
 * ============================================================================
 *
 * `docs/11 §2.2` **L1**, `docs/11 §3.2`. brief §6.
 *
 * ---------------------------------------------------------------------------
 * THE SEED IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * `docs/11 §3.2`: "**Never** render an empty state between the seed and the first
 * snapshot. An empty queue is a claim about reality; during that window we do not
 * know it yet."
 *
 * So `isLoading` and `isStale` are separate (see the primitive's return type) and
 * this hook exposes `hasReceivedSnapshot` so a consumer can tell "no incidents"
 * from "not loaded yet". The existing `EmptyState` component takes a `isLoading`
 * flag for exactly this, and using it with `isLoading` alone is the bug.
 *
 * ---------------------------------------------------------------------------
 * `includeMetadataChanges: true` — `docs/11 §3.3`'s L1 row
 * ---------------------------------------------------------------------------
 * The queue row shows a pending state (reduced opacity, `aria-busy`), and the
 * metadata flag is what distinguishes "the responder's own Accept is still in
 * flight" from "someone else's change arrived". Four of the ten listeners have it
 * on; this is one of the four.
 *
 * ---------------------------------------------------------------------------
 * NO FREE-TEXT SEARCH IN THE LISTENER
 * ---------------------------------------------------------------------------
 * `docs/11 §6` QD-10 and the arithmetic behind it: `searchTokens` is ≤ 30 elements
 * and Firestore's `array-contains-any` accepts ≤ 30 values, so a search query is
 * within the limit only by exactly zero. Search is therefore a debounced parameter
 * that produces a **server** query, and `queueQuery` deliberately has no `search`
 * field. A caller that needs it must use `GET /api/incidents`.
 */

import * as React from 'react';

import { useRealtimeListener, type RealtimeStateShape } from '@/hooks/use-realtime-listener';
import { queueQuery, type QueueFilters } from '@/lib/firestore/queries';
import { useSession } from '@/components/providers/session-provider';
import type { UserRole } from '@/types';
import { toLiveIncidentRow, type LiveIncidentRow } from '@/features/incidents/live-incident-row';

export type UseRealtimeIncidentsOptions = {
  readonly filters: QueueFilters;
  /** Rows from a Server Component, shown until the first snapshot. */
  readonly seed?: readonly LiveIncidentRow[];
  /** Defaults to the session's role. `false` for a citizen, who has no L1. */
  readonly enabled?: boolean;
};

export type RealtimeIncidentQueue = RealtimeStateShape<LiveIncidentRow> & {
  /** `false` until the first snapshot lands. Distinct from "the queue is empty". */
  readonly hasReceivedSnapshot: boolean;
  /**
   * Why the listener is not attached.
   *
   * `docs/11 §11.3` SEC-6: a citizen client has no code path that constructs L1,
   * L3, L4, L8 or L9. Rather than throwing — which would crash a citizen's view of
   * a page that happens to render the queue component — the hook reports the
   * reason, and the caller renders nothing or renders the citizen's own list.
   */
  readonly blockedBy: 'not_signed_in' | 'role' | null;
};

/**
 * `docs/11 §2.3` budgets 5 concurrent listeners on `/dashboard` for a dispatcher:
 * L7 + L5 + **L1** + L8 + L9. This is one of them.
 */
export function useRealtimeIncidents(
  options: UseRealtimeIncidentsOptions,
): RealtimeIncidentQueue {
  const { filters, seed, enabled: enabledOverride } = options;
  const { user, role } = useSession();

  // A-4: auth must be resolved first. `user` is null until it is, and attaching
  // before then produces a `permission-denied` first snapshot that then vanishes.
  const isOps = role === 'dispatcher' || role === 'admin';
  const blockedBy: RealtimeIncidentQueue['blockedBy'] =
    user === null ? 'not_signed_in' : isOps ? null : 'role';
  const enabled = enabledOverride ?? isOps;

  // `docs/11 §3.6`: a STRING key from the query's parameters, so a re-render that
  // produces the same query does not re-subscribe. `filters` is memoised by
  // `useIncidentFilters`, so its identity is stable when the values are.
  const queryKey = React.useMemo(
    () =>
      JSON.stringify([
        'L1',
        role,
        user?.uid ?? null,
        filters.status,
        filters.urgency,
        filters.category,
        filters.assigned,
        filters.orderBy,
        filters.limit,
      ]),
    [role, user?.uid, filters],
  );

  const state = useRealtimeListener<LiveIncidentRow>({
    id: 'queue',
    queryKey,
    enabled,
    limit: filters.limit,
    // `docs/11 §3.3`: ON for L1.
    includeMetadataChanges: true,
    buildQuery: (db) => {
      // `queueQuery` refuses a non-ops role itself (`docs/11 §6` QD-4), so the cast
      // below is unreachable and the refusal is a loud error rather than a silent
      // permission-denied on the first snapshot.
      return queueQuery(db, { role: role as 'dispatcher' | 'admin', filters });
    },
    map: toLiveIncidentRow,
    ...(seed === undefined ? {} : { seed }),
  });

  return {
    ...state,
    hasReceivedSnapshot: state.lastSyncedAt !== null,
    blockedBy: enabled ? null : blockedBy,
  };
}

/**
 * Filter a live queue in memory, for the filters that cannot be expressed as a
 * Firestore constraint.
 *
 * **Only for filters already applied server-side plus client-side ordering of the
 * result.** This is a presentation helper over a bounded window (≤ 50 documents),
 * not a substitute for the query: a dispatcher who searches 400 active incidents
 * needs the server to do it, and `docs/11 §6` QD-10 is why free text cannot come
 * here.
 */
export function sortLiveRows(
  rows: readonly LiveIncidentRow[],
  order: 'urgency' | 'recent' | 'oldest',
): readonly LiveIncidentRow[] {
  const urgencyRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...rows];
  if (order === 'recent') {
    sorted.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  } else if (order === 'oldest') {
    sorted.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  } else {
    // Urgency first, then oldest-first WITHIN a band. A dispatcher scanning for
    // "the most urgent thing" should see the longest-waiting critical at the top,
    // not the most recently touched one — an incident that keeps getting
    // re-reported appears at the top of a recency sort forever and starves the rest.
    sorted.sort((a, b) => {
      const rank = (urgencyRank[a.urgency] ?? 9) - (urgencyRank[b.urgency] ?? 9);
      if (rank !== 0) return rank;
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    });
  }
  return sorted;
}

/** The roles that may attach L1. `docs/11 §11.3` SEC-2. */
export const QUEUE_LISTENER_ROLES: readonly UserRole[] = ['dispatcher', 'admin'];

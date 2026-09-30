'use client';

/**
 * ============================================================================
 * CareGrid AI — L5: the live notification list
 * ============================================================================
 *
 * `docs/11 §2.2` **L5**, `docs/11 §3.3`, `docs/13 §3.3`. brief §7.
 *
 * ---------------------------------------------------------------------------
 * SCOPED TO ONE RECIPIENT, AND THE SCOPE IS STRUCTURAL
 * ---------------------------------------------------------------------------
 * `docs/11 §11.3` SEC-4: "L5's query is `where('recipientUid','==',uid)` and the
 * hook exposes **no parameter** to widen it. There is no `?recipientUid=` in the
 * client path."
 *
 * So this hook takes no filter, no query options, and no "fetch all" escape hatch.
 * `notificationQuery` takes exactly two parameters — the db and the uid — and a
 * security check asserts that count, because a function whose signature cannot
 * express a selector cannot be given one.
 *
 * That matters because a notification is a **targeted message about one user's
 * emergency**: "an incident was assigned to you", "your report was resolved". A
 * query that could be widened to another recipient would be a read of somebody
 * else's operational correspondence.
 *
 * ---------------------------------------------------------------------------
 * THE UNREAD COUNT IS DERIVED FROM THE SAME 50 DOCUMENTS
 * ---------------------------------------------------------------------------
 * `docs/11 §11.2` allows `unreadCount` as the one aggregate that is NOT an API call,
 * precisely because "it is derived from the same 50-document snapshot".
 *
 * So the count is `items.filter(n => !n.read).length`, over the window the listener
 * already holds. It is therefore the count **of unread among the 50 most recent**,
 * and it is labelled as such below — an unbounded unread count would need either a
 * server aggregation or a wider window, and `docs/13 §3.1` caps the bell at 50.
 *
 * ---------------------------------------------------------------------------
 * `includeMetadataChanges: true` — `docs/11 §3.3`'s L5 row
 * ---------------------------------------------------------------------------
 * The one client-side write this app allows is `markRead`, which flips `read` and
 * writes `readAt` directly (`docs/11 §11.3` SEC-5). Without the metadata flag the
 * row would not re-render until the server round-tripped, so the bell would not
 * decrement for a second or two after the user clicked.
 */

import * as React from 'react';

import { useRealtimeListener, type RealtimeStateShape } from '@/hooks/use-realtime-listener';
import { notificationQuery } from '@/lib/firestore/queries';
import { useSession } from '@/components/providers/session-provider';
import { NOTIFICATION_TYPES } from '@/types';
import type { NotificationSeverity, NotificationType } from '@/types';

/* ========================================================================== */
/* The row                                                                     */
/* ========================================================================== */

/**
 * One notification, as the list renders it.
 *
 * A **subset**, not the stored document. `docs/11 §11.1` puts `notifications` at
 * "own" for every role, so nothing here is redacted — but the stored document also
 * carries `recipientUid`, and echoing a recipient's own uid into every row of their
 * own list is data they did not ask for and that no UI displays.
 */
export type LiveNotification = {
  readonly id: string;
  readonly type: NotificationType;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly incidentId: string | null;
  /** The human `CG-XXXXXX` reference, denormalised so a row needs no join. */
  readonly incidentRef: string | null;
  readonly link: string | null;
  readonly read: boolean;
  readonly actorName: string | null;
  readonly createdAtIso: string | null;
};

const SEVERITIES: ReadonlySet<string> = new Set(['info', 'warning', 'critical']);

/**
 * The recognised types, derived from `NOTIFICATION_TYPES` rather than restated.
 *
 * The first draft listed the twelve by hand, and a security check caught that a
 * restated list is a correctness risk rather than a style one: the same mistake in
 * the incident row mapper (`features/incidents/live-incident-row.ts`) silently
 * dropped a real `duplicateStatus` because the restated value did not match the
 * enum. Here an unrecognised type degrades to a neutral badge, so a drifted list
 * would show a real notification as generic.
 */
const TYPES: ReadonlySet<string> = new Set<string>(NOTIFICATION_TYPES);

/**
 * One document → one row.
 *
 * **The type is validated against the declared 12-value enum, not a string.**
 * brief §4: "Do not allow arbitrary client-provided notification types. Validate
 * notification type server-side." The server already validates on write
 * (`types/enums.ts` is the single source); this is the client refusing to render a
 * row whose type it does not recognise, so a future enum member cannot appear as a
 * blank badge.
 */
export function toLiveNotification(
  data: Record<string, unknown>,
  id: string,
): LiveNotification {
  const type = typeof data.type === 'string' && TYPES.has(data.type) ? (data.type as NotificationType) : null;
  const severity =
    typeof data.severity === 'string' && SEVERITIES.has(data.severity)
      ? (data.severity as NotificationSeverity)
      : 'info';

  return {
    id,
    // An unrecognised type degrades to the most neutral declared value rather than
    // being dropped: dropping would make a notification silently disappear, and a
    // user who was told something would never learn it was not deliverable.
    type: type ?? 'status_changed',
    severity,
    title: typeof data.title === 'string' ? data.title : 'Update',
    body: typeof data.body === 'string' ? data.body : '',
    incidentId: typeof data.incidentId === 'string' ? data.incidentId : null,
    incidentRef: typeof data.incidentRef === 'string' ? data.incidentRef : null,
    link: typeof data.link === 'string' ? data.link : null,
    read: data.read === true,
    actorName: typeof data.actorName === 'string' ? data.actorName : null,
    createdAtIso: readIso(data.createdAt),
  };
}

/** A Firestore `Timestamp` (or a `Date`, or a number) → ISO, or `null`. */
function readIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/* ========================================================================== */
/* The hook                                                                    */
/* ========================================================================== */

export type RealtimeNotifications = RealtimeStateShape<LiveNotification> & {
  /**
   * Unread among the listener's 50-document window.
   *
   * **Not the total unread count in the database** — `docs/11 §11.2` permits this
   * because it is derived from the same snapshot, and the window is what
   * `docs/13 §3.1` caps the bell at. A user with 60 unread has 50 here, and the UI
   * says so rather than implying they have seen everything.
   */
  readonly unreadCount: number;
  /** `false` until the first snapshot, so the bell never shows a false 0. */
  readonly hasReceivedSnapshot: boolean;
};

export function useRealtimeNotifications(options: { readonly seed?: readonly LiveNotification[] } = {}): RealtimeNotifications {
  const { seed } = options;
  const { user } = useSession();
  const uid = user?.uid ?? null;

  // `docs/11 §3.6`: a string key, so a re-render does not re-subscribe. The uid is
  // the ONLY input — there is no filter to vary, which is SEC-4's point.
  const queryKey = React.useMemo(() => JSON.stringify(['L5', 'notifications', uid]), [uid]);

  const state = useRealtimeListener<LiveNotification>({
    id: 'notifications',
    queryKey,
    // A-4: auth first. A listener attached before the uid is known produces a
    // `permission-denied` first snapshot that then vanishes.
    enabled: uid !== null,
    limit: 50,
    // `docs/11 §3.3`: ON for L5 — the mark-read write is local.
    includeMetadataChanges: true,
    buildQuery: (db) => notificationQuery(db, uid as string),
    map: toLiveNotification,
    ...(seed === undefined ? {} : { seed }),
  });

  const unreadCount = React.useMemo(
    () => state.items.reduce((count, notification) => (notification.read ? count : count + 1), 0),
    [state.items],
  );

  return {
    ...state,
    unreadCount,
    hasReceivedSnapshot: state.lastSyncedAt !== null,
  };
}

/* ========================================================================== */
/* Derived views                                                               */
/* ========================================================================== */

/**
 * The bell's label.
 *
 * **A count of 0 reads "0" rather than nothing**, and above 99 it reads "99+" —
 * a three-digit number in a top bar pushes the layout on a narrow screen, and the
 * distinction between 100 and 160 unread is not one a dispatcher acts on.
 */
export function unreadLabel(count: number): string {
  if (count <= 0) return '0';
  return count > 99 ? '99+' : String(count);
}

/**
 * The most recent CRITICAL notification, for the optional in-app toast.
 *
 * brief §7 says "optionally show a small in-app toast" and §7 also says "Do not
 * create aggressive or distracting popups". So this returns at most ONE item, the
 * caller decides whether to render it, and the item is chosen by severity rather
 * than by recency — a toast is for something a user must act on now, not for the
 * newest row in a list.
 */
export function toastCandidate(
  items: readonly LiveNotification[],
): LiveNotification | null {
  let best: LiveNotification | null = null;
  for (const item of items) {
    if (item.read || item.severity !== 'critical') continue;
    if (best === null) {
      best = item;
      continue;
    }
    // `docs/11 §2.2` orders by `createdAt DESC`, so the first critical is the
    // newest; `best` wins ties by staying put.
    best = best;
  }
  return best;
}

/* ========================================================================== */
/* The read state — `docs/11 §11.3` SEC-5                                       */
/* ========================================================================== */

/**
 * The ONLY client-side write to any operational collection, and only these fields.
 *
 * `firestore.rules` already enforces it — the `notifications` block allows an update
 * only on `read` / `readAt` / `updatedAt` when `recipientUid == auth.uid` — so this
 * helper is a convenience that cannot widen the grant. It exists so the field list
 * is written once rather than at three call sites, and so a future field cannot be
 * added without someone reading the rules alongside it.
 */
export function markReadPatch(now: Date): Record<string, unknown> {
  return { read: true, readAt: now, updatedAt: now };
}

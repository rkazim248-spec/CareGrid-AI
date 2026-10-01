/**
 * ============================================================================
 * CareGrid AI — notification copy, dedupe key and recipient matrix
 * ============================================================================
 *
 * `docs/07 §10.2`, `docs/13 §3.3`, FR-101 / FR-107 / FR-090. **SERVER ONLY.**
 *
 * The WRITE path is `services/notifications/dispatch.ts` — the unified service
 * with channels, delivery status and the retry ceiling. What stayed here is the
 * pure, channel-independent part every channel shares:
 *
 *   - `NOTIFICATION_COPY` — every string a human can read, in one reviewable place
 *   - `FORBIDDEN_NOTIFICATION_CLAIMS` — the overclaims no copy may contain
 *   - `notificationDedupeKey` — the idempotency key the write path dedupes on
 *   - `recipientsForEvent` — who is told what, from `docs/07 §10.2`
 *
 * In-app remains *stored*, not pushed: the Firestore document IS the delivery and
 * the client's listener is the transport. There is no FCM registration and no
 * push call anywhere in this layer, and that absence is the design — `docs/13
 * §3.3`: delivered-while-offline arrives "on next open, as an unread row".
 *
 * ---------------------------------------------------------------------------
 * THE COPY MAY NOT OVERCLAIM
 * ---------------------------------------------------------------------------
 * brief §28: "Do NOT claim 'Emergency services are arriving' unless that is actually
 * verified by the system." Nothing in this file asserts that anyone is en route,
 * on scene, or arriving. A notification says what has been RECORDED — an assignment
 * exists, a status changed — and the status vocabulary is the system's, not a
 * promise about the physical world. `assignmentAccepted` says an assignment was
 * accepted; it does not say the responder is on their way, because acceptance and
 * departure are different events and only the latter would support that claim.
 *
 * This is the same rule as `docs/28` on the AI: the model may not claim to have
 * used a resource it did not, and the notification layer may not claim a responder
 * state the system has not recorded.
 */

import 'server-only';

import type { NotificationSeverity, NotificationType, UserRole } from '@/types';

/* ========================================================================== */
/* Input and output                                                            */
/* ========================================================================== */

/**
 * One notification, before it is addressed.
 *
 * `title` and `body` are REQUIRED from the caller rather than derived from the
 * type. A notification whose text is generated from a type at write time is a
 * notification whose wording nobody reviewed, and "Responder accepted assignment" is
 * exactly the phrasing brief §28 cares about. Making the copy explicit at each call
 * site means a security check can assert what was said, and a wording change is a
 * visible diff rather than a new branch in a switch statement.
 */
export type InAppNotificationSpec = {
  readonly type: NotificationType;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly incidentId: string | null;
  /** The human `CG-XXXXXX` ref, denormalised so a row renders without a read. */
  readonly incidentRef: string | null;
  /** An in-app route for the recipient to land on. Never a signed URL. */
  readonly link: string | null;
  /** Who caused it, for "Ahmed Khan accepted this". */
  readonly actor: { readonly uid: string; readonly displayName: string } | null;
};

/* ========================================================================== */
/* Copy                                                                        */
/* ========================================================================== */

/**
 * The wording, in one place. brief §28.
 *
 * Exported so the tests can assert the absence of an overclaim across every string
 * at once, rather than trusting a review to have read each one.
 */
export const NOTIFICATION_COPY = {
  /** To the responder. `docs/07 §10.2`: `incident_assigned` -> assigned responder, `critical`. */
  assignmentReceived: (reference: string) => ({
    title: 'New emergency assignment',
    // "A dispatcher has assigned you an incident" — it names WHO did it, because a
    // responder deciding whether to accept needs to know whether a person or a
    // system chose. It does not say help is coming, or that anyone is en route.
    body: `A dispatcher has assigned you incident ${reference}. Open it to review the details and accept or decline.`,
  }),

  /** To the dispatcher who assigned. `status_changed` -> all dispatchers, `info`. */
  assignmentAccepted: (reference: string, responderName: string) => ({
    title: 'Assignment accepted',
    body: `${responderName} accepted the assignment for ${reference}.`,
  }),

  /** To the dispatcher who assigned. `responder_unavailable` -> dispatchers who had that responder, `warning`. */
  assignmentDeclined: (reference: string, responderName: string) => ({
    title: 'Assignment declined',
    // Ends with the instruction, not a reassurance. brief §18: a rejection goes
    // "back to the dispatcher" and another responder is chosen by a human.
    body: `${responderName} declined the assignment for ${reference}. Choose another responder or keep the incident pending.`,
  }),

  /**
   * To the reporter. brief §27 and §35.
   *
   * "Your report has been assigned to a responder" is what the system knows. It is
   * NOT "help is on the way" — assignment happens before anyone has accepted, and a
   * responder may decline a minute later.
   */
  reportAssigned: (reference: string) => ({
    title: 'Responder assigned',
    body: `Your report ${reference} has been assigned to a responder.`,
  }),

  /** To the reporter and the assignee. `incident_resolved` -> reporter, dispatchers, assignee, `info`. */
  incidentResolved: (reference: string) => ({
    title: 'Incident resolved',
    body: `Incident ${reference} has been marked resolved.`,
  }),

  /** To the responder. `dispatch_received` -> assigned responder, `critical`. */
  dispatchReceived: (reference: string, category: string, priority: string, location: string, distance: string, resources: string, timeReported: string) => ({
    title: 'New emergency dispatch',
    body: `You have been dispatched to ${reference} (${category}, ${priority}). Location: ${location}. Distance: ${distance}. Required resources: ${resources}. Reported: ${timeReported}. Open to accept or decline.`,
  }),

  /** To the dispatcher. `dispatch_accepted` -> dispatcher, `info`. */
  dispatchAccepted: (reference: string, responderName: string) => ({
    title: 'Dispatch accepted',
    body: `${responderName} has accepted the dispatch for ${reference}.`,
  }),

  /** To the dispatcher. `dispatch_declined` -> dispatcher, `warning`. */
  dispatchDeclined: (reference: string, responderName: string, reason: string | null) => ({
    title: 'Dispatch declined',
    body: `${responderName} declined the dispatch for ${reference}.${reason ? ` Reason: ${reason}` : ''} Choose another responder or keep the incident pending.`,
  }),

  /** To the reporter and assignee. `incident_update` -> relevant parties, `info` or `warning`. */
  incidentUpdate: (reference: string, update: string) => ({
    title: 'Incident update',
    body: `Incident ${reference}: ${update}`,
  }),

  /** System notification. `system` -> relevant parties, `info` or `warning` or `critical`. */
  systemNotification: (title: string, body: string) => ({
    title,
    body,
  }),

  /** To the reporter. `status_changed` -> reporter for terminal states only. */
  incidentCancelled: (reference: string) => ({
    title: 'Report closed',
    body: `Your report ${reference} was closed.`,
  }),
} as const;

/**
 * Phrases a notification may never contain.
 *
 * Each one is a claim about the physical world that the system has not verified at
 * the point the notification is written. `arriving` and `on the way` are the two the
 * brief names; `rescue`/`ambulance` are here for the same reason — a notification
 * saying "an ambulance has been sent" would be a claim about municipal services this
 * system has no integration with, and `docs/27`'s exclusions are explicit that
 * there are none.
 */
export const FORBIDDEN_NOTIFICATION_CLAIMS: readonly string[] = [
  'emergency services are arriving',
  'help is on the way',
  'an ambulance has been sent',
  'police are on the way',
  'rescue is at the scene',
  'we have alerted authorities',
];

/* ========================================================================== */
/* The dedupe key                                                              */
/* ========================================================================== */

/**
 * The idempotency key. `docs/07 §8` names the same idea for dispatches
 * (`notified` / FR-108); this is its per-notification equivalent.
 *
 * **`incidentRef` is in the key, not `incidentId`,** and that is deliberate: it
 * makes a retried request with a *different* target produce a *different* key, so
 * "assign Ahmed" then "assign Sara" then a retry of "assign Ahmed" correctly
 * notifies Ahmed twice and Sara once. A key of `type + incidentId` alone would
 * swallow the second notification, and a dispatcher would be waiting for a
 * responder who was never told.
 */
export function notificationDedupeKey(
  recipientUid: string,
  spec: InAppNotificationSpec,
): string {
  return [
    recipientUid,
    spec.type,
    spec.incidentRef ?? spec.incidentId ?? 'none',
    spec.actor?.uid ?? 'none',
  ]
    .join('|')
    // Firestore doc IDs may not contain `/` and are limited to 1500 bytes. The uid
    // and the ref are already safe, but `actor.uid` is not guaranteed to be, and a
    // slash here would silently write to a nested path.
    //
    // Dots are collapsed to `_` as well. Firestore only treats a path SEGMENT that
    // is exactly `.` or `..` as special, so `u_x..y` is a legal id today — but a
    // key whose safety depends on no component ever being exactly `..` is a key
    // whose safety is one input change away from breaking, and there is no reason
    // to carry that.
    .replace(/\.{2,}/g, '_')
    .replace(/[^A-Za-z0-9_.:-]/g, '_');
}

/* ========================================================================== */
/* Recipient resolution                                                        */
/* ========================================================================== */

/**
 * Who to notify, given the dispatch matrix. `docs/07 §10.2`.
 *
 * A FUNCTION rather than a table because the recipient sets genuinely differ per
 * event and a dispatcher who invented the mapping for one event would get the next
 * one wrong in a way nobody notices until a citizen is not told their report was
 * assigned.
 */
export function recipientsForEvent(
  event: 'assigned' | 'accepted' | 'declined' | 'resolved' | 'cancelled' | 'dispatched' | 'dispatch_accepted' | 'dispatch_declined' | 'incident_update' | 'system',
  actors: {
    readonly responderUid: string | null;
    readonly responderName: string | null;
    readonly dispatcherUid: string | null;
    readonly dispatcherName: string | null;
    readonly reporterUid: string | null;
  },
): { readonly uids: readonly string[]; readonly roles: ReadonlyMap<string, UserRole> } {
  const roles = new Map<string, UserRole>();
  const uids: string[] = [];

  const add = (uid: string | null, role: UserRole): void => {
    if (uid === null || uid === '') return;
    // A uid appearing twice means the same person is in two roles for this event —
    // a dispatcher who is also the reporter, for instance. Notifying them twice
    // would put two rows in their bell for one fact.
    if (roles.has(uid)) return;
    roles.set(uid, role);
    uids.push(uid);
  };

  switch (event) {
    case 'assigned':
      // docs/07 §10.2: `incident_assigned` -> the ASSIGNED RESPONDER.
      add(actors.responderUid, 'responder');
      break;
    case 'dispatched':
      // `dispatch_received` -> the ASSIGNED RESPONDER (critical priority).
      add(actors.responderUid, 'responder');
      break;
    case 'accepted':
    case 'declined':
      // `status_changed` -> all dispatchers; `responder_unavailable` -> the
      // dispatchers who HAD that responder. Narrowed to the assigning dispatcher,
      // because "all dispatchers" is a broadcast and this is one person's answer.
      add(actors.dispatcherUid, 'dispatcher');
      break;
    case 'dispatch_accepted':
      // `dispatch_accepted` -> the assigning dispatcher.
      add(actors.dispatcherUid, 'dispatcher');
      break;
    case 'dispatch_declined':
      // `dispatch_declined` -> the assigning dispatcher.
      add(actors.dispatcherUid, 'dispatcher');
      break;
    case 'resolved':
      // `incident_resolved` -> reporter, all dispatchers, assignee.
      add(actors.reporterUid, 'citizen');
      add(actors.responderUid, 'responder');
      add(actors.dispatcherUid, 'dispatcher');
      break;
    case 'incident_update':
      // `incident_update` -> reporter, assignee, dispatcher.
      add(actors.reporterUid, 'citizen');
      add(actors.responderUid, 'responder');
      add(actors.dispatcherUid, 'dispatcher');
      break;
    case 'system':
      // `system` notification -> all relevant parties (broadcast).
      add(actors.reporterUid, 'citizen');
      add(actors.responderUid, 'responder');
      add(actors.dispatcherUid, 'dispatcher');
      break;
    case 'cancelled':
      // `status_changed` -> the reporter, for terminal states only.
      add(actors.reporterUid, 'citizen');
      break;
  }

  return { uids, roles };
}

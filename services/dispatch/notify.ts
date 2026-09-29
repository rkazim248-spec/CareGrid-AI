/**
 * ============================================================================
 * CareGrid AI — in-app notifications
 * ============================================================================
 *
 * `docs/07 §10.2`, `docs/13 §3.3`, FR-101 / FR-107 / FR-090. **SERVER ONLY.**
 *
 * ---------------------------------------------------------------------------
 * IN-APP IS *STORED*, NOT PUSHED — AND THAT IS THE HONEST VERSION
 * ---------------------------------------------------------------------------
 * `docs/13 §3.3`: "The document is already written by the dedupe transaction. This
 * channel's 'delivery' IS the Firestore document; the client's listener is the
 * transport." And: "Delivered while the client is offline | **On next open**, as an
 * unread row."
 *
 * So there is no FCM registration, no device token, and no push call in this file,
 * and their absence is the design rather than an omission. A responder who has the
 * app closed sees the assignment when they next open it. A dispatcher is told this
 * in the responder-management UI rather than discovering it during an incident,
 * because "you will not be buzzed" is operationally important information and
 * pretending otherwise would be worse than the limitation.
 *
 * ---------------------------------------------------------------------------
 * FR-107: A NOTIFICATION FAILURE MUST NEVER FAIL THE REQUEST
 * ---------------------------------------------------------------------------
 * Every function here is best-effort and returns a result rather than throwing. A
 * dispatch that succeeded but whose notification write failed is still a dispatch,
 * and a responder is still on their way; returning 500 would tell a dispatcher it
 * failed and invite them to assign a second responder to the same incident. The
 * failure is logged at `warn` so it is visible, and the dispatcher UI reads the
 * dispatch document directly, so the state they act on is never the notification.
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

import { FieldValue } from 'firebase-admin/firestore';

import { adminConfigurationReason, getAdminDb } from '@/lib/server/firebase-admin';
import { COLLECTIONS } from '@/config/collections';
import { createLogger } from '@/lib/server/http';
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

export type InAppRecipient = {
  readonly uid: string;
  readonly role: UserRole;
  /** `docs/13 §2.1`'s `notifPrefs.inApp`. Absent means the default, which is on. */
  readonly inAppEnabled?: boolean;
};

export type NotifyOutcome = {
  /** `docs/13`'s `NotifyOutcome`. */
  readonly written: number;
  /** Suppressed by the dedupe record, i.e. this exact notification already exists. */
  readonly deduped: number;
  /** Suppressed because the recipient has in-app notifications turned off. */
  readonly suppressed: number;
  readonly failed: number;
  /** `true` when nothing was attempted — an unconfigured deployment. Not an error. */
  readonly skipped: boolean;
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
/* The write                                                                   */
/* ========================================================================== */

/**
 * Write one in-app notification per recipient. **Never throws.**
 *
 * Each recipient is a SEPARATE write with its own dedupe record, not one batched
 * write. A batch is cheaper, but a batch is all-or-nothing: one bad recipient
 * would cost every other recipient their notification, and the failure would be
 * invisible because nothing would be recorded. Per-recipient writes mean a
 * failure is attributable to a recipient and the rest are unaffected — which is
 * the same reasoning as the per-row audit log.
 */
export async function notifyInApp(
  spec: InAppNotificationSpec,
  recipients: readonly InAppRecipient[],
  requestId: string,
): Promise<NotifyOutcome> {
  if (recipients.length === 0) {
    return { written: 0, deduped: 0, suppressed: 0, failed: 0, skipped: false };
  }
  if (adminConfigurationReason() !== null) {
    return { written: 0, deduped: 0, suppressed: 0, failed: 0, skipped: true };
  }

  let written = 0;
  let deduped = 0;
  let suppressed = 0;
  let failed = 0;

  for (const recipient of recipients) {
    // The preference is checked here rather than in a query so that turning
    // notifications off takes effect on the next write without a migration.
    if (recipient.inAppEnabled === false) {
      suppressed += 1;
      continue;
    }

    try {
      const db = getAdminDb();
      const key = notificationDedupeKey(recipient.uid, spec);
      const notificationRef = db.collection(COLLECTIONS.notifications).doc();
      const dedupeRef = db.collection(COLLECTIONS.notificationReads).doc(key);

      // The dedupe record and the notification are written in ONE transaction, so a
      // notification can never exist without its guard, nor the guard without the
      // notification. `docs/13 §3.3` calls this "the dedupe transaction".
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(dedupeRef);
        if (existing.exists) return; // already notified; the caller counts this as deduped

        transaction.set(dedupeRef, {
          key,
          notificationId: notificationRef.id,
          recipientUid: recipient.uid,
          type: spec.type,
          incidentRef: spec.incidentRef,
          createdAt: FieldValue.serverTimestamp(),
        });

        transaction.set(
          notificationRef,
          {
            notificationId: notificationRef.id,
            recipientId: recipient.uid,
            recipientRole: recipient.role,
            type: spec.type,
            severity: spec.severity,
            title: spec.title,
            body: spec.body,
            incidentId: spec.incidentId,
            incidentRef: spec.incidentRef,
            link: spec.link,
            actorUid: spec.actor?.uid ?? null,
            actorName: spec.actor?.displayName ?? null,
            read: false,
            createdAt: FieldValue.serverTimestamp(),
            expiresAt: null,
          },
          // The notification id is server-generated, so `merge: false` cannot
          // overwrite anything.
          { merge: false },
        );
      });

      written += 1;
    } catch (error) {
      // A duplicate-key race on the dedupe record is the ONE failure that means
      // "someone else already notified them", and it is not a problem worth
      // counting as a failure. Firestore surfaces it as ABORTED or ALREADY_EXISTS.
      const code = readErrorCode(error);
      if (code === 'ABORTED' || code === 'ALREADY_EXISTS') {
        deduped += 1;
        continue;
      }
      failed += 1;
      createLogger(requestId).warn({
        code: 'DB_UNAVAILABLE',
        path: 'services.dispatch.notify',
        status: 503,
        notificationType: spec.type,
        // Deliberately NOT `recipient.uid`: an audit line is not the place for a
        // user identifier, and the notification type plus request id are enough to
        // find the caller.
        errorKind: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  return { written, deduped, suppressed, failed, skipped: false };
}

/**
 * Read a Firestore error's `code`, defensively.
 *
 * The Admin SDK's `FirestoreError` has `.code`, but a `Transaction` can also reject
 * with a plain `Error` from the gRPC layer, and a `code` that is a number rather
 * than the expected string must not be compared as if it were one.
 */
function readErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
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
  event: 'assigned' | 'accepted' | 'declined' | 'resolved' | 'cancelled',
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
    case 'accepted':
    case 'declined':
      // `status_changed` -> all dispatchers; `responder_unavailable` -> the
      // dispatchers who HAD that responder. Narrowed to the assigning dispatcher,
      // because "all dispatchers" is a broadcast and this is one person's answer.
      add(actors.dispatcherUid, 'dispatcher');
      break;
    case 'resolved':
      // `incident_resolved` -> reporter, all dispatchers, assignee.
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

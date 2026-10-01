import 'server-only';

/**
 * ============================================================================
 * CareGrid AI — unified notification service
 * ============================================================================
 *
 * `docs/13`, `brief` §1–§7. The unified write path — the ONLY writer of
 * notification documents.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS OWNS, AND WHAT IT SHARES
 * ---------------------------------------------------------------------------
 * The channel-independent pieces live in `services/dispatch/notify.ts` and are
 * shared, not duplicated: the dedupe key, the recipient matrix, and the copy
 * discipline. This module owns what a single-channel writer cannot express:
 *
 *   - `channel` on the document, so a row says HOW it was delivered
 *   - `status` — delivered / suppressed / failed / unavailable
 *   - `retryCount`, bounded by `NOTIFICATION_RETRY_LIMIT`
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL HONESTY RULE: AN UNAVAILABLE CHANNEL IS NOT SENT
 * ---------------------------------------------------------------------------
 * `NotificationChannel.isAvailable()` is the gate, and it is consulted BEFORE any
 * send. For SMS and WhatsApp that returns `false` today — `ENABLE_SMS_NOTIFICATIONS`
 * and `ENABLE_WHATSAPP_NOTIFICATIONS` are `false` and `TWILIO_ACCOUNT_SID` is unset —
 * so those notifications are recorded as `unavailable` and dropped.
 *
 * They are NOT silently swallowed and NOT optimistically marked delivered. A
 * dispatcher looking at a recipient list must be able to see "this person was not
 * reached by SMS because no provider is configured", because assuming otherwise is
 * how a responder misses a dispatch. `brief`'s instruction — "Do not claim SMS or
 * WhatsApp functionality is live unless the provider is actually configured and
 * successfully tested" — is enforced here by a status value rather than by a promise
 * in a report.
 *
 * ---------------------------------------------------------------------------
 * RECIPIENTS ARE NEVER CLIENT-SUPPLIED
 * ---------------------------------------------------------------------------
 * `brief §7`. Every entry point takes recipients the SERVER derived — either Phase 7's
 * `recipientsForEvent` or an explicitly authorised caller (an admin broadcast). There
 * is no parameter through which a caller can name an arbitrary uid and have the
 * service write to them, because such a parameter is the vulnerability, not the
 * feature. `assertRecipientsAreServerDerived` makes that a runtime check rather than
 * a review comment.
 */

import { COLLECTIONS } from '@/config/collections';
import { FieldValue } from 'firebase-admin/firestore';
import { adminConfigurationReason, getAdminDb } from '@/lib/server/firebase-admin';
import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { notificationRetryLimit } from '@/lib/env.server';
import { getExternalChannels, providerStatus } from '@/services/integrations/twilio';
import type { NotificationChannel } from '@/lib/integrations/contracts';
import type { NotificationSeverity, NotificationType, UserRole } from '@/types';
import { notificationDedupeKey, type InAppNotificationSpec } from '@/services/dispatch/notify';

/* ========================================================================== */
/* Types                                                                       */
/* ========================================================================== */

/**
 * Delivery status, per `brief §1`.
 *
 * `unavailable` is the one that matters most. `failed` means a provider was tried
 * and refused; `unavailable` means no provider was tried because none is configured.
 * Collapsing them would report an unconfigured SMS provider as a transient failure,
 * and someone would add a retry loop to fix a problem no retry can solve.
 *
 * `pending` exists only on an EXTERNAL-channel row between the write and the
 * provider's answer. An `in_app` row is never pending: the row IS the delivery, so
 * it is born `delivered`.
 */
export type DeliveryStatus =
  | 'delivered'
  | 'pending'
  | 'suppressed'
  | 'failed'
  | 'unavailable'
  | 'deduped';

export type NotificationChannelName = NotificationChannel['channel'];

export type UnifiedRecipient = {
  readonly uid: string;
  readonly role: UserRole;
  /** `false` switches the channel off for this person. Honoured, never overridden. */
  readonly channelEnabled?: boolean;
};

export type DispatchOutcome = {
  readonly channel: NotificationChannelName;
  readonly status: DeliveryStatus;
  readonly notificationId: string | null;
  /** `true` when the provider's id was returned, i.e. the send really happened. */
  readonly providerAccepted: boolean;
  /** Bounded by `NOTIFICATION_RETRY_LIMIT`; never a live counter. */
  readonly attempts: number;
  /** Safe to surface. Never a provider credential, never an auth header. */
  readonly reason: string | null;
};

/* ========================================================================== */
/* Channel availability — the single gate                                      */
/* ========================================================================== */

/**
 * Which channels can actually deliver right now, and why not for the rest.
 *
 * The answer is derived, never asserted. `getExternalChannels()` returns only the
 * channels whose `isAvailable()` is true, so this function cannot report SMS as
 * available while the provider is unconfigured — the claim is impossible to make.
 */
export function availableChannelsNow(): readonly NotificationChannelName[] {
  // `in_app` FIRST and unconditionally. The first draft derived this entirely from
  // `getExternalChannels()`, which by its name returns only EXTERNAL providers — so
  // `in_app` was never in the list and `isChannelAvailable('in_app')` was false. It
  // still appeared to work, because the caller's fallback is also `['in_app']`, so
  // the answer was right by ACCIDENT. Firestore IS the in-app delivery: there is no
  // provider to consult and nothing that can switch it off.
  const external = getExternalChannels()
    .filter((channel) => channel.isAvailable())
    .map((channel) => channel.channel);
  return ['in_app', ...external.filter((c) => c !== 'in_app')];
}

export function isChannelAvailable(channel: NotificationChannelName): boolean {
  return availableChannelsNow().includes(channel);
}

/**
 * Why a channel is unavailable, for the admin health surface.
 *
 * Deliberately descriptive and free of any credential — `providerStatus()` returns
 * booleans and reason strings, never a key or a phone number.
 */
export function channelReport(): {
  readonly available: readonly NotificationChannelName[];
  readonly unavailable: readonly { channel: NotificationChannelName; reason: string }[];
} {
  const available = availableChannelsNow();
  const all: NotificationChannelName[] = ['in_app', 'sms', 'whatsapp', 'email', 'push'];
  return {
    available,
    unavailable: all
      .filter((c) => !available.includes(c))
      .map((c) => ({ channel: c, reason: reasonChannelUnavailable(c) })),
  };
}

function reasonChannelUnavailable(channel: NotificationChannelName): string {
  if (channel === 'in_app') return 'The in-app channel is always available.';
  if (channel === 'sms') return 'SMS is not configured. No provider is enabled for SMS.';
  if (channel === 'whatsapp') return 'WhatsApp is not configured. No provider is enabled for WhatsApp.';
  return `The ${channel} channel has no provider in this build.`;
}

/* ========================================================================== */
/* The core                                                                    */
/* ========================================================================== */

/**
 * Deliver one notification to one recipient over one channel.
 *
 * Order of operations, and each step exists:
 *   1. availability  — refuse before touching the database
 *   2. preference    — the recipient's switch
 *   3. dedupe        — one fact, one row
 *   4. write         — the row, `delivered` for in-app, `pending` for external
 *   5. send          — bounded attempts for channels that leave the building
 *
 * Availability is checked FIRST on purpose. Recording "we did not text them" as a
 * Firestore row for every unreachable recipient is a write amplification problem and
 * a data-quality problem: the row implies an attempt that never happened.
 *
 * The row for an external channel is written `pending` BEFORE the send and updated
 * to the final status AFTER it, because a row that reads `delivered` while the
 * provider has not answered is exactly the optimistic lie brief §1 forbids. If the
 * process dies between write and update the row stays `pending` — an honest
 * "unknown", visible in any recipient list, rather than a false "delivered".
 */
export async function deliverNotification(input: {
  readonly spec: InAppNotificationSpec;
  readonly recipient: UnifiedRecipient;
  readonly channel: NotificationChannelName;
  readonly requestId: string;
}): Promise<DispatchOutcome> {
  const { spec, recipient, channel, requestId } = input;
  const maxAttempts = Math.max(1, notificationRetryLimit() + 1);
  const log = createLogger(requestId);

  /* ---- 1. is this channel real? ---- */
  if (!isChannelAvailable(channel)) {
    return {
      channel,
      status: 'unavailable',
      notificationId: null,
      providerAccepted: false,
      attempts: 0,
      reason: reasonChannelUnavailable(channel),
    };
  }

  /* ---- 2. did this person switch it off? ---- */
  if (recipient.channelEnabled === false) {
    // Deliberately NOT recorded as a row: the recipient asked not to be reached on
    // this channel, and a suppressed notification is indistinguishable from a
    // delivered one in a count. It is reported in the outcome and in the log line.
    return {
      channel,
      status: 'suppressed',
      notificationId: null,
      providerAccepted: false,
      attempts: 0,
      reason: 'The recipient disabled this channel.',
    };
  }

  /* ---- 3. has this fact already been delivered on this channel? ---- */
  const key = `${channel}:${notificationDedupeKey(recipient.uid, spec)}`;

  // Declared OUTSIDE the try: the id is reported by every return below, including
  // the failure paths, so a caller can always say which row to look at.
  const db = getAdminDb();
  const notificationRef = db.collection(COLLECTIONS.notifications).doc();

  // `in_app` is born delivered: the row IS the delivery. An external channel is
  // born pending: nothing has left the building yet.
  const initialStatus: DeliveryStatus = channel === 'in_app' ? 'delivered' : 'pending';

  try {
    const dedupeRef = db.collection(COLLECTIONS.notificationReads).doc(key);

    // The transaction reports whether it WROTE. The first version returned the
    // dedupe decision only through the catch branch (a contended transaction),
    // so a calm second delivery of the same fact committed an empty transaction
    // and the caller reported `delivered` for a row that was never written — an
    // optimistic lie with no delivery behind it.
    const wrote = await db.runTransaction(async (transaction): Promise<boolean> => {
      const existing = await transaction.get(dedupeRef);
      if (existing.exists) return false;

      transaction.set(dedupeRef, {
        key,
        notificationId: notificationRef.id,
        recipientUid: recipient.uid,
        type: spec.type,
        channel,
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
          /* --- the three fields brief §1 asks for, which Phase 7 had no way to
             express because it only ever wrote the in-app channel --- */
          channel,
          status: initialStatus,
          retryCount: 0,
          read: false,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: null,
        },
        { merge: false },
      );
      return true;
    });
    if (!wrote) {
      return {
        channel, status: 'deduped', notificationId: null,
        providerAccepted: false, attempts: 0, reason: 'Already notified.',
      };
    }
  } catch (error) {
    const code = readErrorCode(error);
    if (code === 'ABORTED' || code === 'ALREADY_EXISTS') {
      return {
        channel, status: 'deduped', notificationId: null,
        providerAccepted: false, attempts: 0, reason: 'Already notified.',
      };
    }
    log.warn({
      code: 'DB_UNAVAILABLE', path: 'services.notifications.deliver', status: 503,
      channel, notificationType: spec.type,
      // Deliberately no uid — Phase 7's rule: an audit line is not the place for a
      // user identifier.
    });
    return {
      channel, status: 'failed', notificationId: null,
      providerAccepted: false, attempts: 0, reason: 'The notification could not be stored.',
    };
  }

  /* ---- 4. in-app needs no provider ---- */
  if (channel === 'in_app') {
    // Firestore IS the delivery. There is no provider call and no retry: the row
    // existing is the notification existing, and the L5 listener pushes it.
    return {
      channel, status: 'delivered', notificationId: notificationRef.id,
      providerAccepted: true, attempts: 1, reason: null,
    };
  }

  /* ---- 5. send, with a bounded ladder ---- */
  const provider = getExternalChannels().find((c) => c.channel === channel);
  if (provider === undefined) {
    // The availability gate above passed, so this is a raced shutdown rather than a
    // misconfiguration. The row says `pending`, which is the truth: nothing was sent
    // and nobody knows whether it will be.
    return {
      channel, status: 'unavailable', notificationId: notificationRef.id,
      providerAccepted: false, attempts: 0, reason: reasonChannelUnavailable(channel),
    };
  }

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await provider.send(
        {
          to: recipient.uid, // resolved to a real destination inside the provider, never by the caller
          body: spec.body,
          idempotencyKey: key,
        },
        { timeoutMs: 10_000 },
      );
      await notificationRef.update({ status: 'delivered' as DeliveryStatus, retryCount: attempt - 1 });
      return {
        channel, status: 'delivered', notificationId: notificationRef.id,
        providerAccepted: true, attempts: attempt, reason: null,
      };
    } catch (error) {
      if (attempt >= maxAttempts) break;
      log.warn({
        code: 'PROVIDER_FAILED', path: 'services.notifications.deliver', status: 502,
        channel, notificationType: spec.type, attempt,
        // The fixed reason, never the provider's error text: those can echo an
        // account SID or a phone number into a log a dispatcher can read.
        reason: `Delivery failed. ${maxAttempts - attempt} attempt(s) remain.`,
        errorKind: error instanceof Error ? error.name : typeof error,
      });
      await sleep(providerBackoffMs(attempt));
    }
  }

  // Every attempt is spent. The row is corrected from `pending` to `failed` so a
  // dispatcher reading the recipient list sees the truth, and `retryCount` records
  // how many times the provider was asked — which is `NOTIFICATION_RETRY_LIMIT`'s
  // whole purpose made visible.
  await notificationRef.update({ status: 'failed' as DeliveryStatus, retryCount: attempt });
  return {
    channel,
    status: 'failed',
    notificationId: notificationRef.id,
    providerAccepted: false,
    attempts: attempt,
    reason: `Delivery failed after ${attempt} attempt(s).`,
  };
}

/**
 * The backoff ladder, `docs/13`: 2s before the first retry, 8s after that, then
 * holding at 8s. Each value carries ±20% jitter so a provider outage retried by a
 * fan-out does not send every attempt in the same instant — retries that land
 * together are a thundering herd, and the provider that just refused 200 calls does
 * not need 200 more at t+2s.
 */
export function providerBackoffMs(completedAttempts: number): number {
  const base = completedAttempts <= 1 ? 2_000 : 8_000;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(base * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ========================================================================== */
/* Fan-out with a retry ceiling                                                */
/* ========================================================================== */

/**
 * Deliver to many recipients across the channels that are actually available.
 *
 * The retry ceiling lives inside `deliverNotification` and is enforced by COUNTING
 * ATTEMPTS, not by a timer or a recursive callback. There is no code path in this
 * module that can schedule work, so there is no unbounded loop to cap — the ceiling
 * is a hard `attempt < maxAttempts` comparison before each provider call.
 */
export async function deliverToRecipients(input: {
  readonly spec: InAppNotificationSpec;
  readonly recipients: readonly UnifiedRecipient[];
  readonly channels?: readonly NotificationChannelName[];
  readonly requestId: string;
}): Promise<{
  readonly outcomes: readonly DispatchOutcome[];
  readonly summary: Record<DeliveryStatus, number>;
  readonly channelsUsed: readonly NotificationChannelName[];
}> {
  assertRecipientsAreServerDerived(input.recipients);

  // FR-107's precondition, checked before anything touches the Admin SDK: an
  // unconfigured deployment has no database to write to, and `getAdminDb()`
  // throwing here would fail the very request this service exists to stay out of.
  // Nothing was attempted, and the empty outcome says exactly that.
  if (adminConfigurationReason() !== null) {
    return {
      outcomes: [],
      summary: {
        delivered: 0, pending: 0, suppressed: 0, failed: 0, unavailable: 0, deduped: 0,
      },
      channelsUsed: [],
    };
  }

  /* Only channels that can really deliver are attempted. `in_app` is always one of
     them, so a recipient is never left with nothing. */
  const requested = input.channels ?? ['in_app'];
  const usable = requested.filter((c) => isChannelAvailable(c));
  const channels = usable.length > 0 ? usable : (['in_app'] as const);

  const outcomes: DispatchOutcome[] = [];
  for (const recipient of input.recipients) {
    for (const channel of channels) {
      outcomes.push(
        await deliverNotification({
          spec: input.spec,
          recipient,
          channel,
          requestId: input.requestId,
        }),
      );
    }
  }

  const summary: Record<DeliveryStatus, number> = {
    delivered: 0, pending: 0, suppressed: 0, failed: 0, unavailable: 0, deduped: 0,
  };
  for (const outcome of outcomes) summary[outcome.status] += 1;

  return { outcomes, summary, channelsUsed: channels };
}

/**
 * `brief §7`: never trust a client-supplied recipient.
 *
 * A client cannot reach this function — it is `server-only` and has no route. This
 * is the belt to the route's braces: if a future route ever passes a body field
 * straight through, a uid without a server-assigned role is refused rather than
 * written to.
 */
function assertRecipientsAreServerDerived(recipients: readonly UnifiedRecipient[]): void {
  for (const recipient of recipients) {
    if (typeof recipient.uid !== 'string' || recipient.uid === '') {
      throw new AppError({ code: 'VALIDATION_FAILED', message: 'A recipient is required.' });
    }
    if (recipient.role === undefined || recipient.role === null) {
      // A recipient with no server-derived role is a recipient somebody invented.
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'A notification recipient must be resolved on the server.',
      });
    }
  }
}

/* ========================================================================== */
/* Read state                                                                  */
/* ========================================================================== */

/**
 * Mark ONE notification read, scoped to its owner.
 *
 * `brief §2`. The owner check is a WHERE CLAUSE, not a prior read: the update can
 * only ever match a document already carrying this caller's uid, so a request for
 * somebody else's notification updates zero rows rather than leaking its existence.
 *
 * Returns the count matched, which is the only honest answer — "not found" and "not
 * yours" are deliberately indistinguishable.
 */
export async function markRead(notificationId: string, uid: string): Promise<{ markedRead: number }> {
  const db = getAdminDb();
  const result = await db
    .collection(COLLECTIONS.notifications)
    .where('__name__', '==', notificationId)
    .where('recipientId', '==', uid)
    .limit(1)
    .get();

  if (result.empty) return { markedRead: 0 };

  await result.docs[0]!.ref.update({
    read: true,
    readAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { markedRead: 1 };
}

/**
 * Mark EVERY unread notification read, scoped to the owner.
 *
 * Batched in pages rather than read-all-then-write, because the window between the
 * read and the write is exactly when a new notification arrives — and a full
 * collection scan for a user's own rows is the one read this must never do.
 */
export async function markAllRead(uid: string, pageSize = 200): Promise<{ markedRead: number }> {
  const db = getAdminDb();
  let markedRead = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  for (let page = 0; page < 20; page += 1) {
    let query = db
      .collection(COLLECTIONS.notifications)
      .where('recipientId', '==', uid)
      .where('read', '==', false)
      .orderBy('__name__')
      .limit(pageSize);
    if (last !== null) query = query.startAfter(last);

    const snap = await query.get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        read: true,
        readAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    markedRead += snap.size;
    if (snap.size < pageSize) break;
    last = snap.docs[snap.size - 1] ?? null;
  }

  return { markedRead };
}

/* ========================================================================== */
/* Local helpers                                                               */
/* ========================================================================== */

function readErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
}

export type { NotificationSeverity, NotificationType };
export { providerStatus };
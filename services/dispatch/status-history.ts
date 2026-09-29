/**
 * ============================================================================
 * CareGrid AI — incident status history
 * ============================================================================
 *
 * `docs/07 §6`, FR-052. **SERVER ONLY.**
 *
 * ---------------------------------------------------------------------------
 * APPEND-ONLY, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * `docs/07 §6`: "**Append-only.** Never updated, never deleted." brief §24 repeats
 * it: "Do not allow history entries to be silently edited."
 *
 * This is why there is no update function, no delete function, and no id the
 * caller may choose. The only operation is "record that this happened, once". A
 * correction is recorded as a NEW event, and the timeline shows both — which is the
 * behaviour an incident review needs: the record of what was believed at each
 * moment, not the current belief with its history removed.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SUBCOLLECTION AND NOT A COLLECTION
 * ---------------------------------------------------------------------------
 * `docs/07 §1.1`: "Unbounded-growth data that is only read per incident; keeps the
 * `incidents` doc small, and inherits parent rules." The second half is a security
 * property, not just a performance one — a subcollection inherits the parent's
 * rules, so a citizen's read of their own incident's history needs no separate rule
 * to be correct, and a bug in the history rules cannot widen access to the incident
 * itself.
 *
 * ---------------------------------------------------------------------------
 * THE EVENT IS WRITTEN IN THE SAME TRANSACTION AS THE STATE CHANGE
 * ---------------------------------------------------------------------------
 * Every helper here returns a plain object and performs no write. The caller puts
 * it in the same `runTransaction` as the status change. If they were separate
 * writes, an incident could reach `en_route` with no history event, and the audit
 * trail brief §24 requires would have a hole exactly where it matters most — the
 * dispatch timeline.
 *
 * The incident reference is passed IN rather than reconstructed from
 * `COLLECTIONS.incidents`. Admin-SDK's `Transaction` exposes no way to reach the
 * database it belongs to, and the caller already holds the reference it read the
 * incident from — so threading it through is both the only option and the one that
 * cannot disagree about which incident is meant.
 */

import 'server-only';

import { FieldValue, type DocumentReference, type Transaction } from 'firebase-admin/firestore';

import { SUB_COLLECTIONS } from '@/config/collections';
import { HISTORY_EVENT_TYPES, type HistoryEventType, type IncidentStatus } from '@/types';
import type { TransitionRole } from '@/lib/dispatch/transitions';

/**
 * `docs/07 §6`'s `metadata`: "small, non-sensitive: e.g. `{ "slaState": "at_risk" }`".
 *
 * The scalar union is not decoration. It is the same argument as the audit log's
 * `before`/`after`: a coordinate or a report body is not representable here
 * without a cast, so the most likely leak — a caller helpfully passing `geo` into a
 * "small metadata" map — is a type error rather than a review finding.
 */
export type HistoryMetadataValue = string | number | boolean | null;
export type HistoryMetadata = Readonly<Record<string, HistoryMetadataValue>>;

export type StatusHistoryEvent = {
  readonly incidentId: string;
  readonly eventType: HistoryEventType;
  readonly fromStatus: IncidentStatus | null;
  readonly toStatus: IncidentStatus | null;
  readonly actorUid: string;
  readonly actorRole: TransitionRole;
  /** Required for `false_alarm`, `cancelled`, merge and unassign. `docs/07 §6`. */
  readonly reason: string | null;
  /** Responder on-scene note, dispatcher comment. `docs/07 §6`. */
  readonly note: string | null;
  readonly metadata: HistoryMetadata | null;
  readonly requestId: string;
};

export type NewStatusHistoryEvent = Omit<StatusHistoryEvent, 'reason' | 'note' | 'metadata'> &
  Partial<Pick<StatusHistoryEvent, 'reason' | 'note' | 'metadata'>>;

/**
 * The event types that REQUIRE a reason. `docs/07 §6`.
 *
 * Enforced here rather than at each call site, because a history event is exactly
 * the kind of record that is written once, in a hurry, and never read again — the
 * moment to insist is when it is built.
 */
export const REASON_REQUIRED_EVENTS: ReadonlySet<HistoryEventType> = new Set<HistoryEventType>([
  'false_alarm',
  'unassigned',
  'merged',
  'merged_in',
]);

export class MissingHistoryReasonError extends Error {
  readonly eventType: string;
  constructor(eventType: string) {
    super(`A "${eventType}" history event requires a reason.`);
    this.name = 'MissingHistoryReasonError';
    this.eventType = eventType;
  }
}

/**
 * Build a history event. Pure — no write, no clock, no id.
 *
 * `createdAt` is deliberately NOT set here: the caller puts it in the transaction as
 * `FieldValue.serverTimestamp()`, so the event is stamped by the server and not by
 * whatever the application host's clock happened to say.
 *
 * Throws `MissingHistoryReasonError` when a reason-requiring event has none. A
 * blank string counts as none — `"  "` is not a reason, and storing it would
 * produce a row that looks compliant and explains nothing.
 */
export function buildStatusHistoryEvent(input: NewStatusHistoryEvent): StatusHistoryEvent {
  const reason = normaliseReason(input.reason);

  if (REASON_REQUIRED_EVENTS.has(input.eventType) && reason === null) {
    throw new MissingHistoryReasonError(input.eventType);
  }

  return {
    incidentId: input.incidentId,
    eventType: input.eventType,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    reason,
    note: normaliseOptional(input.note),
    metadata: input.metadata ?? null,
    requestId: input.requestId,
  };
}

/** `undefined`, `null` and whitespace all mean "no reason". */
function normaliseReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normaliseOptional(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Write the event into an open transaction, and return its id.
 *
 * The id is generated HERE, by the client, rather than by `.doc()`. That is safe
 * and in fact required: the caller needs the id to return it in the response, and
 * the caller is server code. What makes it safe is that the id is derived from the
 * caller's own request (`requestId` + a sequence number) rather than being
 * attacker-supplied — a client-chosen id is how one actor overwrites another's
 * audit entry, and this is the same defence as `auditLogs`.
 */
export function appendStatusHistoryInTransaction(
  transaction: Transaction,
  incidentRef: DocumentReference,
  event: StatusHistoryEvent,
): string {
  const eventId = `${event.requestId}:${event.eventType}:${event.fromStatus ?? 'none'}->${event.toStatus ?? 'none'}`;

  transaction.set(
    incidentRef.collection(SUB_COLLECTIONS.statusHistory).doc(eventId),
    {
      // `eventId` and `incidentId` are denormalised onto the document, per
      // `docs/07 §6` — reading a history row back must not require walking the
      // parent path to know which incident it belongs to.
      eventId,
      incidentId: event.incidentId,
      eventType: event.eventType,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actorUid: event.actorUid,
      actorRole: event.actorRole,
      reason: event.reason,
      note: event.note,
      metadata: event.metadata,
      requestId: event.requestId,
      createdAt: FieldValue.serverTimestamp(),
    },
    // Append-only: an existing document with this id is an error, not an update.
    { merge: false },
  );

  return eventId;
}

/** The event types, re-exported so a UI does not import from `types/` for one enum. */
export { HISTORY_EVENT_TYPES };
export type { HistoryEventType };

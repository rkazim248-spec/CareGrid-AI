/**
 * ============================================================================
 * CareGrid AI — operational audit log
 * ============================================================================
 *
 * `docs/07 §11.5`, FR-130 / FR-131 / FR-132. **SERVER ONLY.** Never throws.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT `services/ai/audit.ts`
 * ---------------------------------------------------------------------------
 * That module logs what the MODEL did, into `aiRuns`. This one logs what a HUMAN
 * did, into `auditLogs`. They are different collections, different readers
 * (`aiRuns` is dispatcher/admin operational telemetry; `auditLogs` is admin-readable
 * and append-only) and different vocabularies, and conflating them would make a
 * question like "who assigned this incident?" unanswerable.
 *
 * `AUDIT_ACTIONS` already exists in `types/enums.ts` from Phase 3 and already
 * contains every action Phase 7 needs — `incident.assign`, `incident.unassign`,
 * `incident.status_change`, `responder.update`, `notification.sent`. This module
 * does NOT add an enum, because an action outside the enum is an action no
 * compliance review can filter for.
 *
 * ---------------------------------------------------------------------------
 * THE TWO INVARIANTS THAT MATTER
 * ---------------------------------------------------------------------------
 * (1) **APPEND-ONLY.** `merge: false`, no `update`, no `delete`, server-generated
 *     id. `docs/07 §11.5` and `docs/07 §6` both say so for the collections that
 *     must not be rewritable, and a later write that could rewrite an earlier
 *     record defeats the purpose of having one.
 *
 * (2) **NEVER FAILS THE REQUEST THAT CAUSED IT.** `docs/13 §1` makes this a table
 *     row: "A notification failure must never fail the request that caused it"
 *     (FR-107). The same argument applies harder here — a dispatch that succeeded
 *     but failed to write its audit line is still a real dispatch, and returning
 *     500 would tell a dispatcher it failed when a responder was already on their
 *     way. The failure is logged loudly at `warn` instead, because an audit write
 *     failing on every request is an operational problem someone must see.
 *
 * ---------------------------------------------------------------------------
 * `before` / `after` ARE WHITELISTED, NOT FILTERED
 * ---------------------------------------------------------------------------
 * `docs/07 §11.5`: "whitelisted fields only - **never** raw PII or evidence URLs".
 *
 * The distinction is a deny-list versus an allow-list, and it decides whether a
 * future field added to a responder document can leak. A deny-list would let the
 * next `phoneHash` or `location` field through unnoticed; an allow-list means a
 * new field is invisible to the audit until someone deliberately adds it. So
 * `buildAuditDiff` copies only the keys named in the caller's whitelist, and
 * `assertAuditSafe` refuses a whitelist that names a forbidden one.
 */

import 'server-only';

import { adminConfigurationReason, getAdminDb } from '@/lib/server/firebase-admin';
import { COLLECTIONS } from '@/config/collections';
import { createLogger } from '@/lib/server/http';
import type { AuditAction, UserRole } from '@/types';

/* ========================================================================== */
/* The document                                                                */
/* ========================================================================== */

/** `docs/07 §11.5`'s `entityType`. */
export const AUDIT_ENTITY_TYPES = [
  'incident',
  'user',
  'responder',
  'dispatch',
  'config',
  'auth',
  'notification',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * The audit document, minus the fields the caller supplies mechanically.
 *
 * `before` and `after` are `Record<string, string | number | boolean | null>`
 * rather than `unknown`: the type makes an evidence URL or a free-text report
 * unrepresentable without a cast, which is a much stronger statement than a
 * comment.
 */
export type AuditLogDocument = {
  readonly actorUid: string;
  readonly actorRole: UserRole | 'system';
  readonly action: AuditAction;
  readonly entityType: AuditEntityType;
  readonly entityId: string;
  /** The human `CG-XXXXXX` ref, so an audit row is readable without a join. */
  readonly incidentRef: string | null;
  /** <= 200 chars, human-readable. Never a stack trace and never model output. */
  readonly summary: string;
  readonly before: Record<string, string | number | boolean | null> | null;
  readonly after: Record<string, string | number | boolean | null> | null;
  /** Required for privileged actions. `docs/07 §11.5`. */
  readonly reason: string | null;
  readonly requestId: string;
  /** SHA-256(ip + daily salt). NEVER a raw IP. Supplied by the route context. */
  readonly ipHash: string | null;
  /** <= 200 chars. */
  readonly userAgent: string | null;
};

export type AppendAuditInput = Omit<AuditLogDocument, 'incidentRef'> & {
  readonly incidentRef?: string | null;
};

/* ========================================================================== */
/* The whitelist                                                               */
/* ========================================================================== */

/**
 * Field names that may never appear in `before` or `after`, whatever the caller
 * asks for.
 *
 * The rule is about the NAME, not the value, because the dangerous thing about a
 * field called `location` or `text` is that it will hold a coordinate or a report
 * whichever way it is later used. `docs/07 §11.5` and `docs/24` both require the
 * exclusion at the collection boundary rather than trusting each call site.
 */
const FORBIDDEN_AUDIT_FIELDS: ReadonlySet<string> = new Set([
  'location',
  'currentLocation',
  'lastLocation',
  'homeBase',
  'geo',
  'geoCells',
  'coordinates',
  'text',
  'reportText',
  'transcript',
  'aiSummary',
  'summaryText',
  'phone',
  'email',
  'displayName',
  'deviceToken',
  'fcmToken',
  'photoUrl',
  'storagePath',
  'signedReadUrl',
  'downloadUrl',
  'token',
  'apiKey',
  'password',
  'secret',
  'authorization',
  'ip',
  'ipAddress',
  'userAgent',
  'note',
  'verificationNote',
]);

/** The character ceiling on `summary` and `userAgent`. `docs/07 §11.5`. */
const SUMMARY_MAX = 200;
const USER_AGENT_MAX = 200;

/** `docs/07 §11.5`: "reason is required for privileged actions". */
export const PRIVILEGED_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'incident.assign',
  'incident.unassign',
  'incident.merge',
  'incident.merge_revert',
  'incident.status_change',
  'incident.false_alarm',
  'incident.delete',
  'responder.verify',
  'responder.reject',
  'responder.update',
  'responder.location_opt_out',
  'user.role_change',
  'user.disable',
  'user.enable',
  'config.update',
]);

/**
 * Thrown by `assertAuditSafe` when a whitelist names a forbidden field.
 *
 * A distinct class so a route's error handler can recognise it as a programming
 * error (a 500 with a code) rather than a client mistake (a 400). A caller cannot
 * reach this from outside the server, so it is a `Error` and not an `AppError`.
 */
export class UnsafeAuditFieldError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`Refusing to write a forbidden field to the audit log: ${field}`);
    this.name = 'UnsafeAuditFieldError';
    this.field = field;
  }
}

/**
 * Check a whitelist before it is used. Throws rather than filtering.
 *
 * **Throwing is the point.** A silent filter would mean a call site asked to log
 * `phone`, got no `phone`, and had no idea — the audit row would simply be missing
 * a field someone believed they were recording, and the omission would only be
 * discovered during an investigation.
 */
export function assertAuditSafe(whitelist: readonly string[]): void {
  for (const field of whitelist) {
    if (FORBIDDEN_AUDIT_FIELDS.has(field)) throw new UnsafeAuditFieldError(field);
  }
}

/**
 * Copy only the whitelisted keys out of a source object.
 *
 * Values are narrowed to the scalar union the document type allows. An object
 * value — a nested map, an array of evidence — is **dropped**, not stringified:
 * `JSON.stringify` of an evidence array would put a storage path into an audit row,
 * which is precisely what `docs/07 §11.5` forbids.
 */
export function buildAuditDiff(
  source: Readonly<Record<string, unknown>>,
  whitelist: readonly string[],
): Record<string, string | number | boolean | null> | null {
  assertAuditSafe(whitelist);
  const diff: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const field of whitelist) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = source[field];
    if (value === null) {
      diff[field] = null;
      count += 1;
      continue;
    }
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') {
      diff[field] = value as string | number | boolean;
      count += 1;
      continue;
    }
    // Anything else (object, array, function, symbol, bigint) is refused.
  }
  return count === 0 ? null : diff;
}

/* ========================================================================== */
/* The write                                                                   */
/* ========================================================================== */

/** Truncate rather than reject: a long summary is still a useful summary. */
function clamp(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

/**
 * Assemble the document WITHOUT writing it.
 *
 * Split from the write so the shape is unit-testable with no Firestore, and so the
 * field list is reviewable in one place rather than spread through a `set()` call.
 */
export function buildAuditDocument(input: AppendAuditInput): AuditLogDocument {
  return {
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    incidentRef: input.incidentRef ?? null,
    summary: clamp(input.summary, SUMMARY_MAX) ?? '',
    before: input.before,
    after: input.after,
    reason: input.reason,
    requestId: input.requestId,
    ipHash: input.ipHash,
    userAgent: clamp(input.userAgent, USER_AGENT_MAX),
  };
}

/**
 * Write one `auditLogs` document. **Never throws.**
 *
 * Returns the log id on success, or `null` when nothing was written — which is the
 * normal case in an unconfigured deployment and is not an error.
 *
 * The one exception is `UnsafeAuditFieldError`, which is a programming error in the
 * server code rather than a runtime condition, and is rethrown so it cannot be
 * mistaken for a Firestore hiccup. `before`/`after` are validated on the way in
 * rather than trusted, so a bad field name fails loudly at the call site instead
 * of being silently dropped.
 */
export async function appendAuditLog(input: AppendAuditInput): Promise<string | null> {
  // Validate BEFORE the configuration check, so a bad whitelist is reported even
  // in a deployment with no Admin SDK — otherwise the bug would be invisible until
  // the day credentials were added.
  assertAuditSafe(Object.keys(input.before ?? {}));
  assertAuditSafe(Object.keys(input.after ?? {}));

  if (adminConfigurationReason() !== null) return null;

  let document: AuditLogDocument;
  try {
    document = buildAuditDocument(input);
  } catch (error) {
    if (error instanceof UnsafeAuditFieldError) throw error;
    throw error;
  }

  try {
    const db = getAdminDb();
    // A server-generated id: the client never chooses one, and a client-chosen id
    // is how a caller overwrites another actor's audit entry.
    const reference = db.collection(COLLECTIONS.auditLogs).doc();
    // `merge: false`: append-only. `docs/07 §11.5`.
    await reference.set({ ...document }, { merge: false });
    return reference.id;
  } catch (error) {
    createLogger(input.requestId).warn({
      code: 'DB_UNAVAILABLE',
      path: 'services.dispatch.audit',
      status: 503,
      action: input.action,
      // The constructor name only. A Firestore error message can carry the document
      // path and the collection name; there is no reason to put that in a log line,
      // and `entityId` is deliberately not logged either.
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

/**
 * The audit document builder for use INSIDE a transaction.
 *
 * Returns the plain object rather than performing the write, so the caller can put
 * it in the same `runTransaction` as the state change it describes.
 *
 * **This is the important one for Phase 7.** An assignment writes the dispatch, the
 * incident's status, the responder's counters and the history event; if the audit
 * line were a separate call it could fail while all four succeeded, and the most
 * sensitive action in the system would be the one missing from its own audit trail.
 * The trade is accepted deliberately: an audit write inside a transaction that is
 * later retried will be written twice with different ids, so consumers must treat
 * `action + entityId + createdAt` as the identity and not `logId` alone.
 */
export function auditLogInTransaction(input: AppendAuditInput): Record<string, unknown> {
  assertAuditSafe(Object.keys(input.before ?? {}));
  assertAuditSafe(Object.keys(input.after ?? {}));
  return { ...buildAuditDocument(input) };
}

/**
 * ============================================================================
 * CareGrid AI — audit log writer
 * ============================================================================
 *
 * An append-only record of every privileged action (FR-130).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE MODULE FROM `auth-guard`
 * ---------------------------------------------------------------------------
 * Because `auditLog()` must be callable from INSIDE a Firestore transaction.
 * An audit entry written after a transaction commits is an audit entry that can
 * be lost: the transaction succeeds, the process dies, the record of who did
 * what is gone. docs/30 §5.2 lists this as a Phase 2 task for exactly that
 * reason. Taking a `Transaction` makes the coupling explicit at the type level
 * rather than as a comment that a future refactor can delete.
 *
 * ---------------------------------------------------------------------------
 * IMMUTABILITY IS ENFORCED IN TWO PLACES, ON PURPOSE
 * ---------------------------------------------------------------------------
 * 1. `firestore.rules` denies `update` and `delete` on `auditLogs` to every
 *    role, including admin (row 59).
 * 2. Nothing in this file exports an update or a delete. The only writer is
 *    `add`. A capability that is absent cannot be misused, and "we are careful
 *    not to call it" is a weaker guarantee than "there is nothing to call".
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NEVER WRITTEN
 * ---------------------------------------------------------------------------
 * No passwords, no tokens, no private keys, no full request bodies. `before` and
 * `after` are field-level diffs of the record that changed, which is what makes
 * the log reviewable in six months; a whole-document snapshot would leak PII
 * into a collection with a 365-day retention and a broader read audience than
 * the document it describes.
 */

import 'server-only';

import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

import { getAdminDb } from '@/lib/server/firebase-admin';
import { createLogger } from '@/lib/server/http';
import type { AuditAction, UserRole } from '@/types/enums';

export type AuditSeverity = 'info' | 'warn' | 'critical';

export type AuditInput = {
  requestId: string;
  /** `'anonymous'` for an unauthenticated actor. */
  actorUid: string;
  action: AuditAction;
  entityType: 'incident' | 'user' | 'responder' | 'dispatch' | 'config' | 'auth' | 'notification';
  entityId: string;
  /** The human-facing reference, e.g. `CG-7QK4M2`, when there is one. */
  incidentRef?: string | null;
  summary: string;
  /** Field-level values BEFORE the change. Never a whole document. */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  severity?: AuditSeverity;
  actorRole?: UserRole | 'system' | 'anonymous';
  /** True when the request carried a client IP worth hashing (FR-135). */
  hasIp?: boolean;
};

/** The document shape, with a `schemaVersion` so a future change is detectable. */
function buildAuditDocument(input: AuditInput) {
  return {
    actorUid: input.actorUid,
    actorRole: input.actorRole ?? 'anonymous',
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    incidentRef: input.incidentRef ?? null,
    summary: input.summary,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    requestId: input.requestId,
    severity: input.severity ?? 'info',
    hasIp: input.hasIp ?? false,
    schemaVersion: 1,
    createdAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Write an audit entry OUTSIDE any transaction.
 *
 * `createdAt` uses `FieldValue.serverTimestamp()` rather than a client clock.
 * A server clock that is wrong is bad; a CLIENT clock that is wrong makes the
 * log reorderable by whoever wants it reordered, and an audit log that can be
 * reordered is decoration.
 */
export async function auditLog(input: AuditInput): Promise<string> {
  const log = createLogger(input.requestId);
  try {
    const ref = await getAdminDb().collection('auditLogs').add(buildAuditDocument(input));
    if (input.severity === 'warn' || input.severity === 'critical') {
      // A warn/critical audit entry is also a server log line, so it is visible
      // without a Firestore console open. An admin who suspended an account
      // should not have to be looking at a database to notice.
      log.warn({ action: input.action, entityType: input.entityType, entityId: input.entityId });
    }
    return ref.id;
  } catch (error) {
    // Deliberately swallowed, and deliberately important: the audit write must
    // NOT roll back or fail the action it is recording. A user whose dispatch
    // was rejected because the audit collection was briefly unavailable would
    // be a much worse outcome than a missing audit line. The failure is logged;
    // alerting on it is a Phase 3 concern.
    log.error({ action: input.action, code: 'AUDIT_WRITE_FAILED' });
    void error;
    return '';
  }
}

/**
 * Write an audit entry INSIDE a transaction.
 *
 * `tx.set(...)` participates in the commit, so either both the business change
 * and its audit entry land, or neither does. Use this for every privileged
 * mutation: a role change, an account suspension, a responder verification.
 *
 * The `db` parameter is only there because `Transaction.collection()` is not on
 * the public `Transaction` type in `firebase-admin`. Passing the Firestore handle
 * keeps the write going through the transaction rather than accidentally falling
 * back to a direct `db.collection().add()` — which is exactly the bug this
 * function exists to prevent, so the correct handle has to be an explicit
 * argument.
 */
export function auditLogInTransaction(
  tx: Transaction,
  db: Firestore,
  input: AuditInput,
): void {
  const ref = db.collection('auditLogs').doc();
  tx.set(ref, buildAuditDocument(input));
}

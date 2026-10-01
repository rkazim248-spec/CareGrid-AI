/**
 * ============================================================================
 * CareGrid AI — the admin user-management service (Phase 14)
 * ============================================================================
 *
 * `GET /api/admin/users`, `POST /api/admin/users/:uid/role`,
 * `POST /api/admin/users/:uid/account-status`.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE MOST DANGEROUS FILE IN THE ADMIN SURFACE
 * ---------------------------------------------------------------------------
 * It moves accounts between roles. A bug here is not a stale counter; it is an
 * attacker making themselves an administrator, or an administrator made unable to
 * act. Every rule below exists because of a specific way that goes wrong.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE RULES
 * ---------------------------------------------------------------------------
 *
 *   1. **The target's role is re-read INSIDE the transaction.** Not from the
 *      request, not from the caller's token — from Firestore, inside the write.
 *      `requireUser` already reads it for the CALLER, but the TARGET is a
 *      different document, and a caller who fetched the user list a minute ago may
 *      be acting on a role that has since changed.
 *
 *   2. **Nobody changes their own role** (`assertNotSelfRoleChange`). This is the
 *      r61 hard denial, and it is enforced here as well so the refusal happens in
 *      the transaction rather than only in the matrix. An admin fixing their own
 *      mistake must ask another admin. That inconvenience is the control.
 *
 *   3. **The audit entry is in the SAME transaction** as the role change
 *      (`auditLogInTransaction`). A role change whose audit write can fail
 *      independently is a role change that might have happened with no record of
 *      who did it — the single worst artefact to be missing from a security log.
 *      The known trade is that a retried transaction writes the audit entry twice
 *      under different ids, so consumers key on `action + entityId + createdAt`.
 *
 *   4. **A role change cannot carry an account status change.** The two are
 *      separate endpoints with separate audit actions, because they have different
 *      blast radii: a wrong role grants access, a wrong status denies it. One
 *      endpoint that does both would mean an operator's "promote and reactivate"
 *      click is a single unaudited step.
 *
 *   5. **The target's claim drift is reported, not silently ignored.** If the
 *      target's ID token claims a role that disagrees with the document, the change
 *      still applies to the document — the document is authoritative — but the
 *      drift is recorded so an operator can investigate why the two diverged.
 *
 * ---------------------------------------------------------------------------
 * WHAT NEVER APPEARS IN AN AUDIT DIFF HERE
 * ---------------------------------------------------------------------------
 * `services/dispatch/audit.ts` forbids `email`, `displayName`, `phone`, and the
 * credential names in any `before`/`after`, so the diffs here carry only `role`
 * and `status`. The email of a user being suspended is not in the security log —
 * it is in the user document, where it belongs.
 */

import 'server-only';

import { FieldValue, type DocumentData, type QueryDocumentSnapshot } from 'firebase-admin/firestore';

import { COLLECTIONS } from '@/config/collections';
import { AppError } from '@/lib/server/errors';
import { getAdminDb } from '@/lib/server/firebase-admin';
import {
  assertNotSelfDisable,
  assertNotSelfRoleChange,
  asUserRole,
} from '@/lib/server/auth-guard';
import { requireCapability } from '@/lib/server/permissions';
import { auditLogInTransaction } from '@/services/dispatch/audit';
import type { RequestContextLite } from '@/services/dispatch/lifecycle';
import { readBoolean, readString, toIso } from '@/lib/server/serialize';
import type { AuthedUser } from '@/lib/server/auth-guard';
import type { AccountStatus, UserRole } from '@/types/enums';
import {
  buildFilters,
  deletedFilter,
  DOC_ID_TIEBREAK,
  inFilter,
  runPagedQuery,
} from '@/services/admin/query';

import type { AdminPage } from '@/services/admin/query';

/* ========================================================================== */
/* The list shape                                                               */
/* ========================================================================== */

export type AdminUserRow = {
  readonly uid: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly status: AccountStatus;
  readonly emailVerified: boolean;
  readonly provider: string;
  readonly createdAt: string | null;
  readonly lastLoginAt: string | null;
  /** True when the user's ID token claims disagree with the document. */
  readonly claimDrift: boolean;
};

export type ListUsersQuery = {
  readonly role?: readonly UserRole[];
  readonly status?: readonly AccountStatus[];
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
};

export type ListUsersResult = {
  readonly users: AdminUserRow[];
  readonly page: AdminPage;
};

/* ========================================================================== */
/* GET /api/admin/users                                                         */
/* ========================================================================== */

/**
 * The user directory.
 *
 * Sorted by `displayName` with the document id as tiebreak, because an operator
 * looking for a person looks for a NAME and a directory sorted by uid forces a
 * linear scan with the uid in hand — which they will not have.
 *
 * `q` is matched against `displayName` ONLY, never against `email`. Email is the
 * natural thing for an operator to search by, and `q` is a single field on the
 * document that Firestore can serve from an index; adding email means a range scan
 * over a collection where email is not indexed, which is a full collection read
 * behind one keystroke of a search box. The cost of that is a DoS an operator can
 * trigger by accident, so the filter says what it searches and the UI offers the
 * uid field explicitly.
 */
export async function listUsers(
  actor: AuthedUser,
  query: ListUsersQuery,
): Promise<ListUsersResult> {
  requireCapability(actor, 'r52_listUsers', { requestId: 'admin.users.list' });

  const filters = buildFilters(
    inFilter('role', query.role),
    inFilter('status', query.status),
    ...(query.q === undefined ? [] : [{ field: 'displayName', op: '>=' as const, value: query.q }]),
    deletedFilter(undefined),
  );

  const page = await runPagedQuery<AdminUserRow>({
    collection: getAdminDb().collection(COLLECTIONS.users),
    filters,
    // `displayName` then the id. See the note above on why not uid.
    sort: ['displayName', DOC_ID_TIEBREAK],
    limit: query.limit,
    cursor: query.cursor,
    // The fingerprint covers the query as the CLIENT asked for it, including the
    // search term, so a cursor cannot be carried from one search to another.
    fingerprintParts: {
      kind: 'users',
      role: query.role,
      status: query.status,
      q: query.q,
    },
    serialize: toUserRow,
  });

  return { users: page.items, page: page.page };
}

function toUserRow(doc: QueryDocumentSnapshot<DocumentData>): AdminUserRow {
  const data = doc.data();
  return {
    uid: doc.id,
    email: readString(data, 'email'),
    displayName: readString(data, 'displayName'),
    role: asUserRole(data.role) ?? 'citizen',
    status: readAccountStatus(data.status),
    emailVerified: readBoolean(data, 'emailVerified'),
    provider: readString(data, 'provider'),
    createdAt: toIso(data.createdAt),
    lastLoginAt: toIso(data.lastLoginAt),
    claimDrift: hasClaimDrift(data),
  };
}

/**
 * Whether the document's own `claimedRole` disagrees with `role`.
 *
 * `requireUser` compares the TOKEN claim to the document and audits the mismatch
 * for the caller. This is the same check made visible for the TARGET, because an
 * admin changing someone's role is exactly the moment where a pre-existing drift
 * is worth knowing about — a document that says `admin` while the token says
 * `citizen` means somebody got there by a path this codebase does not have.
 */
function hasClaimDrift(data: Record<string, unknown>): boolean {
  const claimed = data.claimedRole;
  if (typeof claimed !== 'string') return false;
  return claimed !== data.role;
}

/**
 * Narrow an unknown `status` from Firestore to a real one.
 *
 * An unrecognised value becomes `pending_verification`, which BLOCKS every API
 * call (docs/22 §1). Defaulting to `active` would fail OPEN on a document this
 * code does not understand, which is the wrong direction for every error in this
 * file: an unknown account state is a reason to lock it down and investigate, not
 * a reason to grant it access.
 */
function readAccountStatus(value: unknown): AccountStatus {
  if (
    value === 'active' ||
    value === 'pending_verification' ||
    value === 'suspended' ||
    value === 'disabled'
  ) {
    return value;
  }
  return 'pending_verification';
}

/* ========================================================================== */
/* POST /api/admin/users/:uid/role                                              */
/* ========================================================================== */

export type ChangeRoleInput = {
  readonly targetUid: string;
  readonly role: UserRole;
  readonly reason: string;
  readonly context: RequestContextLite;
};

/**
 * Change a user's role. Transactional, with the audit entry inside it.
 *
 * Returns the new role, or `noop` when it already matched — repeating a change is
 * `200` with `meta.noop: true`, matching the incident transition's documented
 * behaviour, so a retried request is not an error.
 */
export async function changeUserRole(
  actor: AuthedUser,
  input: ChangeRoleInput,
): Promise<{ readonly role: UserRole; readonly noop: boolean }> {
  // Rule 2, before any write. The hard denial in `lib/server/permissions.ts` also
  // refuses r61 for every role; asserting here means the refusal names the reason
  // even if a future matrix edit granted the capability.
  assertNotSelfRoleChange(actor.uid, input.targetUid);
  // Defence in depth. The route already called this, so a caller arriving here has
  // been checked twice — which is the point: the route and the service are two
  // files that can drift, and only one of them is a unit test away.
  requireCapability(actor, 'r53_changeUserRole', input.context);

  const db = getAdminDb();
  let outcome: { role: UserRole; noop: boolean } | null = null;

  try {
    await db.runTransaction(async (transaction) => {
      const ref = db.collection(COLLECTIONS.users).doc(input.targetUid);
      const snap = await transaction.get(ref);

      // A missing user is a 404, NOT a silent create. Creating a user document
      // for an account that has no profile would produce an account with no
      // profile and a role, which is the beginning of a very confusing support
      // ticket.
      if (!snap.exists) {
        throw new AppError({ code: 'USER_NOT_FOUND', message: 'We could not find that account.' });
      }

      const data = snap.data() as Record<string, unknown>;
      const currentRole = asUserRole(data.role) ?? 'citizen';

      if (currentRole === input.role) {
        outcome = { role: input.role, noop: true };
        return;
      }

      transaction.update(ref, {
        role: input.role,
        roleChangedAt: FieldValue.serverTimestamp(),
        // The uid of whoever made the change, so the document carries its own
        // provenance and a support question ("who made me a dispatcher?") is
        // answerable from the user document alone.
        roleChangedBy: actor.uid,
        schemaVersion: FieldValue.increment(1),
      });

      transaction.set(
        db.collection(COLLECTIONS.auditLogs).doc(),
        auditLogInTransaction({
          actorUid: actor.uid,
          actorRole: actor.role,
          action: 'user.role_change',
          entityType: 'user',
          entityId: input.targetUid,
          summary: `Role changed from ${currentRole} to ${input.role}.`,
          before: { role: currentRole },
          after: { role: input.role },
          reason: input.reason,
          requestId: input.context.requestId,
          ipHash: input.context.ipHash,
          userAgent: input.context.userAgent,
        }),
      );

      outcome = { role: input.role, noop: false };
    });
  } catch (error) {
    rethrowForUserMutation(error, input.targetUid);
  }

  /* c8 ignore next 3 -- the transaction always assigns `outcome` or throws. */
  if (outcome === null) {
    throw new AppError({ code: 'DB_UNAVAILABLE', message: 'The database is temporarily unavailable.' });
  }
  return outcome;
}

/* ========================================================================== */
/* POST /api/admin/users/:uid/account-status                                   */
/* ========================================================================== */

export type ChangeAccountStateInput = {
  readonly targetUid: string;
  readonly status: AccountStatus;
  readonly reason: string;
  readonly context: RequestContextLite;
};

/**
 * Suspend or reactivate an account. Transactional, audited inside the transaction.
 *
 * Refuses a self-suspension: an admin who locks themselves out is not recoverable
 * through this API, and the only recovery is another admin or the Firebase
 * console. A self-disable guard is in the matrix as a hard property of the system,
 * not an oversight of this route.
 *
 * `pending` is accepted as a target status because it is the safe direction — it
 * blocks every API call — and an operator restoring a mistakenly-suspended
 * responder needs a way to put them into a state where they can be re-verified
 * rather than straight back into service.
 */
export async function changeAccountState(
  actor: AuthedUser,
  input: ChangeAccountStateInput,
): Promise<{ readonly status: AccountStatus; readonly noop: boolean }> {
  assertNotSelfDisable(actor.uid, input.targetUid);
  requireCapability(actor, 'r54_enableSuspendAccount', input.context);

  const db = getAdminDb();
  let outcome: { status: AccountStatus; noop: boolean } | null = null;

  try {
    await db.runTransaction(async (transaction) => {
      const ref = db.collection(COLLECTIONS.users).doc(input.targetUid);
      const snap = await transaction.get(ref);

      if (!snap.exists) {
        throw new AppError({ code: 'USER_NOT_FOUND', message: 'We could not find that account.' });
      }

      const data = snap.data() as Record<string, unknown>;
      const currentStatus = readAccountStatus(data.status);

      if (currentStatus === input.status) {
        outcome = { status: input.status, noop: true };
        return;
      }

      transaction.update(ref, {
        status: input.status,
        statusChangedAt: FieldValue.serverTimestamp(),
        statusChangedBy: actor.uid,
        // The reason lives on the DOCUMENT as well as in the audit log, because the
        // person affected will ask "why am I suspended?" and the audit log is not
        // something they can read. `services/dispatch/audit.ts` forbids
        // `disabledReason` in an audit DIFF, which is exactly why this copy has to
        // be on the user document instead.
        ...(input.status === 'suspended' ? { disabledReason: input.reason } : {}),
        ...(input.status !== 'suspended' ? { disabledReason: FieldValue.delete() } : {}),
        schemaVersion: FieldValue.increment(1),
      });

      transaction.set(
        db.collection(COLLECTIONS.auditLogs).doc(),
        auditLogInTransaction({
          actorUid: actor.uid,
          actorRole: actor.role,
          action: input.status === 'suspended' ? 'user.disable' : 'user.enable',
          entityType: 'user',
          entityId: input.targetUid,
          summary:
            input.status === 'suspended'
              ? 'Account suspended.'
              : `Account status changed to ${input.status}.`,
          before: { status: currentStatus },
          after: { status: input.status },
          reason: input.reason,
          requestId: input.context.requestId,
          ipHash: input.context.ipHash,
          userAgent: input.context.userAgent,
        }),
      );

      outcome = { status: input.status, noop: false };
    });
  } catch (error) {
    rethrowForUserMutation(error, input.targetUid);
  }

  /* c8 ignore next 3 */
  if (outcome === null) {
    throw new AppError({ code: 'DB_UNAVAILABLE', message: 'The database is temporarily unavailable.' });
  }
  return outcome;
}

/* ========================================================================== */
/* Helpers                                                                      */
/* ========================================================================== */

/**
 * Translate a transaction failure into an `AppError`.
 *
 * Firestore's own errors are not `AppError`s, so an unhandled one escapes to the
 * wrapper and becomes a `500` with the SDK's message in the log — which names the
 * collection and the document id. `toAppError` in `lib/server/errors.ts` handles
 * the known ones; this function exists so a missing document discovered INSIDE a
 * transaction surfaces as the same `404` as one discovered outside it.
 */
function rethrowForUserMutation(error: unknown, targetUid: string): never {
  if (error instanceof AppError) throw error;
  if (error instanceof Error && /NOT_FOUND|not found/i.test(error.message)) {
    throw new AppError({
      code: 'USER_NOT_FOUND',
      message: 'We could not find that account.',
      details: [{ field: 'uid', issue: `No account for ${targetUid.slice(0, 8)}.` }],
    });
  }
  throw error;
}
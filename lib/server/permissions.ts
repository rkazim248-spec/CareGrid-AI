/**
 * ============================================================================
 * CareGrid AI — server-side permission enforcement
 * ============================================================================
 *
 * `assertRole` answers "is this ROLE allowed to do this?". This module answers
 * "is this ROLE allowed to do this **CAPABILITY**?", using the 61-row matrix in
 * `lib/auth/permissions.ts` — the same data the UI renders from, evaluated on
 * the server.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND GATE WHEN THE MATRIX IS ALREADY THERE
 * ---------------------------------------------------------------------------
 * Because `can(role, capability)` is a lookup the CLIENT also performs, and a
 * lookup the client performs is an affordance, not a grant. What the server
 * needs is a function that THROWS, and it is the throwing that matters:
 *
 *   - `assertRole(user, ['dispatcher','admin'])` is a second, hand-maintained
 *     list. It can disagree with row 29 of the matrix, and when it does, the
 *     disagreement is invisible — both are plausible and neither is checked
 *     against the other.
 *   - `requireCapability(user, 'r29_assignResponder')` names the matrix row. If
 *     the matrix changes, the route changes with it. If the matrix row is
 *     removed, this is a COMPILE error, which is the only kind of drift that is
 *     worth anything.
 *
 * docs/32 MUST NOT 2 and MUST 10 both depend on that: a capability that does not
 * exist cannot be granted by a route that references it.
 *
 * ---------------------------------------------------------------------------
 * THE TWO HARD DENIALS ARE ENFORCED HERE, NOT "UPSTREAM SOMEWHERE"
 * ---------------------------------------------------------------------------
 * Rows 59 and 61 are denied for every role including admin. They are the two
 * checks most likely to be simplified away under deadline pressure, so they are
 * a named check in the enforcement path AND a frozen `Set` in the data. A
 * comment does not fail a test; a `Set` does.
 */

import 'server-only';

import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { auditLog } from '@/lib/server/audit';
import {
  CAPABILITY_KEYS,
  HARD_DENIALS,
  can,
  levelOf,
  type CapabilityKey,
  type PermissionLevel,
} from '@/lib/auth/permissions';
import type { UserRole } from '@/types/enums';

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

export type CapabilityRef = CapabilityKey;

/**
 * The narrowest caller shape the gate needs.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `AuthedUser`
 * ---------------------------------------------------------------------------
 * Because the gate reads exactly two fields: `uid` (for the audit row) and `role`
 * (for the matrix). Declaring the wider type would make every caller construct a
 * full `AuthedUser` — including a `DecodedIdToken` — to satisfy a signature that
 * never touches it, which is exactly the kind of friction that ends with a
 * fabricated token in a test or a `as AuthedUser` cast in production code.
 *
 * `AuthedUser` is structurally assignable to this, so a real caller is unaffected.
 */
export type CapabilityCaller = {
  readonly uid: string;
  readonly role: UserRole;
};

/**
 * A caller identified by ROLE only.
 *
 * For the three functions that ask a question rather than gate a request —
 * `hasCapability`, `capabilityLevel`, `isOps` — the uid is not consulted, and a
 * signature that demands one invites a fabricated value at every call site.
 */
export type RoleHolder = {
  readonly role: UserRole;
};

export type CapabilityCheck = {
  readonly user: CapabilityCaller;
  readonly capability: CapabilityKey;
  /** The matrix row's requirement, for the audit entry and the log. */
  readonly required: PermissionLevel;
  readonly granted: boolean;
};

/* ========================================================================== */
/* The gate                                                                   */
/* ========================================================================== */

/**
 * Require a capability. Throws `403 FORBIDDEN` when the role does not have it.
 *
 * The returned value is the CALLER, not a boolean, so a call site cannot write
 * `if (!requireCapability(...))` and get a truthy `AuthedUser`. There is no
 * `tryRequireCapability` that yields `{ ok: false }` for the same reason
 * `requireUser` has no `tryAuthenticate`: a caller that forgets to check is
 * exactly how an unauthenticated path becomes authenticated by accident.
 *
 * `readonly` returns `false` here, which is the one judgement call worth
 * spelling out. A `readonly` capability means the DATA is visible with fields
 * removed; the ACTION is not available. A server that permitted the action
 * would be promising something the permission matrix says no role has.
 *
 * `scoped` returns `true` and the SCOPE is evaluated by the caller — the
 * resource gate, `assertResourceAccess`. A `scoped` capability whose scope has
 * not been checked is a bug in the route, not in this function, and the
 * comment at the call site is where that belongs.
 */
export function requireCapability(
  user: CapabilityCaller,
  capability: CapabilityKey,
  options: { readonly requestId: string } = { requestId: '' },
): CapabilityCaller {
  // The hard denials run FIRST, before the matrix lookup, so a bug in the
  // matrix transcription cannot open them up.
  if (HARD_DENIALS.has(capability)) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'That action is denied to every role, including an administrator.',
    });
  }

  if (can(user.role, capability)) {
    // A granted capability on a `scoped` row is a REMINDER, not a grant: the
    // resource gate still has to run. Logging it here means a log line exists
    // for every scoped decision, so "the route checked the capability but not
    // the scope" is visible rather than a comment nobody reads.
    if (levelOf(user.role, capability) === 'scoped' && options.requestId !== '') {
      createLogger(options.requestId).debug({ actorUid: user.uid, action: capability });
    }
    return user;
  }

  throw new AppError({
    code: 'FORBIDDEN',
    message: 'You do not have permission for that action.',
  });
}

/**
 * The boolean form, for a DECISION the route has to make rather than a guard it
 * has to pass.
 *
 * A list route needs this: "should I include the `reporter` field in this row?"
 * is a conditional, not a refusal. Returning `false` for `readonly` and `denied`
 * matches `can()` exactly, so there is one definition of availability.
 */
export function hasCapability(user: RoleHolder, capability: CapabilityKey): boolean {
  return can(user.role, capability);
}

/**
 * The matrix level, for a route that renders differently for ◐ and ○.
 *
 * The server does not usually need this — a `readonly` capability is a
 * redaction profile, not a different response. It exists so a route that must
 * distinguish them reads the same source as the client rather than a second
 * hard-coded list.
 */
export function capabilityLevel(
  user: RoleHolder,
  capability: CapabilityKey,
): PermissionLevel {
  return levelOf(user.role, capability);
}

/**
 * Require EVERY capability in a list. Used where an action is genuinely
 * conjunctive, and named so the intent is explicit at the call site.
 */
export function requireAllCapabilities(
  user: CapabilityCaller,
  capabilities: readonly CapabilityKey[],
  options: { readonly requestId: string },
): CapabilityCaller {
  for (const capability of capabilities) {
    requireCapability(user, capability, options);
  }
  return user;
}

/* ========================================================================== */
/* Role gates, expressed through the matrix                                    */
/* ========================================================================== */

/**
 * The role gate, kept because some operations are genuinely about a ROLE and
 * not about a capability — an admin listing users is row 52, and there is no
 * more precise way to say it.
 *
 * `admin` is NOT an implicit superuser. Every call lists what it accepts,
 * because "admin can do everything" is how a permission matrix quietly stops
 * being a matrix (docs/22 §3, rows 52-61 are admin-only, and 59 and 61 deny
 * admin too).
 */
export function requireRole(user: CapabilityCaller, allowed: readonly UserRole[]): CapabilityCaller {
  if (allowed.includes(user.role)) return user;
  throw new AppError({ code: 'FORBIDDEN' });
}

/** Dispatcher or admin. The two operational roles. */
export function isOps(user: RoleHolder): boolean {
  return user.role === 'dispatcher' || user.role === 'admin';
}

/* ========================================================================== */
/* The audit trail for a refusal                                               */
/* ========================================================================== */

/**
 * Record a REFUSED privileged action.
 *
 * ---------------------------------------------------------------------------
 * WHY A DENIAL IS AUDITED AND A SUCCESS IS NOT
 * ---------------------------------------------------------------------------
 * A successful privileged action is already in the audit log, written by the
 * service that performed it. A refusal has no other trace, and a refusal is
 * the interesting one: a script probing `/api/admin/users` leaves a record of
 * every capability it tried. docs/10 §2 and docs/16 §2 both call for it.
 *
 * The audit write must not turn a 403 into a 500. An attacker who can make the
 * audit collection unavailable should not thereby gain a louder signal than the
 * 403 they already have, so the write is best-effort and a failure is logged.
 */
export async function auditRefusal(input: {
  readonly requestId: string;
  readonly user: CapabilityCaller;
  readonly capability: CapabilityKey;
  readonly required: PermissionLevel;
  readonly entityType: 'incident' | 'user' | 'responder' | 'dispatch' | 'config' | 'auth' | 'notification';
  readonly entityId: string;
  readonly reason?: string;
}): Promise<void> {
  const check: CapabilityCheck = {
    user: input.user,
    capability: input.capability,
    required: input.required,
    granted: false,
  };
  try {
    await auditLog({
      requestId: input.requestId,
      actorUid: input.user.uid,
      actorRole: input.user.role,
      action: 'auth.blocked',
      entityType: input.entityType,
      entityId: input.entityId,
      summary: `Refused: role ${input.user.role} lacks ${input.capability} (requires ${input.required})`,
      before: { claimedCapability: input.capability, required: input.required },
      after: { role: input.user.role, granted: check.granted },
      reason: input.reason ?? null,
      severity: 'warn',
    });
  } catch {
    // `auditLog` already swallows its own write failures and logs them, so this
    // catch is belt-and-braces for a future change that makes it throw.
  }
}

/* ========================================================================== */
/* Self-consistency                                                           */
/* ========================================================================== */

/**
 * `true` when `capability` names a real matrix row.
 *
 * Used at the boundary of anything that accepts a capability from a CONFIG
 * rather than from source — a maintenance job name, a feature flag. A typo in
 * source is a compile error; a typo in a configuration string is not, and
 * `can()` returning `false` for an unknown key would silently deny a legitimate
 * action rather than reporting the mistake.
 */
export function isCapabilityKey(value: string): value is CapabilityKey {
  return (CAPABILITY_KEYS as readonly string[]).includes(value);
}

/**
 * Narrow a configured string to a capability, or throw `422 INVALID_CAPABILITY`.
 *
 * `422` and not `500`: the request was well-formed, the domain refused the
 * value, and the caller can fix it. docs/16 §3.3.
 */
export function asCapabilityKey(value: string): CapabilityKey {
  if (isCapabilityKey(value)) return value;
  throw new AppError({
    code: 'INVALID_CAPABILITY',
    message: `"${value}" is not a capability this system has.`,
    details: [{ field: 'capability', issue: 'invalid_enum_value' }],
  });
}

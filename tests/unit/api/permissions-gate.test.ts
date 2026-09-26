import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_KEYS,
  HARD_DENIALS,
  PERMISSION_MATRIX,
  can,
  capabilityListFor,
  isReadOnly,
  isScoped,
  levelOf,
  type CapabilityKey,
} from '@/lib/auth/permissions';
import {
  asCapabilityKey,
  capabilityLevel,
  hasCapability,
  requireAllCapabilities,
  requireCapability,
  requireRole,
  isOps,
  type CapabilityCaller,
} from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { USER_ROLES, type UserRole } from '@/types/enums';

/**
 * ============================================================================
 * The server-side permission gate
 * ============================================================================
 *
 * These assertions are about ENFORCEMENT, not about the matrix. The matrix's own
 * shape is asserted in `tests/unit/permissions.test.ts`; this file answers the
 * question the UI cannot: what happens when a caller who does not have a
 * capability asks for the thing it gates?
 *
 * The three properties that matter:
 *
 *   1. A refusal is `403`, thrown, not returned as a boolean a caller can ignore.
 *   2. The two HARD DENIALS are refused BEFORE the matrix lookup, so a
 *      transcription bug in the matrix cannot open them.
 *   3. A capability name that does not exist is a compile error at the call site
 *      and a `422` when it arrives from configuration.
 */

/**
 * A minimal caller.
 *
 * Typed as `CapabilityCaller` rather than `AuthedUser` deliberately: the gate
 * reads only `uid` and `role`, and its signature says so. A test that had to
 * fabricate a `DecodedIdToken` to satisfy a wider parameter would be building a
 * lie to pass a type check.
 */
type FakeUser = CapabilityCaller;

function asUser(role: UserRole, uid = 'uid-1'): FakeUser {
  return { uid, role };
}


const REAUTH = { requestId: 'req_aaaaaaaaaaaa' };

/* ========================================================================== */
/* requireCapability                                                           */
/* ========================================================================== */

describe('requireCapability', () => {
  it('returns the CALLER, not a boolean, so a call site cannot ignore it', () => {
    // There is deliberately no `tryRequireCapability` yielding `{ ok: false }`:
    // a caller that forgets to check is exactly how an unauthorised path becomes
    // authorised by accident.
    const user = asUser('dispatcher');
    expect(requireCapability(user, 'r29_assignResponder', REAUTH)).toBe(user);
  });

  it('throws 403 FORBIDDEN when the role lacks the capability', () => {
    // A citizen attempting a privileged operation. This is the documented
    // security test for the whole API surface.
    try {
      requireCapability(asUser('citizen'), 'r52_listUsers', REAUTH);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('FORBIDDEN');
      expect(appError.status).toBe(403);
    }
  });

  it('refuses row 59 to EVERY role, admin included', () => {
    // The two hard denials are the rows most likely to be "simplified away"
    // under deadline pressure. They are denied before the matrix lookup, so even
    // an admin gets nothing.
    for (const role of USER_ROLES) {
      try {
        requireCapability(asUser(role), 'r59_deleteAuditEntry', REAUTH);
        throw new Error(`role ${role} should have been refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).status).toBe(403);
        expect((error as AppError).message).toContain('including an administrator');
      }
    }
  });

  it('refuses row 61 to EVERY role, admin included', () => {
    for (const role of USER_ROLES) {
      try {
        requireCapability(asUser(role), 'r61_changeOwnRole', REAUTH);
        throw new Error(`role ${role} should have been refused`);
      } catch (error) {
        expect((error as AppError).status).toBe(403);
      }
    }
  });

  it('does NOT treat admin as an implicit superuser', () => {
    // "admin can do everything" is how a permission matrix quietly stops being a
    // matrix. Rows 52-61 are admin-only and 59/61 deny admin too.
    expect(can('admin', 'r01_createIncident')).toBe(true);
    // `r38_verifyRejectResponder` is admin-only, so this is about the principle:
    // an admin must be listed explicitly for a capability, not granted by
    // default. Asserted through the matrix rather than a route.
    expect(levelOf('admin', 'r59_deleteAuditEntry')).toBe('denied');
  });

  it('grants a `readonly` capability? No — the ACTION is not available', () => {
    // `readonly` means the DATA is visible with fields removed. A server that
    // permitted the action would promise something the matrix says no role has,
    // and a UI that rendered the button would then fail on click.
    expect(isReadOnly('responder', 'r13_readAiTriagePanel')).toBe(true);
    expect(can('responder', 'r13_readAiTriagePanel')).toBe(false);
    try {
      requireCapability(asUser('responder'), 'r13_readAiTriagePanel', REAUTH);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as AppError).status).toBe(403);
    }
  });

  it('grants a `scoped` capability and leaves the SCOPE to the resource gate', () => {
    // `scoped` returns true: the action exists for this role, narrowed by a
    // server-evaluated rule. The client cannot evaluate the scope because it does
    // not have the document.
    expect(isScoped('responder', 'r07_readUnassignedInRadius')).toBe(true);
    expect(can('responder', 'r07_readUnassignedInRadius')).toBe(true);
    expect(requireCapability(asUser('responder'), 'r07_readUnassignedInRadius', REAUTH)).toBeTruthy();
  });

  it('the message for a denial reveals nothing about the account', () => {
    // A refusal copy that named which roles DO have the capability is a role
    // enumeration oracle.
    try {
      requireCapability(asUser('citizen'), 'r53_changeUserRole', REAUTH);
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as AppError).message;
      expect(message).toBe('You do not have permission for that action.');
      expect(message).not.toMatch(/admin|dispatcher|responder/i);
    }
  });
});

/* ========================================================================== */
/* requireAllCapabilities                                                      */
/* ========================================================================== */

describe('requireAllCapabilities', () => {
  it('passes when the role holds every capability', () => {
    const user = asUser('admin');
    expect(requireAllCapabilities(user, ['r52_listUsers', 'r53_changeUserRole'], REAUTH)).toBe(user);
  });

  it('fails on the FIRST missing capability', () => {
    // Conjunctive, so the order matters only for which refusal is reported — and
    // the refusal is the same 403 either way.
    try {
      requireAllCapabilities(asUser('dispatcher'), ['r52_listUsers', 'r55_readAuditLog'], REAUTH);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as AppError).code).toBe('FORBIDDEN');
    }
  });
});

/* ========================================================================== */
/* The boolean and level forms                                                 */
/* ========================================================================== */

describe('hasCapability and capabilityLevel', () => {
  it('hasCapability agrees with can() for EVERY row and EVERY role', () => {
    // Two functions answering the same question is exactly the duplication this
    // file exists to prevent. If they disagree, a route uses one and a component
    // uses the other, and the button appears for a user the API refuses.
    for (const capability of CAPABILITY_KEYS) {
      for (const role of USER_ROLES) {
        expect(hasCapability({ role }, capability), `${role}/${capability}`).toBe(can(role, capability));
      }
    }
  });

  it('capabilityLevel is the matrix value, with `denied` for a hard denial', () => {
    expect(capabilityLevel({ role: 'admin' }, 'r59_deleteAuditEntry')).toBe('denied');
    expect(capabilityLevel({ role: 'citizen' }, 'r01_createIncident')).toBe('full');
  });
});

/* ========================================================================== */
/* requireRole                                                                 */
/* ========================================================================== */

describe('requireRole', () => {
  it('accepts a listed role and rejects an unlisted one', () => {
    expect(requireRole(asUser('admin'), ['admin'])).toBeTruthy();
    try {
      requireRole(asUser('citizen'), ['dispatcher', 'admin']);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as AppError).status).toBe(403);
    }
  });

  it('isOps is true for exactly the two operational roles', () => {
    expect(isOps({ role: 'dispatcher' })).toBe(true);
    expect(isOps({ role: 'admin' })).toBe(true);
    expect(isOps({ role: 'responder' })).toBe(false);
    expect(isOps({ role: 'citizen' })).toBe(false);
  });
});

/* ========================================================================== */
/* Capability names from configuration                                         */
/* ========================================================================== */

describe('asCapabilityKey', () => {
  it('accepts a real row', () => {
    expect(asCapabilityKey('r52_listUsers')).toBe('r52_listUsers');
  });

  it('throws 422 INVALID_CAPABILITY for a typo, not 500', () => {
    // A capability name can arrive from a CONFIG value, where a typo is not a
    // compile error. `can()` returning false for an unknown key would silently
    // DENY a legitimate action rather than reporting the mistake.
    try {
      asCapabilityKey('r52_listUser');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_CAPABILITY');
      expect((error as AppError).status).toBe(422);
    }
  });
});

/* ========================================================================== */
/* The matrix the gate reads                                                  */
/* ========================================================================== */

describe('the gate and the matrix cannot drift', () => {
  it('HARD_DENIALS is a subset of the matrix and is refused by can() for all roles', () => {
    for (const denial of HARD_DENIALS) {
      expect(PERMISSION_MATRIX[denial], `${denial} is not in the matrix`).toBeDefined();
      for (const role of USER_ROLES) {
        expect(can(role, denial), `${role} must not hold ${denial}`).toBe(false);
      }
    }
  });

  it('capabilityListFor omits every hard denial, for every role', () => {
    // This is what `GET /api/me` sends the client. A hard denial appearing in
    // `permissions[]` would render a button the API then refuses.
    for (const role of USER_ROLES) {
      const list = capabilityListFor(role);
      for (const denial of HARD_DENIALS) {
        expect(list, `${role} must not be offered ${denial}`).not.toContain(denial);
      }
    }
  });

  it('a capability the gate can check is a key of the matrix', () => {
    // Guards against a route referencing a row that does not exist: TypeScript
    // catches it at build time, and this catches it in a test as well.
    const checkable: CapabilityKey[] = [
      'r13_readAiTriagePanel',
      'r52_listUsers',
      'r53_changeUserRole',
      'r59_deleteAuditEntry',
      'r61_changeOwnRole',
    ];
    for (const capability of checkable) {
      expect(PERMISSION_MATRIX[capability]).toBeDefined();
    }
  });
});

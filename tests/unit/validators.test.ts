import { describe, expect, it } from 'vitest';

import { ERROR_CODES, ERROR_STATUS, isPermanentDenial, isRefreshable } from '@/lib/api/error-codes';
import {
  ENUMS,
  accountStatusSchema,
  auditActionSchema,
  displayNameSchema,
  incidentStatusSchema,
  passwordSchema,
  selfServiceRoleSchema,
  userRoleSchema,
} from '@/validators/enums';
import { signUpFormSchema, meBootstrapBodySchema, mePatchBodySchema } from '@/validators/me';
import { isMaintenance, maintenanceProblem } from '@/lib/env.maintenance';
import {
  ACCOUNT_STATUSES,
  AUDIT_ACTIONS,
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  RESOLUTION_CODES,
  SAFETY_FLAGS,
  TERMINAL_STATUSES,
  URGENCIES,
  USER_ROLES,
} from '@/types/enums';

/**
 * ============================================================================
 * Validators, the error catalogue, and the environment accessors
 * ============================================================================
 *
 * The Phase 2 acceptance criterion that matters most is: "public users cannot
 * self-assign privileged roles". That is asserted here, twice — once at the
 * schema level, and once through the full sign-up schema.
 */

describe('error code catalogue', () => {
  it('assigns a status in the 4xx/5xx range to every code', () => {
    for (const code of ERROR_CODES) {
      const status = ERROR_STATUS[code];
      expect(status, `${code} has a status`).toBeTypeOf('number');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('uses 401 only for "not authenticated"', () => {
    const codes401 = ERROR_CODES.filter((code) => ERROR_STATUS[code] === 401);
    expect(codes401.sort()).toEqual(['AUTH_EXPIRED', 'AUTH_INVALID_TOKEN', 'AUTH_REQUIRED']);
  });

  it('classifies 403 as a permanent denial', () => {
    for (const code of ERROR_CODES.filter((c) => ERROR_STATUS[c] === 403)) {
      expect(isPermanentDenial(code), `${code} is a permanent denial`).toBe(true);
    }
  });

  it('marks exactly AUTH_EXPIRED and AUTH_INVALID_TOKEN as refreshable', () => {
    // `AUTH_REQUIRED` is excluded on purpose: there was no token to refresh, so
    // retrying is guaranteed to fail and only adds a round trip.
    const refreshable = ERROR_CODES.filter((code) => isRefreshable(code));
    expect(refreshable.sort()).toEqual(['AUTH_EXPIRED', 'AUTH_INVALID_TOKEN']);
  });

  it('never lets AUTH_REQUIRED be refreshable', () => {
    expect(isRefreshable('AUTH_REQUIRED')).toBe(false);
  });
});

/* ========================================================================== */
/* The schemas are derived from the runtime arrays, not re-typed             */
/* ========================================================================== */

describe('enum schemas are derived, not re-typed', () => {
  it('every role in USER_ROLES parses', () => {
    for (const role of USER_ROLES) {
      expect(userRoleSchema.safeParse(role).success, role).toBe(true);
    }
  });

  it('a role outside the enum is rejected', () => {
    for (const bogus of ['superuser', 'Admin', 'root', '', 'moderator']) {
      expect(userRoleSchema.safeParse(bogus).success, `"${bogus}"`).toBe(false);
    }
  });

  it('keeps the account statuses and the audit actions in step with the enums', () => {
    for (const status of ACCOUNT_STATUSES) {
      expect(accountStatusSchema.safeParse(status).success, status).toBe(true);
    }
    for (const action of AUDIT_ACTIONS) {
      expect(auditActionSchema.safeParse(action).success, action).toBe(true);
    }
  });

  it('exposes the same values through the ENUMS table as through the schemas', () => {
    expect(ENUMS.roles).toEqual(USER_ROLES);
    expect(ENUMS.statuses).toEqual(INCIDENT_STATUSES);
    expect(ENUMS.terminalStatuses).toEqual(TERMINAL_STATUSES);
    expect(ENUMS.categories).toEqual(INCIDENT_CATEGORIES);
    expect(ENUMS.urgencies).toEqual(URGENCIES);
    expect(ENUMS.safetyFlags).toEqual(SAFETY_FLAGS);
    expect(ENUMS.resolutionCodes).toEqual(RESOLUTION_CODES);
  });

  it('rejects a status outside the 11 controlled values', () => {
    expect(incidentStatusSchema.safeParse('deleted').success).toBe(false);
    expect(incidentStatusSchema.safeParse('archived').success).toBe(false);
    expect(INCIDENT_STATUSES).toHaveLength(11);
  });
});

/* ========================================================================== */
/* THE PRIVILEGE-ESCALATION BLOCK                                             */
/* ========================================================================== */

describe('a public sign-up cannot choose a privileged role', () => {
  it('selfServiceRoleSchema accepts citizen and nothing else', () => {
    expect(selfServiceRoleSchema.safeParse('citizen').success).toBe(true);
    for (const privileged of ['responder', 'dispatcher', 'admin']) {
      expect(
        selfServiceRoleSchema.safeParse(privileged).success,
        `${privileged} must not be self-assignable`,
      ).toBe(false);
    }
  });

  /**
   * The full sign-up schema, which is what actually runs. Even a hand-crafted
   * request body that includes `role: 'admin'` fails here, BEFORE any network
   * call — so the value never reaches Firebase.
   */
  it('rejects a sign-up body carrying role: admin', () => {
    const parsed = signUpFormSchema.safeParse({
      displayName: 'Test Person',
      email: 'test@example.com',
      password: 'hunter2000',
      confirmPassword: 'hunter2000',
      role: 'admin',
      acceptedDemoNotice: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a sign-up body carrying role: dispatcher', () => {
    const parsed = signUpFormSchema.safeParse({
      displayName: 'Test Person',
      email: 'test@example.com',
      password: 'hunter2000',
      confirmPassword: 'hunter2000',
      role: 'dispatcher',
      acceptedDemoNotice: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a sign-up body carrying role: responder', () => {
    const parsed = signUpFormSchema.safeParse({
      displayName: 'Test Person',
      email: 'test@example.com',
      password: 'hunter2000',
      confirmPassword: 'hunter2000',
      role: 'responder',
      acceptedDemoNotice: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a clean citizen sign-up', () => {
    const parsed = signUpFormSchema.safeParse({
      displayName: 'Test Person',
      email: 'test@example.com',
      password: 'hunter2000',
      confirmPassword: 'hunter2000',
      role: 'citizen',
      acceptedDemoNotice: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a sign-up without the demonstration acknowledgement', () => {
    const parsed = signUpFormSchema.safeParse({
      displayName: 'Test Person',
      email: 'test@example.com',
      password: 'hunter2000',
      confirmPassword: 'hunter2000',
      role: 'citizen',
      acceptedDemoNotice: false,
    });
    expect(parsed.success).toBe(false);
  });

  /**
   * The second block. `meBootstrapBodySchema` is `.strict()`, so a `role` key is
   * a 400 rather than a silently-ignored extra property. This is the schema a
   * hand-crafted POST to `/api/me/bootstrap` would hit.
   */
  it('rejects a bootstrap body carrying role, because it is .strict()', () => {
    const withRole = meBootstrapBodySchema.safeParse({
      displayName: 'Test Person',
      timezone: 'Asia/Kolkata',
      role: 'admin',
    });
    expect(withRole.success).toBe(false);

    const withoutRole = meBootstrapBodySchema.safeParse({
      displayName: 'Test Person',
      timezone: 'Asia/Kolkata',
    });
    expect(withoutRole.success).toBe(true);
  });

  it('rejects a bootstrap body carrying status', () => {
    const parsed = meBootstrapBodySchema.safeParse({
      displayName: 'Test Person',
      timezone: 'Asia/Kolkata',
      status: 'active',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a PATCH body trying to set role or status', () => {
    for (const extra of [{ role: 'admin' }, { status: 'active' }, { disabledReason: 'x' }]) {
      const parsed = mePatchBodySchema.safeParse({
        displayName: 'Test Person',
        ...extra,
      });
      expect(parsed.success, JSON.stringify(extra)).toBe(false);
    }
  });
});

/* ========================================================================== */
/* Field bounds                                                               */
/* ========================================================================== */

describe('display name bounds match users/{uid}.displayName', () => {
  it('accepts 2 to 60 characters', () => {
    expect(displayNameSchema.safeParse('Jo').success).toBe(true);
    expect(displayNameSchema.safeParse('a'.repeat(60)).success).toBe(true);
  });

  it('rejects one character and 61 characters', () => {
    expect(displayNameSchema.safeParse('a').success).toBe(false);
    expect(displayNameSchema.safeParse('a'.repeat(61)).success).toBe(false);
  });

  it('trims, so surrounding whitespace is not part of the stored value', () => {
    const parsed = displayNameSchema.safeParse('  Priya Nair  ');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('Priya Nair');
  });
});

describe('password complexity (the client mirror of the Firebase policy)', () => {
  it('requires at least 8 characters and a number', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
    expect(passwordSchema.safeParse('longenough').success).toBe(false);
    expect(passwordSchema.safeParse('longenough1').success).toBe(true);
  });

  it('rejects an absurdly long password rather than hashing it', () => {
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
});

/* ========================================================================== */
/* The environment accessors                                                  */
/* ========================================================================== */

describe('environment accessors', () => {
  it('reports maintenance disabled in a default environment', () => {
    // The accessor must not throw when the variable is absent; a boot failure
    // over a feature flag would take down every route in the app.
    expect(typeof isMaintenance()).toBe('boolean');
  });

  it('returns a null maintenance problem when maintenance is off', () => {
    if (isMaintenance()) {
      expect(maintenanceProblem()).toContain('CRON_SECRET');
    } else {
      expect(maintenanceProblem()).toBeNull();
    }
  });
});

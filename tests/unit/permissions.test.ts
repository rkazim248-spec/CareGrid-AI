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
import { USER_ROLES } from '@/types/enums';
import type { UserRole } from '@/types/enums';

/**
 * ============================================================================
 * The permission matrix — the machine-checkable half of docs/22 §3
 * ============================================================================
 *
 * The matrix is the product's authorisation contract expressed as data, so it can
 * be tested. These tests are the reason it is data rather than a `switch`
 * statement scattered across the UI.
 *
 * They assert FOUR things:
 *   1. Shape      — 61 rows, four roles each, only legal level values.
 *   2. The two hard denials (rows 59 and 61) are denied to EVERY role.
 *   3. Specific documented rows, so a typo in the table is caught.
 *   4. `can()` / `levelOf()` agree with the table, so the helpers cannot drift.
 */

const ROLES: readonly UserRole[] = USER_ROLES;
const LEVELS = ['full', 'scoped', 'readonly', 'denied'] as const;

describe('permission matrix shape', () => {
  it('has exactly the 61 rows of docs/22 §3', () => {
    expect(CAPABILITY_KEYS).toHaveLength(61);
  });

  it('keys every row with its documentation row number, 01 through 61', () => {
    const numbers = CAPABILITY_KEYS.map((key) => Number(key.slice(1, 3))).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 61 }, (_, index) => index + 1));
  });

  it('has no duplicate row numbers', () => {
    const numbers = CAPABILITY_KEYS.map((key) => key.slice(1, 3));
    expect(new Set(numbers).size).toBe(61);
  });

  it('gives every row a level for all four roles, and only legal levels', () => {
    for (const key of CAPABILITY_KEYS) {
      const row = PERMISSION_MATRIX[key];
      expect(row, `${key} exists`).toBeDefined();
      for (const role of ROLES) {
        expect(LEVELS, `${key}.${role} is a legal level`).toContain(row[role]);
      }
      // Exactly the four roles — no more, no fewer. An extra key here would mean
      // someone added a role to the matrix without adding it to `USER_ROLES`.
      expect(Object.keys(row).sort()).toEqual([...ROLES].sort());
    }
  });

  it('has no empty capability key', () => {
    for (const key of CAPABILITY_KEYS) {
      expect(key).toMatch(/^r\d{2}_[a-zA-Z]+$/);
    }
  });
});

/* ========================================================================== */
/* The two hard denials                                                       */
/* ========================================================================== */

describe('the two hard denials (docs/22 §3 rows 59 and 61)', () => {
  it('lists exactly two', () => {
    expect(HARD_DENIALS.size).toBe(2);
    expect(HARD_DENIALS.has('r59_deleteAuditEntry')).toBe(true);
    expect(HARD_DENIALS.has('r61_changeOwnRole')).toBe(true);
  });

  it('denies them to EVERY role, admin included', () => {
    for (const key of HARD_DENIALS) {
      for (const role of ROLES) {
        expect(
          PERMISSION_MATRIX[key][role],
          `${role} must not hold ${key} — this is the guarantee that gets removed under deadline pressure`,
        ).toBe('denied');
      }
    }
  });

  it('keeps them out of every role capability list', () => {
    for (const role of ROLES) {
      const list = capabilityListFor(role);
      for (const key of HARD_DENIALS) {
        expect(list, `${role} must not receive ${key}`).not.toContain(key);
      }
    }
  });

  it('makes can() agree, for all four roles', () => {
    for (const role of ROLES) {
      expect(can(role, 'r59_deleteAuditEntry')).toBe(false);
      expect(can(role, 'r61_changeOwnRole')).toBe(false);
    }
  });
});

/* ========================================================================== */
/* Specific documented rows                                                   */
/* ========================================================================== */

describe('specific rows match docs/22 §3', () => {
  const cases: Array<[CapabilityKey, UserRole, string]> = [
    // Reporting
    ['r01_createIncident', 'citizen', 'full'],
    ['r03_cancelOwnIncident', 'dispatcher', 'denied'],
    ['r04_cancelAnyIncident', 'dispatcher', 'full'],
    // Incident reading
    ['r08_readAllIncidents', 'citizen', 'denied'],
    ['r08_readAllIncidents', 'dispatcher', 'full'],
    ['r10_readReporterIdentity', 'responder', 'denied'],
    ['r10_readReporterIdentity', 'citizen', 'full'],
    ['r13_readAiTriagePanel', 'responder', 'readonly'],
    ['r07_readUnassignedInRadius', 'responder', 'scoped'],
    // Lifecycle
    ['r14_verify', 'citizen', 'denied'],
    ['r14_verify', 'dispatcher', 'full'],
    ['r16_setEnRoute', 'responder', 'scoped'],
    ['r18_setResolved', 'responder', 'scoped'],
    // Duplicates
    ['r25_confirmMerge', 'citizen', 'denied'],
    ['r25_confirmMerge', 'dispatcher', 'full'],
    // Dispatch
    ['r29_assignResponder', 'responder', 'denied'],
    ['r29_assignResponder', 'dispatcher', 'full'],
    // Responders
    ['r35_readResponderDirectory', 'responder', 'denied'],
    ['r38_verifyRejectResponder', 'dispatcher', 'denied'],
    ['r38_verifyRejectResponder', 'admin', 'full'],
    // Analytics
    ['r50_recomputeAnalytics', 'dispatcher', 'denied'],
    ['r50_recomputeAnalytics', 'admin', 'full'],
    // Administration
    ['r52_listUsers', 'dispatcher', 'denied'],
    ['r52_listUsers', 'admin', 'full'],
    ['r55_readAuditLog', 'dispatcher', 'readonly'],
    ['r55_readAuditLog', 'admin', 'full'],
  ];

  for (const [key, role, expected] of cases) {
    it(`row ${key} for ${role} is ${expected}`, () => {
      expect(levelOf(role, key)).toBe(expected);
    });
  }
});

/* ========================================================================== */
/* Helper agreement                                                           */
/* ========================================================================== */

describe('the helpers agree with the table', () => {
  it('can() is true for full and scoped only', () => {
    for (const key of CAPABILITY_KEYS) {
      for (const role of ROLES) {
        const level = levelOf(role, key);
        expect(can(role, key), `${role}/${key}`).toBe(level === 'full' || level === 'scoped');
      }
    }
  });

  it('isReadOnly and isScoped are mutually exclusive', () => {
    for (const key of CAPABILITY_KEYS) {
      for (const role of ROLES) {
        expect(isReadOnly(role, key) && isScoped(role, key)).toBe(false);
      }
    }
  });

  it('an unknown capability is denied for every role, not crashed on', () => {
    const bogus = 'r99_doesNotExist' as CapabilityKey;
    for (const role of ROLES) {
      expect(can(role, bogus)).toBe(false);
      expect(levelOf(role, bogus)).toBe('denied');
    }
  });

  it('capabilityListFor returns only capabilities the role can perform', () => {
    for (const role of ROLES) {
      const list = capabilityListFor(role);
      for (const entry of list) {
        // `entry` is `string` because the list is what goes over the wire in
        // `permissions[]`; the cast is the assertion that it is a real key.
        expect(CAPABILITY_KEYS).toContain(entry);
        expect(can(role, entry as CapabilityKey), `${role} listed ${entry}`).toBe(true);
      }
    }
  });

  it('capabilityListFor has no duplicates and preserves row order', () => {
    for (const role of ROLES) {
      const list = capabilityListFor(role);
      expect(new Set(list).size).toBe(list.length);
      const positions = list.map((key) => CAPABILITY_KEYS.indexOf(key as CapabilityKey));
      // A missing key would index as -1 and sort first, which is exactly the
      // drift this catches.
      expect(positions.every((index) => index >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });
});

/* ========================================================================== */
/* The properties that make the matrix a security control                      */
/* ========================================================================== */

describe('escalation properties', () => {
  /**
   * The matrix is not sufficient on its own — `firestore.rules` and
   * `requireUser()` are the boundaries. But a row that is wrong in the obvious
   * direction would be a defect worth catching here rather than in production.
   */
  it('no role below admin holds an administration capability', () => {
    const adminOnly: CapabilityKey[] = [
      'r38_verifyRejectResponder',
      'r47_sendNotificationToOther',
      'r50_recomputeAnalytics',
      'r52_listUsers',
      'r53_changeUserRole',
      'r54_enableSuspendAccount',
      'r57_runMaintenanceJobs',
      'r60_createOrPromoteDispatcher',
    ];
    for (const key of adminOnly) {
      expect(levelOf('citizen', key), `citizen/${key}`).toBe('denied');
      expect(levelOf('responder', key), `responder/${key}`).toBe('denied');
      expect(levelOf('dispatcher', key), `dispatcher/${key}`).toBe('denied');
      expect(levelOf('admin', key), `admin/${key}`).toBe('full');
    }
  });

  it('a citizen can never reach a lifecycle or dispatch action', () => {
    const forbidden: CapabilityKey[] = [
      'r14_verify',
      'r15_markFalseAlarm',
      'r16_setEnRoute',
      'r17_setOnScene',
      'r18_setResolved',
      'r19_setClosed',
      'r20_forceStatusOverride',
      'r25_confirmMerge',
      'r26_undoMerge',
      'r27_dismissDuplicate',
      'r28_seeCandidateResponders',
      'r29_assignResponder',
    ];
    for (const key of forbidden) {
      expect(can('citizen', key), `citizen must not hold ${key}`).toBe(false);
    }
  });

  it('admin is never a wildcard: every admin row is spelled out', () => {
    // If a future edit gave admin an implicit superuser flag rather than 61
    // explicit rows, the two hard denials would silently become permitted.
    expect(Object.keys(PERMISSION_MATRIX)).toHaveLength(61);
    expect(PERMISSION_MATRIX.r59_deleteAuditEntry.admin).toBe('denied');
    expect(PERMISSION_MATRIX.r61_changeOwnRole.admin).toBe('denied');
  });

  it('citizen holds strictly more reporting rights than reading rights', () => {
    // Sanity: a citizen who could not create a report would make the product
    // meaningless, and a citizen who could read all incidents would make it
    // unusable. Both are single-row assertions, so both are cheap to keep.
    expect(can('citizen', 'r01_createIncident')).toBe(true);
    expect(can('citizen', 'r08_readAllIncidents')).toBe(false);
  });
});

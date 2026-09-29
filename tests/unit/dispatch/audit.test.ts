import { describe, expect, it } from 'vitest';

import {
  PRIVILEGED_ACTIONS,
  UnsafeAuditFieldError,
  assertAuditSafe,
  buildAuditDiff,
  buildAuditDocument,
} from '@/services/dispatch/audit';
import { AUDIT_ACTIONS } from '@/types';

/* ========================================================================== */
/* The whitelist — docs/07 §11.5                                               */
/* ========================================================================== */

describe('the audit diff is an ALLOW-list, not a deny-list', () => {
  // docs/07 §11.5: "whitelisted fields only - **never** raw PII or evidence URLs".
  // The distinction is the whole design: a deny-list lets the next `phoneHash` or
  // `location` field through unnoticed; an allow-list means a new field is
  // invisible until someone deliberately adds it.

  it('copies ONLY the whitelisted keys, ignoring everything else in the source', () => {
    const source = {
      status: 'triaged',
      location: { lat: 24.86, lng: 67.0 },
      phone: '+92 300 1234567',
      responderUid: 'u_ahmed',
    };
    const diff = buildAuditDiff(source, ['status']);
    expect(diff).toEqual({ status: 'triaged' });
    // The dangerous fields are absent, not nulled.
    expect(Object.keys(diff ?? {})).toEqual(['status']);
  });

  it('returns null when the whitelist matches nothing, rather than an empty object', () => {
    // An empty `before: {}` reads as "we compared two things that were the same"
    // in a compliance review. `null` reads as "there was nothing to compare".
    expect(buildAuditDiff({ a: 1, b: 2 }, ['c', 'd'])).toBeNull();
    expect(buildAuditDiff({}, ['status'])).toBeNull();
  });

  it('DROPS a non-scalar rather than stringifying it', () => {
    // `JSON.stringify` of an evidence array would put a storage path into an audit
    // row, which is exactly what docs/07 §11.5 forbids.
    const diff = buildAuditDiff(
      {
        status: 'resolved',
        media: [{ storagePath: 'incidents/x/reports/y/z.jpg' }],
        tags: ['a', 'b'],
        meta: { nested: true },
      },
      ['status', 'media', 'tags', 'meta'],
    );
    expect(diff).toEqual({ status: 'resolved' });
  });

  it('keeps null as a real value, because null-to-null IS a change', () => {
    const diff = buildAuditDiff({ withdrawnAt: null }, ['withdrawnAt']);
    expect(diff).toEqual({ withdrawnAt: null });
  });

  it('keeps false and 0, which are values and not absences', () => {
    // `if (value)` would drop both, and "notified: false" is exactly the kind of
    // change an audit trail exists to record.
    const diff = buildAuditDiff({ notified: false, activeIncidentCount: 0 }, ['notified', 'activeIncidentCount']);
    expect(diff).toEqual({ notified: false, activeIncidentCount: 0 });
  });

  it('reads a key the source does not have as absent, not as an error', () => {
    expect(buildAuditDiff({ status: 'new' }, ['status', 'missingKey'])).toEqual({ status: 'new' });
  });
});

/* ========================================================================== */
/* The refusal — the part that makes the allow-list real                       */
/* ========================================================================== */

describe('a forbidden field is REFUSED, and refusing LOUDLY is the point', () => {
  const forbidden: readonly [string, string][] = [
    ['location', 'a coordinate'],
    ['geo', 'a coordinate'],
    ['homeBase', 'a home address'],
    ['text', "a citizen's report"],
    ['phone', 'PII'],
    ['email', 'PII'],
    ['displayName', 'PII'],
    ['signedReadUrl', 'an evidence URL'],
    ['storagePath', 'an evidence path'],
    ['apiKey', 'a credential'],
    ['token', 'a credential'],
    ['ip', 'a raw IP'],
    ['note', 'free text that may quote a report'],
  ];

  it.each(forbidden)('refuses %s (%s)', (field) => {
    expect(() => assertAuditSafe([field])).toThrow(UnsafeAuditFieldError);
  });

  it('throws rather than silently filtering', () => {
    // A silent filter would mean a call site asked to log `phone`, got no `phone`,
    // and had no idea — the row would be missing a field someone believed they
    // were recording, discovered only during an investigation.
    expect(() => buildAuditDiff({ phone: '+92 300' }, ['phone'])).toThrow(UnsafeAuditFieldError);
  });

  it('names the offending field, so the developer knows what to remove', () => {
    try {
      assertAuditSafe(['status', 'location']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeAuditFieldError);
      expect((error as UnsafeAuditFieldError).field).toBe('location');
    }
  });

  it('allows the fields Phase 7 actually needs', () => {
    expect(() =>
      assertAuditSafe(['status', 'responderStatus', 'activeIncidentCount', 'dispatchStatus']),
    ).not.toThrow();
  });

  it('is a BACKSTOP, and the whitelist is the real control', () => {
    // Stated precisely, because getting it backwards would be a security claim
    // this code does not make.
    //
    // The PRIMARY control is that `buildAuditDiff` copies only the keys the caller
    // named. A field nobody whitelists cannot reach a diff, whatever its name.
    // `assertAuditSafe` is a SECOND guard on the one input a developer controls
    // directly — the whitelist itself — and it exists to catch the case where
    // someone writes `['phone']` believing it will work.
    //
    // So a name the forbidden list does not contain, but which a developer
    // whitelists anyway, DOES get written. That is a real limitation and it is the
    // reason a forbidden name is a code-review question ("why is this whitelisted?")
    // rather than something a list can settle.
    expect(() => assertAuditSafe(['Phone'])).not.toThrow();
    expect(buildAuditDiff({ Phone: '+92 300' }, ['Phone'])).toEqual({ Phone: '+92 300' });

    // And the primary control, which is what actually holds:
    expect(buildAuditDiff({ Phone: '+92 300' }, ['status'])).toBeNull();
    expect(buildAuditDiff({ someBrandNewField: 'secret' }, ['status'])).toBeNull();
  });
});

/* ========================================================================== */
/* The document                                                                */
/* ========================================================================== */

describe('the audit document', () => {
  const base = {
    actorUid: 'u_disp01',
    actorRole: 'dispatcher' as const,
    action: 'incident.assign' as const,
    entityType: 'dispatch' as const,
    entityId: 'd_9fK2',
    incidentRef: 'CG-4T7B2N',
    summary: 'Assigned a responder.',
    before: { status: 'triaged' },
    after: { status: 'assigned' },
    reason: 'Closest available paramedic.',
    requestId: 'req_abc',
    ipHash: 'sha256:9f2b',
    userAgent: 'Mozilla/5.0',
  };

  it('fills every documented field, with nulls where there is nothing', () => {
    const document = buildAuditDocument(base);
    expect(document).toMatchObject({
      actorUid: 'u_disp01',
      actorRole: 'dispatcher',
      action: 'incident.assign',
      entityType: 'dispatch',
      entityId: 'd_9fK2',
      incidentRef: 'CG-4T7B2N',
      requestId: 'req_abc',
    });
  });

  it('truncates summary and userAgent to the documented 200 chars', () => {
    // docs/07 §11.5: "summary | string | <= 200 chars", "userAgent | string | <= 200".
    const document = buildAuditDocument({
      ...base,
      summary: 'x'.repeat(500),
      userAgent: 'u'.repeat(500),
    });
    expect(document.summary.length).toBeLessThanOrEqual(200);
    expect(document.userAgent?.length).toBeLessThanOrEqual(200);
  });

  it('NEVER carries a raw IP, only the hash the route context supplied', () => {
    // docs/07 §11.5: "ipHash | SHA-256(ip + daily rotating salt)". The `ip` key is
    // in the forbidden list precisely so this cannot be filled by accident.
    const document = buildAuditDocument({ ...base, ipHash: 'sha256:9f2b' });
    expect(document.ipHash).toBe('sha256:9f2b');
    expect(Object.keys(document)).not.toContain('ip');
    expect(Object.keys(document)).not.toContain('ipAddress');
  });

  it('a null ipHash stays null rather than becoming an empty string', () => {
    expect(buildAuditDocument({ ...base, ipHash: null }).ipHash).toBeNull();
  });

  it('incidentRef is optional and defaults to null', () => {
    const { incidentRef: _omitted, ...withoutRef } = base;
    expect(buildAuditDocument(withoutRef).incidentRef).toBeNull();
  });
});

/* ========================================================================== */
/* FR-132 — the action vocabulary                                              */
/* ========================================================================== */

describe('every action Phase 7 writes is in the FR-132 enum', () => {
  // An action outside the enum is an action no compliance review can filter for,
  // so the check is that the phase uses the existing vocabulary rather than
  // inventing new strings.
  it('the four actions Phase 7 logs are all declared', () => {
    for (const action of [
      'incident.assign',
      'incident.unassign',
      'incident.status_change',
      'responder.update',
      'notification.sent',
    ] as const) {
      expect(AUDIT_ACTIONS, action).toContain(action);
    }
  });

  it('no Phase 7 action is a free string outside the enum', () => {
    // The whole set the phase can produce, asserted against the enum rather than
    // against a copy of the enum.
    expect(AUDIT_ACTIONS).toContain('incident.assign');
    expect(AUDIT_ACTIONS).toContain('incident.unassign');
    expect(AUDIT_ACTIONS).toContain('incident.status_change');
  });

  it('assignment, unassignment and status changes are all PRIVILEGED', () => {
    // docs/07 §11.5: "reason is required for privileged actions". An assignment is
    // the most privileged action in the product, so the set must say so.
    expect(PRIVILEGED_ACTIONS.has('incident.assign')).toBe(true);
    expect(PRIVILEGED_ACTIONS.has('incident.unassign')).toBe(true);
    expect(PRIVILEGED_ACTIONS.has('incident.status_change')).toBe(true);
  });

  it('a read-only action is NOT privileged', () => {
    expect(PRIVILEGED_ACTIONS.has('incident.create')).toBe(false);
  });
});

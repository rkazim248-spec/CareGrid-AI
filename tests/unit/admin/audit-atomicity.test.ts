import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthedUser } from '@/lib/server/auth-guard';
import type { RequestContextLite } from '@/services/dispatch/lifecycle';
import type { AccountStatus, UserRole } from '@/types/enums';
import { AppError } from '@/lib/server/errors';

/* ========================================================================== */
/* A fake Firestore, built for ONE question: did the write actually happen?    */
/* ========================================================================== */

/*
 * These tests exist because of a bug every other test in this repo passed
 * straight through: both admin mutation services CALLED `auditLogInTransaction`
 * but threw its return value away. The audit row was built, formatted, validated
 * against the allow-list and the forbidden-field list, and then silently
 * discarded. TypeScript was satisfied. The function was called. Nothing was
 * written.
 *
 * That is the failure mode a "did you call the helper?" assertion cannot catch,
 * and it is invisible to any test that inspects a return value instead of a side
 * effect. So the fake below does exactly one thing: record every write, and let
 * each test ask what landed.
 *
 * The regression is verified by mutation: replacing the `transaction.set(...)`
 * with a discarded call makes "writes the audit document" fail while the other
 * nine still pass. A test that cannot fail is not a test.
 */

type Write = {
  readonly path: string;
  readonly op: 'set' | 'update';
  readonly data: Record<string, unknown>;
};

type FakeDocRef = {
  readonly kind: 'doc';
  readonly id: string;
  readonly path: string;
  collection(name: string): FakeCollection;
};

type FakeCollection = {
  readonly kind: 'collection';
  readonly path: string;
  doc(id?: string): FakeDocRef;
};

class FakeFirestore {
  readonly writes: Write[] = [];
  readonly docs = new Map<string, Record<string, unknown>>();

  private autoId = 0;

  seed(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, data);
  }

  collection(name: string): FakeCollection {
    return { kind: 'collection', path: name, doc: (id?: string) => this.docIn(name, id) };
  }

  /** A doc ref knows its own path, so `incident.collection('aiReviews')` resolves. */
  private docIn(collectionPath: string, id?: string): FakeDocRef {
    const docId = id ?? `auto_${++this.autoId}`;
    const path = `${collectionPath}/${docId}`;
    return {
      kind: 'doc',
      id: docId,
      path,
      collection: (sub: string) => this.collection(`${path}/${sub}`),
    };
  }

  async runTransaction<T>(fn: (tx: FakeFirestore) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /** Reads a document ref, or resolves a collection query. */
  async get(target: FakeDocRef | FakeCollection): Promise<unknown> {
    if (target.kind === 'doc') {
      const data = this.docs.get(target.path);
      return { exists: data !== undefined, id: target.id, data: () => data ?? {} };
    }
    const prefix = `${target.path}/`;
    const rows = [...this.docs.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, data]) => ({
        id: path.slice(prefix.length),
        exists: true,
        data: () => data,
      }));
    return { empty: rows.length === 0, docs: rows, size: rows.length };
  }

  update(ref: FakeDocRef, data: Record<string, unknown>): void {
    this.writes.push({ path: ref.path, op: 'update', data });
  }

  set(ref: FakeDocRef, data: Record<string, unknown>): void {
    this.writes.push({ path: ref.path, op: 'set', data });
  }

  /**
   * The single write matching `predicate`, or a loud failure listing what DID land.
   *
   * Exact-path matching matters here: `incidents/i_1` and
   * `incidents/i_1/aiReviews/x` share a prefix, so a naive `startsWith('incidents')`
   * counts the review write as an incident write and the test quietly passes on the
   * wrong document.
   */
  onlyWrite(predicate: (w: Write) => boolean): Write {
    const matches = this.writes.filter(predicate);
    if (matches.length !== 1) {
      const seen = this.writes.map((w) => `${w.op} ${w.path}`).join(' | ') || '(none)';
      throw new Error(`expected exactly 1 matching write, got ${matches.length}. Writes: ${seen}`);
    }
    return matches[0] as Write;
  }

  writesTo(collection: string): Write[] {
    return this.writes.filter((w) => w.path.startsWith(`${collection}/`));
  }
}

let fake: FakeFirestore;

vi.mock('@/lib/server/firebase-admin', () => ({
  getAdminDb: () => fake,
}));

vi.mock('@/lib/env.server', () => ({
  geminiConfig: () => ({ confidenceReviewThreshold: 0.6 }),
}));

/* Imported AFTER the mocks so the services resolve `getAdminDb` to the fake. */
const { changeAccountState, changeUserRole } = await import('@/services/admin/users');
const { recordReviewDecision } = await import('@/services/admin/review-queue');

/* ========================================================================== */
/* Fixtures                                                                     */
/* ========================================================================== */

const CONTEXT: RequestContextLite = {
  requestId: 'req_test',
  ipHash: 'iphash_test',
  userAgent: 'vitest',
  nowMs: 1_700_000_000_000,
};

const ADMIN_UID = 'u_admin';

function admin(uid = ADMIN_UID): AuthedUser {
  return {
    uid,
    role: 'admin' as UserRole,
    status: 'active' as AccountStatus,
    displayName: 'Ops Admin',
    email: 'admin@example.org',
    authTimeSec: 1_700_000_000,
    token: {},
  } as unknown as AuthedUser;
}

function codeOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => 'NO_THROW',
    (error: unknown) => (error instanceof AppError ? error.code : `UNEXPECTED:${String(error)}`),
  );
}

/** An incident sitting in the low-confidence queue, waiting for a human. */
function queuedIncident(overrides: Record<string, unknown> = {}): void {
  fake.seed('incidents/i_1', {
    reference: 'CG-2026-0001',
    status: 'triaged',
    category: 'medical',
    urgency: 'high',
    deletedAt: null,
    aiConfidence: 0.42,
    aiNeedsReview: true,
    ...overrides,
  });
}

const inAuditLog = (w: Write): boolean => w.path.startsWith('auditLogs/');
const inReviews = (w: Write): boolean => w.path.includes('/aiReviews/');
const isIncidentDoc = (w: Write): boolean => w.path === 'incidents/i_1';

beforeEach(() => {
  fake = new FakeFirestore();
});

/* ========================================================================== */
/* The headline: the audit row is part of the same transaction                 */
/* ========================================================================== */

describe('a role change cannot happen without its audit row', () => {
  it('writes the audit document, it does not merely build one', async () => {
    fake.seed('users/u_target', { role: 'citizen', displayName: 'Sam', status: 'active' });

    const result = await changeUserRole(admin(), {
      targetUid: 'u_target',
      role: 'dispatcher',
      reason: 'volunteering as a driver this shift',
      context: CONTEXT,
    });

    expect(result).toEqual({ role: 'dispatcher', noop: false });

    const audit = fake.onlyWrite(inAuditLog).data;
    expect(audit.action).toBe('user.role_change');
    expect(audit.entityType).toBe('user');
    expect(audit.entityId).toBe('u_target');
    expect(audit.actorUid).toBe(ADMIN_UID);
    // The before/after pair is what makes the log usable after the fact.
    expect(audit.before).toEqual({ role: 'citizen' });
    expect(audit.after).toEqual({ role: 'dispatcher' });
    expect(audit.requestId).toBe('req_test');
    expect(audit.reason).toBe('volunteering as a driver this shift');
  });

  it('records a suspension as a disable', async () => {
    fake.seed('users/u_target', { role: 'dispatcher', status: 'active' });

    await changeAccountState(admin(), {
      targetUid: 'u_target',
      status: 'suspended',
      reason: 'confirmed abuse of the responder console',
      context: CONTEXT,
    });

    const audit = fake.onlyWrite(inAuditLog).data;
    expect(audit.action).toBe('user.disable');
    expect(audit.before).toEqual({ status: 'active' });
    expect(audit.after).toEqual({ status: 'suspended' });
  });

  it('records an unsuspension as an enable', async () => {
    fake.seed('users/u_target', { role: 'dispatcher', status: 'suspended' });

    await changeAccountState(admin(), {
      targetUid: 'u_target',
      status: 'active',
      reason: 'appeal upheld after a manual review',
      context: CONTEXT,
    });

    expect(fake.onlyWrite(inAuditLog).data.action).toBe('user.enable');
  });

  it('writes NO audit row for a no-op, so the log stays a log of real changes', async () => {
    fake.seed('users/u_target', { role: 'dispatcher', status: 'active' });

    const result = await changeUserRole(admin(), {
      targetUid: 'u_target',
      role: 'dispatcher',
      reason: 'double clicked the save button twice',
      context: CONTEXT,
    });

    expect(result).toEqual({ role: 'dispatcher', noop: true });
    // An audit row for "nothing changed" trains operators to ignore the log.
    expect(fake.writes).toHaveLength(0);
  });

  it('refuses to change a user that does not exist instead of creating one', async () => {
    const code = await codeOf(() =>
      changeUserRole(admin(), {
        targetUid: 'u_ghost',
        role: 'admin',
        reason: 'grant admin to an account with no profile',
        context: CONTEXT,
      }),
    );

    // A silent create here produces an account with no profile and a role, which
    // is the beginning of a very confusing support ticket.
    expect(code).toBe('USER_NOT_FOUND');
    expect(fake.writes).toHaveLength(0);
  });
});

/* ========================================================================== */
/* The review queue                                                             */
/* ========================================================================== */

describe('a review decision is atomic with its audit row', () => {
  it('persists the review, the incident flag, AND the audit entry together', async () => {
    queuedIncident();

    const result = await recordReviewDecision(admin(), {
      incidentId: 'i_1',
      decision: 'accept',
      reason: 'breathing difficulty is genuinely urgent',
      note: 'escalate to ambulance control now',
      adjustment: null,
      context: CONTEXT,
    });

    expect(result.noop).toBe(false);
    expect(result.aiConfidenceAtReview).toBe(0.42);
    // The threshold is frozen so a later config change cannot rewrite history.
    expect(result.thresholdAtReview).toBe(0.6);

    // 1. the append-only review entry in the subcollection
    const review = fake.onlyWrite(inReviews).data;
    expect(review.decision).toBe('accept');
    // The reviewer is taken from the token, never from the request body.
    expect(review.reviewerUid).toBe(ADMIN_UID);
    expect(review.aiConfidenceAtReview).toBe(0.42);

    // 2. the queue flag on the incident document itself
    const incident = fake.onlyWrite(isIncidentDoc).data;
    expect(incident.aiNeedsReview).toBe(false);
    expect(incident.reviewedBy).toBe(ADMIN_UID);

    // 3. the audit row — the thing that was silently dropped
    const audit = fake.onlyWrite(inAuditLog).data;
    expect(audit.action).toBe('ai.review');
    expect(audit.entityType).toBe('aiReview');
    // The MODEL's confidence is recorded, not the reviewer's opinion of it.
    expect(audit.before).toEqual({ aiConfidence: 0.42, aiNeedsReview: true });
    expect(audit.after).toEqual({ aiNeedsReview: false });
    expect(audit.incidentRef).toBe('CG-2026-0001');
  });

  it('leaves the model\'s own fields untouched when a reviewer overrides triage', async () => {
    queuedIncident({ aiTriage: { category: 'medical', urgency: 'high' }, triageSource: 'gemini' });

    await recordReviewDecision(admin(), {
      incidentId: 'i_1',
      decision: 'override',
      reason: 'the report is about a road crash, not breathing',
      note: null,
      adjustment: { category: 'traffic_accident', urgency: 'medium' },
      context: CONTEXT,
    });

    const incident = fake.onlyWrite(isIncidentDoc).data;
    // The whole point of Mechanism 3: the reviewer's judgement is recorded
    // alongside the machine's answer, never written over it.
    expect(incident.aiConfidence).toBeUndefined();
    expect(incident.aiTriage).toBeUndefined();
    expect(incident.triageSource).toBeUndefined();
    expect(incident.aiNeedsReview).toBe(false);
  });

  it('uses the DISMISSED action when the reviewer rejects the triage', async () => {
    queuedIncident({ aiConfidence: 0.58 });

    await recordReviewDecision(admin(), {
      incidentId: 'i_1',
      decision: 'dismiss',
      reason: 'false positive from a vague free-text report',
      note: null,
      adjustment: null,
      context: CONTEXT,
    });

    expect(fake.onlyWrite(inAuditLog).data.action).toBe('ai.review.dismissed');
  });

  it('refuses to touch an incident whose AI confidence was never low', async () => {
    // The model was sure and nobody asked for a look.
    queuedIncident({ aiConfidence: 0.95, aiNeedsReview: false });

    const code = await codeOf(() =>
      recordReviewDecision(admin(), {
        incidentId: 'i_1',
        decision: 'accept',
        reason: 'trying to write an audit entry by hand',
        note: null,
        adjustment: null,
        context: CONTEXT,
      }),
    );

    expect(code).toBe('NOT_IN_REVIEW_QUEUE');
    expect(fake.writes).toHaveLength(0);
  });

  it('reports 409, not 422, once a review exists — the operator must be told the truth', async () => {
    // The incident is already out of the queue because the FIRST reviewer cleared
    // it. If queue membership were checked before the review log, this would
    // return NOT_IN_REVIEW_QUEUE and tell the caller to retry a request that can
    // never succeed again.
    queuedIncident({ aiNeedsReview: false });
    fake.seed('incidents/i_1/aiReviews/rv_first', {
      reviewId: 'rv_first',
      decision: 'accept',
      reviewerUid: 'u_someone_else',
    });

    const code = await codeOf(() =>
      recordReviewDecision(admin(), {
        incidentId: 'i_1',
        decision: 'dismiss',
        reason: 'attempting to overwrite the first reviewer',
        note: null,
        adjustment: null,
        context: CONTEXT,
      }),
    );

    expect(code).toBe('REVIEW_ALREADY_RECORDED');
    expect(fake.writes).toHaveLength(0);
  });

  it('treats a soft-deleted incident as absent rather than reviewing a ghost', async () => {
    queuedIncident({ deletedAt: '2026-01-01T00:00:00.000Z' });

    const code = await codeOf(() =>
      recordReviewDecision(admin(), {
        incidentId: 'i_1',
        decision: 'accept',
        reason: 'reviewing something that no longer exists',
        note: null,
        adjustment: null,
        context: CONTEXT,
      }),
    );

    expect(code).toBe('INCIDENT_NOT_FOUND');
    expect(fake.writes).toHaveLength(0);
  });

  it('reports a missing incident rather than creating a review against nothing', async () => {
    const code = await codeOf(() =>
      recordReviewDecision(admin(), {
        incidentId: 'i_nope',
        decision: 'accept',
        reason: 'reviewing an id that was never issued',
        note: null,
        adjustment: null,
        context: CONTEXT,
      }),
    );

    expect(code).toBe('INCIDENT_NOT_FOUND');
    expect(fake.writes).toHaveLength(0);
  });
});

/* ========================================================================== */
/* Guards still run before any of this                                        */
/* ========================================================================== */

describe('the self-change refusals hold before a transaction is opened', () => {
  it('refuses to change your own role', async () => {
    fake.seed('users/u_admin', { role: 'admin', status: 'active' });

    const code = await codeOf(() =>
      changeUserRole(admin(), {
        targetUid: ADMIN_UID,
        role: 'citizen',
        reason: 'demoting myself to test the guard rail',
        context: CONTEXT,
      }),
    );

    // A specific code, not a blanket FORBIDDEN: this operator IS allowed to change
    // other people's roles, so a generic refusal would send them hunting for a
    // permission problem they do not have.
    expect(code).toBe('SELF_ROLE_CHANGE_FORBIDDEN');
    expect(fake.writes).toHaveLength(0);
  });

  it('refuses to suspend yourself', async () => {
    fake.seed('users/u_admin', { role: 'admin', status: 'active' });

    const code = await codeOf(() =>
      changeAccountState(admin(), {
        targetUid: ADMIN_UID,
        status: 'suspended',
        reason: 'locking myself out to see what happens',
        context: CONTEXT,
      }),
    );

    expect(code).toBe('SELF_DISABLE_FORBIDDEN');
    expect(fake.writes).toHaveLength(0);
  });
});

/* ========================================================================== */
/* No credential or PII material reaches an audit row                          */
/* ========================================================================== */

describe('the audit rows written here carry no secrets', () => {
  it('records the role change without copying anything sensitive off the user doc', async () => {
    fake.seed('users/u_target', {
      role: 'citizen',
      status: 'active',
      email: 'sam@example.org',
      phone: '+92 300 1234567',
      location: { lat: 24.86, lng: 67.0 },
    });

    await changeUserRole(admin(), {
      targetUid: 'u_target',
      role: 'dispatcher',
      reason: 'volunteering as a driver this shift',
      context: CONTEXT,
    });

    const serialised = JSON.stringify(fake.onlyWrite(inAuditLog).data);
    // docs/07 §11.5: whitelisted fields only — never raw PII.
    expect(serialised).not.toContain('sam@example.org');
    expect(serialised).not.toContain('1234567');
    expect(serialised).not.toContain('24.86');
    // ipHash is a hash, which is allowed and required for abuse investigation.
    expect(fake.onlyWrite(inAuditLog).data.ipHash).toBe('iphash_test');
  });
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationChannel } from '@/lib/integrations/contracts';
import type { InAppNotificationSpec } from '@/services/dispatch/notify';
import type { UnifiedRecipient } from '@/services/notifications';

/**
 * ============================================================================
 * Phase 13 behavioral coverage — brief §8
 * ============================================================================
 *
 * `dispatch.test.ts` asserts the STRUCTURE (no create endpoint, uid from the
 * token, the honesty rule for unconfigured channels). This file asserts the
 * BEHAVIOUR against an in-memory Firestore fake and a controllable provider
 * seam: creation, read, fan-out, failed provider, bounded retry, and both
 * senses of a disabled channel.
 *
 * `@/lib/server/firebase-admin` is mocked to hand back the fake, and
 * `@/services/integrations/twilio` is mocked to a channel list the tests can
 * populate. Only these two seams are fake — everything between them
 * (`deliverNotification`, `markRead`, the dedupe transaction, the retry ladder)
 * is the real production code.
 */

/* ========================================================================== */
/* The fake Firestore — exactly the surface dispatch.ts touches                 */
/* ========================================================================== */

type FakeDoc = { coll: string; id: string; data: Record<string, unknown> };

function createFakeDb() {
  const store = new Map<string, FakeDoc>();
  let seq = 0;

  const makeCollection = (name: string) => {
    const state = {
      filters: [] as { field: string; op: string; value: unknown }[],
      limitN: Number.POSITIVE_INFINITY,
      startAfterId: null as string | null,
    };
    const ref = (id: string) => ({
      id,
      path: `${name}/${id}`,
      async update(data: Record<string, unknown>) {
        const doc = store.get(`${name}/${id}`);
        if (doc) doc.data = { ...doc.data, ...data };
      },
    });
    const api = {
      doc(id?: string) {
        return ref(id ?? `auto_${String(++seq).padStart(4, '0')}`);
      },
      where(field: string, op: string, value: unknown) {
        state.filters.push({ field, op, value });
        return api;
      },
      limit(n: number) {
        state.limitN = n;
        return api;
      },
      orderBy(_field: string) {
        return api;
      },
      startAfter(snap: { id: string }) {
        state.startAfterId = snap.id;
        return api;
      },
      async get() {
        let docs = [...store.values()].filter((d) => d.coll === name);
        for (const filter of state.filters) {
          docs = docs.filter((d) => {
            const actual = filter.field === '__name__' ? d.id : d.data[filter.field];
            if (filter.op === '==') return actual === filter.value;
            return false;
          });
        }
        docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (state.startAfterId !== null) {
          const idx = docs.findIndex((d) => d.id === state.startAfterId);
          if (idx >= 0) docs = docs.slice(idx + 1);
        }
        const page = docs.slice(0, state.limitN);
        return {
          empty: page.length === 0,
          size: page.length,
          docs: page.map((d) => ({ id: d.id, data: d.data, ref: ref(d.id) })),
        };
      },
    };
    return api;
  };

  const db = {
    collection: makeCollection,
    async runTransaction<T>(
      fn: (tx: {
        get(ref: { path: string }): Promise<{ exists: boolean; data: Record<string, unknown> | undefined }>;
        set(ref: { path: string }, data: Record<string, unknown>): void;
      }) => Promise<T>,
    ): Promise<T> {
      const staged = new Map<string, Record<string, unknown>>();
      // The real runTransaction resolves to the callback's return value — the
      // service reads it to learn whether the transaction wrote. Swallowing it
      // here would report every delivery as a dedupe.
      return await fn({
        async get(ref) {
          const existing = store.get(ref.path);
          if (existing) return { exists: true, data: existing.data };
          const pending = staged.get(ref.path);
          return { exists: pending !== undefined, data: pending };
        },
        set(ref, data) {
          staged.set(ref.path, data);
          const existing = store.get(ref.path);
          if (existing) existing.data = { ...existing.data, ...data };
          else {
            const [coll, id] = ref.path.split('/');
            store.set(ref.path, { coll: coll ?? '', id: id ?? '', data: { ...data } });
          }
        },
      });
    },
    batch() {
      const ops: Array<() => void> = [];
      return {
        update(ref: { path: string }, data: Record<string, unknown>) {
          ops.push(() => {
            const doc = store.get(ref.path);
            if (doc) doc.data = { ...doc.data, ...data };
          });
        },
        async commit() {
          for (const op of ops) op();
        },
      };
    },
  };

  const rows = () => [...store.values()].filter((d) => d.coll === 'notifications');
  return { db, store, rows };
}

/* ========================================================================== */
/* Hoisted fakes + module mocks                                                */
/* ========================================================================== */

const fake = vi.hoisted(() => {
  const admin = { current: null as null | ReturnType<typeof createFakeDb> };
  const channels: NotificationChannel[] = [];
  return { admin, channels };
});

vi.mock('@/lib/server/firebase-admin', () => ({
  getAdminDb: () => {
    if (fake.admin.current === null) throw new Error('The fake admin db was not set for this test.');
    return fake.admin.current.db;
  },
  adminConfigurationReason: () => (fake.admin.current === null ? 'unconfigured in this test' : null),
}));

vi.mock('@/services/integrations/twilio', () => ({
  getExternalChannels: () => fake.channels,
  providerStatus: () => ({ provider: 'twilio', configured: false, requiredVars: [], problem: null }),
}));

/* ========================================================================== */
/* Imports under test — AFTER the mocks are declared                           */
/* ========================================================================== */

import {
  deliverNotification,
  deliverToRecipients,
  markAllRead,
  markRead,
} from '@/services/notifications';
// The barrel does not re-export the ladder; the module is the source of truth.
import { providerBackoffMs } from '@/services/notifications/dispatch';

const RETRY_ENV = 'NOTIFICATION_RETRY_LIMIT';

function spec(overrides: Partial<InAppNotificationSpec> = {}): InAppNotificationSpec {
  return {
    type: 'incident_assigned',
    severity: 'critical',
    title: 'You were assigned an incident',
    body: 'A new assignment needs your answer.',
    incidentId: 'inc_1',
    incidentRef: 'CG-000123',
    link: '/incidents/inc_1',
    actor: { uid: 'dispatcher_1', displayName: 'Dana Dispatcher' },
    ...overrides,
  };
}

/** A provider channel the test controls completely. */
function fakeChannel(
  channel: NotificationChannel['channel'],
  send: NotificationChannel['send'],
): NotificationChannel {
  return { channel, isAvailable: () => true, send };
}

beforeEach(() => {
  fake.admin.current = createFakeDb();
  fake.channels.length = 0;
  process.env.LOG_LEVEL = 'error';
  delete process.env[RETRY_ENV];
});

afterEach(() => {
  delete process.env[RETRY_ENV];
  delete process.env.LOG_LEVEL;
});

/* ========================================================================== */
/* §8 — notification creation                                                  */
/* ========================================================================== */

describe('notification creation (brief §1)', () => {
  it('an in-app delivery writes ONE row carrying every field the brief requires', async () => {
    const outcome = await deliverNotification({
      spec: spec(),
      recipient: { uid: 'user_1', role: 'responder' },
      channel: 'in_app',
      requestId: 'req_test',
    });

    expect(outcome).toMatchObject({
      channel: 'in_app',
      status: 'delivered',
      providerAccepted: true,
      attempts: 1,
      reason: null,
    });
    expect(typeof outcome.notificationId).toBe('string');

    const rows = fake.admin.current!.rows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!.data;
    // The six fields brief §1 names for every notification, plus the row's own
    // identity and read state:
    expect(row.recipientId).toBe('user_1');          // recipient
    expect(row.incidentId).toBe('inc_1');            // incident ID
    expect(row.type).toBe('incident_assigned');      // notification type
    expect(row.channel).toBe('in_app');              // channel
    expect(row.status).toBe('delivered');            // status
    expect(row.retryCount).toBe(0);                  // retry count
    expect(row.createdAt).toBeDefined();             // created timestamp
    expect(row.notificationId).toBe(outcome.notificationId);
    expect(row.read).toBe(false);
  });

  it('the same fact on the same channel is deduped, not duplicated', async () => {
    const input = {
      spec: spec(),
      recipient: { uid: 'user_1', role: 'responder' as const },
      channel: 'in_app' as const,
      requestId: 'req_test',
    };
    const first = await deliverNotification(input);
    const second = await deliverNotification(input);

    expect(first.status).toBe('delivered');
    expect(second.status).toBe('deduped');
    expect(second.notificationId).toBeNull();
    expect(fake.admin.current!.rows()).toHaveLength(1);
  });
});

/* ========================================================================== */
/* §8 — notification read                                                      */
/* ========================================================================== */

describe('notification read (brief §2)', () => {
  it('markRead flips read/readAt on the owner’s row', async () => {
    const { notificationId } = await deliverNotification({
      spec: spec(),
      recipient: { uid: 'user_1', role: 'responder' },
      channel: 'in_app',
      requestId: 'req_test',
    });

    const result = await markRead(notificationId!, 'user_1');
    expect(result.markedRead).toBe(1);

    const row = fake.admin.current!.rows()[0]!;
    expect(row.data.read).toBe(true);
    expect(row.data.readAt).toBeDefined();
  });

  it('markRead for somebody else’s notification matches ZERO rows and writes nothing', async () => {
    const { notificationId } = await deliverNotification({
      spec: spec(),
      recipient: { uid: 'user_1', role: 'responder' },
      channel: 'in_app',
      requestId: 'req_test',
    });

    const result = await markRead(notificationId!, 'user_2');
    expect(result.markedRead).toBe(0);

    const row = fake.admin.current!.rows()[0]!;
    expect(row.data.read).toBe(false);
    expect(row.data.readAt).toBeNull();
  });

  it('markAllRead marks every unread row of THAT user only', async () => {
    // Distinct facts per delivery — the dedupe key collapses two identical specs
    // for the same recipient into one row by design.
    const write = (uid: string, n: number) =>
      deliverNotification({
        spec: spec({ incidentId: `inc_${n}`, incidentRef: `CG-00012${n}` }),
        recipient: { uid, role: 'responder' },
        channel: 'in_app',
        requestId: 'req_test',
      });

    await write('user_1', 1);
    await write('user_1', 2);
    await write('user_2', 3);

    const result = await markAllRead('user_1');
    expect(result.markedRead).toBe(2);

    const rows = fake.admin.current!.rows();
    const user1 = rows.filter((r) => r.data.recipientId === 'user_1');
    const user2 = rows.filter((r) => r.data.recipientId === 'user_2');
    expect(user1).toHaveLength(2);
    expect(user1.every((r) => r.data.read === true)).toBe(true);
    expect(user2.every((r) => r.data.read === false)).toBe(true);
  });
});

/* ========================================================================== */
/* §8 — dispatch notification fan-out                                          */
/* ========================================================================== */

describe('dispatch notification fan-out (brief §1, §3)', () => {
  it('one in-app row per server-derived recipient, with an honest summary', async () => {
    const { summary, outcomes, channelsUsed } = await deliverToRecipients({
      spec: spec({ type: 'dispatch_received', title: 'New dispatch' }),
      recipients: [
        { uid: 'responder_1', role: 'responder' },
        { uid: 'responder_2', role: 'responder' },
      ],
      requestId: 'req_test',
    });

    expect(channelsUsed).toEqual(['in_app']);
    expect(outcomes).toHaveLength(2);
    expect(summary).toMatchObject({ delivered: 2, failed: 0, unavailable: 0 });
    expect(fake.admin.current!.rows()).toHaveLength(2);
    expect(fake.admin.current!.rows().every((r) => r.data.type === 'dispatch_received')).toBe(true);
  });

  it('a recipient with no server-derived role is refused before ANY write (brief §7)', async () => {
    await expect(
      deliverToRecipients({
        spec: spec(),
        // The type does not allow a role-less recipient; the runtime check is the
        // belt that catches a future caller casting its way around the type.
        recipients: [{ uid: 'invented_uid' } as unknown as UnifiedRecipient],
        requestId: 'req_test',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(fake.admin.current!.rows()).toHaveLength(0);
  });
});

/* ========================================================================== */
/* §8 — failed provider                                                        */
/* ========================================================================== */

describe('failed provider (brief §8)', () => {
  it('a provider that refuses every attempt leaves a FAILED row, not a delivered one', async () => {
    process.env[RETRY_ENV] = '0'; // one attempt total: fastest honest ladder
    const send = vi.fn(async () => {
      throw new Error('provider down');
    });
    fake.channels.push(fakeChannel('sms', send));

    const outcome = await deliverNotification({
      spec: spec(),
      recipient: { uid: 'user_1', role: 'responder' },
      channel: 'sms',
      requestId: 'req_test',
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      channel: 'sms',
      status: 'failed',
      providerAccepted: false,
      attempts: 1,
    });
    expect(outcome.reason).toMatch(/failed after 1 attempt/i);

    const row = fake.admin.current!.rows()[0]!;
    expect(row.data.status).toBe('failed');
    expect(row.data.retryCount).toBe(1);
  });
});

/* ========================================================================== */
/* §8 — the retry ceiling (brief §5)                                           */
/* ========================================================================== */

describe('the retry ceiling is enforced by counting attempts (brief §5)', () => {
  it('NOTIFICATION_RETRY_LIMIT=1 means exactly two provider calls, then a failed row', async () => {
    process.env[RETRY_ENV] = '1';
    const send = vi.fn(async () => {
      throw new Error('still down');
    });
    fake.channels.push(fakeChannel('sms', send));

    const outcome = await deliverNotification({
      spec: spec(),
      recipient: { uid: 'user_1', role: 'responder' },
      channel: 'sms',
      requestId: 'req_test',
    });

    expect(send).toHaveBeenCalledTimes(2); // one try + one retry, NEVER a third
    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(2);
    expect(fake.admin.current!.rows()[0]!.data.retryCount).toBe(2);
  }, 15_000);

  it('a provider that recovers mid-ladder records the retries honestly', async () => {
    process.env[RETRY_ENV] = '2';
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('first attempt fails'))
      .mockResolvedValueOnce({ providerMessageId: 'SM1001' });
    fake.channels.push(fakeChannel('sms', send));

    const outcome = await deliverNotification({
      spec: spec(),
      recipient: { uid: 'user_1', role: 'responder' },
      channel: 'sms',
      requestId: 'req_test',
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ status: 'delivered', attempts: 2, providerAccepted: true });

    const row = fake.admin.current!.rows()[0]!;
    expect(row.data.status).toBe('delivered');
    expect(row.data.retryCount).toBe(1);
  }, 15_000);

  it('the backoff ladder stays inside its documented bounds', () => {
    // 2s before the first retry, 8s after, each ±20%.
    for (let i = 0; i < 20; i += 1) {
      expect(providerBackoffMs(1)).toBeGreaterThanOrEqual(1_600);
      expect(providerBackoffMs(1)).toBeLessThanOrEqual(2_400);
      expect(providerBackoffMs(2)).toBeGreaterThanOrEqual(6_400);
      expect(providerBackoffMs(2)).toBeLessThanOrEqual(9_600);
      expect(providerBackoffMs(5)).toBeGreaterThanOrEqual(6_400);
      expect(providerBackoffMs(5)).toBeLessThanOrEqual(9_600);
    }
  });
});

/* ========================================================================== */
/* §8 — disabled channel (both senses of "disabled")                            */
/* ========================================================================== */

describe('disabled channels (brief §4)', () => {
  it('a channel with no configured provider is UNAVAILABLE and writes no row at all', async () => {
    // No channels pushed — the deployment has no SMS provider, exactly like
    // production today.
    const outcome = await deliverNotification({
      spec: spec(),
      recipient: { uid: 'user_1', role: 'responder' },
      channel: 'sms',
      requestId: 'req_test',
    });

    expect(outcome).toMatchObject({
      status: 'unavailable',
      notificationId: null,
      attempts: 0,
    });
    expect(outcome.reason).toMatch(/not configured/i);
    // Unavailability must not become write amplification: no attempt, no row.
    expect(fake.admin.current!.rows()).toHaveLength(0);
  });

  it('a recipient who switched the channel off is suppressed, not sent', async () => {
    const send = vi.fn(async () => ({ providerMessageId: 'SM1002' }));
    fake.channels.push(fakeChannel('sms', send));

    const outcome = await deliverNotification({
      spec: spec(),
      recipient: { uid: 'user_1', role: 'responder', channelEnabled: false },
      channel: 'sms',
      requestId: 'req_test',
    });

    expect(send).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'suppressed', notificationId: null, attempts: 0 });
    expect(fake.admin.current!.rows()).toHaveLength(0);
  });

  it('deliverToRecipients never attempts a channel the deployment cannot deliver on', async () => {
    const send = vi.fn(async () => ({ providerMessageId: 'SM1003' }));
    fake.channels.push({ channel: 'sms', isAvailable: () => false, send });

    const { outcomes, channelsUsed } = await deliverToRecipients({
      spec: spec(),
      recipients: [{ uid: 'user_1', role: 'responder' }],
      channels: ['sms', 'in_app'],
      requestId: 'req_test',
    });

    expect(channelsUsed).toEqual(['in_app']);
    expect(outcomes.every((o) => o.channel === 'in_app')).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});

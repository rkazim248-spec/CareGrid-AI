import { describe, expect, it } from 'vitest';

import {
  MissingHistoryReasonError,
  REASON_REQUIRED_EVENTS,
  buildStatusHistoryEvent,
} from '@/services/dispatch/status-history';
import { HISTORY_EVENT_TYPES } from '@/types';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const base = {
  incidentId: 'r7Kp2mQ9xL4nT8vB3cD6',
  eventType: 'status_change' as const,
  fromStatus: 'assigned' as const,
  toStatus: 'en_route' as const,
  actorUid: 'u_ahmed',
  actorRole: 'responder' as const,
  requestId: 'req_abc',
};

/* ========================================================================== */
/* FR-052 — every transition records an event                                  */
/* ========================================================================== */

describe('a status change is recorded as an event', () => {
  it('carries the from and to, the actor, and the request id', () => {
    // docs/07 §6's field list. `requestId` is FR-141, the correlation with server
    // logs — without it a history row cannot be tied to the request that made it.
    const event = buildStatusHistoryEvent(base);
    expect(event).toMatchObject({
      incidentId: 'r7Kp2mQ9xL4nT8vB3cD6',
      fromStatus: 'assigned',
      toStatus: 'en_route',
      actorUid: 'u_ahmed',
      actorRole: 'responder',
      requestId: 'req_abc',
    });
  });

  it('does NOT set createdAt — the caller stamps it with a server timestamp', () => {
    // A host clock is not an authority on when an event happened, and a history
    // row whose `createdAt` came from the application is a history row that can be
    // back-dated by a misconfigured host.
    expect('createdAt' in buildStatusHistoryEvent(base)).toBe(false);
  });

  it('`fromStatus` may be null, for a `created` event', () => {
    const event = buildStatusHistoryEvent({
      ...base,
      eventType: 'created',
      fromStatus: null,
      toStatus: 'new',
    });
    expect(event.fromStatus).toBeNull();
    expect(event.toStatus).toBe('new');
  });
});

/* ========================================================================== */
/* docs/07 §6 — the reason requirement                                         */
/* ========================================================================== */

describe('a reason is REQUIRED where docs/07 §6 says it is', () => {
  // docs/07 §6: "reason | string | null | required for `false_alarm`, `cancelled`,
  // merge, unassign".
  //
  // Enforced in the BUILDER rather than at each call site, because a history event
  // is exactly the kind of record written once, in a hurry, and never read again —
  // the moment to insist is when it is built.

  it.each([...REASON_REQUIRED_EVENTS])('%s without a reason is refused', (eventType) => {
    expect(() => buildStatusHistoryEvent({ ...base, eventType, reason: null })).toThrow(
      MissingHistoryReasonError,
    );
  });

  it.each([...REASON_REQUIRED_EVENTS])('%s WITH a reason is accepted', (eventType) => {
    expect(() =>
      buildStatusHistoryEvent({ ...base, eventType, reason: 'Ahmed is at capacity.' }),
    ).not.toThrow();
  });

  it('a WHITESPACE-ONLY reason is not a reason', () => {
    // `"  "` stored as the reason produces a row that looks compliant and explains
    // nothing, which is worse than an obviously missing value.
    expect(() => buildStatusHistoryEvent({ ...base, eventType: 'unassigned', reason: '   ' })).toThrow(
      MissingHistoryReasonError,
    );
    expect(() => buildStatusHistoryEvent({ ...base, eventType: 'unassigned', reason: '\n\t ' })).toThrow(
      MissingHistoryReasonError,
    );
  });

  it('names the event type in the error, so the developer knows which call site', () => {
    try {
      buildStatusHistoryEvent({ ...base, eventType: 'merged', reason: null });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingHistoryReasonError);
      expect((error as MissingHistoryReasonError).eventType).toBe('merged');
    }
  });

  it('an `assigned` event does NOT require a reason', () => {
    // The reason for assigning IS the decision, and a dispatcher is not going to
    // write prose on every one.
    expect(() => buildStatusHistoryEvent({ ...base, eventType: 'assigned' })).not.toThrow();
  });

  it('a plain `status_change` does not require one either', () => {
    expect(() => buildStatusHistoryEvent({ ...base, eventType: 'status_change' })).not.toThrow();
  });
});

/* ========================================================================== */
/* Normalisation                                                               */
/* ========================================================================== */

describe('optional text is normalised rather than stored as-is', () => {
  it('trims a reason and a note, and turns blank into null', () => {
    const event = buildStatusHistoryEvent({
      ...base,
      reason: '  Ahmed is at capacity.  ',
      note: '  Two minutes out.  ',
    });
    expect(event.reason).toBe('Ahmed is at capacity.');
    expect(event.note).toBe('Two minutes out.');
  });

  it('an empty note becomes null, not an empty string', () => {
    // `''` and `null` are indistinguishable to a reader, and `null` is
    // distinguishable to a query.
    expect(buildStatusHistoryEvent({ ...base, note: '   ' }).note).toBeNull();
    expect(buildStatusHistoryEvent({ ...base, note: undefined }).note).toBeNull();
  });

  it('metadata defaults to null rather than an empty object', () => {
    expect(buildStatusHistoryEvent(base).metadata).toBeNull();
  });
});

/* ========================================================================== */
/* Metadata cannot hold a coordinate                                           */
/* ========================================================================== */

describe('metadata is a SCALAR union, so a coordinate is not representable', () => {
  // docs/07 §6: "metadata | map | | small, non-sensitive: e.g. `{ "slaState":
  // "at_risk" }`".
  //
  // The narrow type is the control, not a comment. The most likely leak is a
  // caller helpfully passing `geo` into a "small metadata" map, and with a
  // `Record<string, unknown>` that compiles.
  it('accepts scalars', () => {
    const event = buildStatusHistoryEvent({
      ...base,
      metadata: { dispatchId: 'd_9fK2', skippedEnRoute: true, responseSec: 42, code: null },
    });
    expect(event.metadata).toEqual({
      dispatchId: 'd_9fK2',
      skippedEnRoute: true,
      responseSec: 42,
      code: null,
    });
  });

  it('the documented `assigned → on_scene` jump is RECORDED, not refused', () => {
    // docs/07 §4.3 calls it "documented jump, flagged". A responder who arrives
    // without opening the app has told us something real; the service records which
    // step was skipped so the timeline shows the gap.
    const event = buildStatusHistoryEvent({
      ...base,
      fromStatus: 'assigned',
      toStatus: 'on_scene',
      metadata: { skippedEnRoute: true },
    });
    expect(event.fromStatus).toBe('assigned');
    expect(event.toStatus).toBe('on_scene');
    expect(event.metadata).toEqual({ skippedEnRoute: true });
  });
});

/* ========================================================================== */
/* The event vocabulary                                                        */
/* ========================================================================== */

describe('the event vocabulary is Phase 3 declared, not re-declared', () => {
  it('the reason-required set is a subset of the declared event types', () => {
    for (const eventType of REASON_REQUIRED_EVENTS) {
      expect(HISTORY_EVENT_TYPES, eventType).toContain(eventType);
    }
  });

  it('every event type the phase emits is declared', () => {
    // The four this phase produces: an assignment, a decline, a status change, and
    // a verification.
    for (const eventType of ['assigned', 'unassigned', 'status_change', 'verified'] as const) {
      expect(HISTORY_EVENT_TYPES, eventType).toContain(eventType);
    }
  });

  it('`false_alarm` requires a reason too, per docs/07 §6', () => {
    expect(REASON_REQUIRED_EVENTS.has('false_alarm')).toBe(true);
  });
});

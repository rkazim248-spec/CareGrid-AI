import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_NOTIFICATION_CLAIMS,
  NOTIFICATION_COPY,
  notificationDedupeKey,
  recipientsForEvent,
  type InAppNotificationSpec,
} from '@/services/dispatch/notify';
import { NOTIFICATION_TYPES, type UserRole } from '@/types';

/* ========================================================================== */
/* brief §28 — the copy may not overclaim                                      */
/* ========================================================================== */

describe('NO notification claims something the system has not verified', () => {
  // brief §28: "Do NOT claim 'Emergency services are arriving' unless that is
  // actually verified by the system."
  //
  // Asserted against EVERY string the phase can produce, at once, rather than by
  // reading each one. A check that only covers the copy someone remembered to
  // write is a check that passes the week someone adds a fourth event.

  const everyCopyString = [
    ...Object.values(NOTIFICATION_COPY.assignmentReceived('CG-1')),
    ...Object.values(NOTIFICATION_COPY.assignmentAccepted('CG-1', 'Ahmed')),
    ...Object.values(NOTIFICATION_COPY.assignmentDeclined('CG-1', 'Ahmed')),
    ...Object.values(NOTIFICATION_COPY.reportAssigned('CG-1')),
    ...Object.values(NOTIFICATION_COPY.incidentResolved('CG-1')),
    ...Object.values(NOTIFICATION_COPY.incidentCancelled('CG-1')),
  ];

  it.each(FORBIDDEN_NOTIFICATION_CLAIMS)('no copy contains %j', (claim) => {
    for (const text of everyCopyString) {
      expect(text.toLowerCase(), text).not.toContain(claim);
    }
  });

  it('the forbidden list covers the claims the brief names, plus the two adjacent ones', () => {
    expect(FORBIDDEN_NOTIFICATION_CLAIMS).toContain('emergency services are arriving');
    expect(FORBIDDEN_NOTIFICATION_CLAIMS).toContain('help is on the way');
    // And the ones a well-meaning author would reach for next. docs/27 lists
    // government and hospital integrations as NOT implemented, so asserting about
    // an ambulance is asserting about a system that does not exist here.
    expect(FORBIDDEN_NOTIFICATION_CLAIMS).toContain('an ambulance has been sent');
  });

  it('ACCEPTANCE is not reported as DEPARTURE', () => {
    // The subtle version of the same rule: "accepted" and "on the way" are
    // different events, and only the second would support the claim. A responder
    // accepts and then may sit on their hands for a minute.
    const { title, body } = NOTIFICATION_COPY.assignmentAccepted('CG-4T7B2N', 'Ahmed Khan');
    expect(`${title} ${body}`.toLowerCase()).not.toMatch(/on (the|their) way|arriv|heading|driv/);
  });

  it('the assignment copy names WHO assigned it, so a responder can judge the source', () => {
    // A responder deciding whether to accept needs to know a person chose, not a
    // system. That is brief §3's human-in-the-loop rule, visible in the words.
    const { body } = NOTIFICATION_COPY.assignmentReceived('CG-4T7B2N');
    expect(body).toMatch(/a dispatcher has assigned/i);
  });

  it('the reporter is told the report was ASSIGNED, not that help is coming', () => {
    // brief §27's example is deliberately modest. Assignment happens before anyone
    // has accepted, and a responder may decline a minute later.
    const { title, body } = NOTIFICATION_COPY.reportAssigned('CG-4T7B2N');
    expect(title).toBe('Responder assigned');
    expect(body).toMatch(/has been assigned to a responder/i);
    expect(body.toLowerCase()).not.toMatch(/on the way|arriv|coming/);
  });

  it('a decline ENDS WITH THE INSTRUCTION, not a reassurance', () => {
    // brief §18: a rejection goes back to the dispatcher, who chooses another.
    const { body } = NOTIFICATION_COPY.assignmentDeclined('CG-4T7B2N', 'Ahmed Khan');
    expect(body).toMatch(/choose another responder or keep the incident pending/i);
  });

  it('the human reference appears in the copy, not a Firestore id', () => {
    // docs/07 §1.1: "Citizens and responders quote short codes in the field."
    const { body } = NOTIFICATION_COPY.assignmentReceived('CG-4T7B2N');
    expect(body).toContain('CG-4T7B2N');
  });
});

/* ========================================================================== */
/* The dedupe key                                                              */
/* ========================================================================== */

describe('the dedupe key makes a RETRY safe and a SECOND TARGET distinct', () => {
  const spec = (actor: string | null): InAppNotificationSpec => ({
    type: 'incident_assigned',
    severity: 'critical',
    title: 'New emergency assignment',
    body: 'body',
    incidentId: 'r7Kp2mQ9xL4nT8vB3cD6',
    incidentRef: 'CG-4T7B2N',
    link: null,
    actor: actor === null ? null : { uid: actor, displayName: 'Someone' },
  });

  it('a retry of the SAME notification produces the SAME key', () => {
    // This is what makes FR-108's idempotency guard work: a dispatcher whose
    // request timed out retries and must not double-notify.
    expect(notificationDedupeKey('u_ahmed', spec('u_disp01'))).toBe(
      notificationDedupeKey('u_ahmed', spec('u_disp01')),
    );
  });

  it('a DIFFERENT responder gets a DIFFERENT key', () => {
    expect(notificationDedupeKey('u_ahmed', spec(null))).not.toBe(
      notificationDedupeKey('u_sara', spec(null)),
    );
  });

  it('a DIFFERENT actor produces a different key, so reassignment is not swallowed', () => {
    // "Assign Ahmed" then "assign Sara" then a RETRY of "assign Ahmed" must notify
    // Ahmed twice and Sara once. A key of type + incident alone would swallow the
    // second notification and a dispatcher would wait for a responder who was never
    // told.
    const ahmedByA = notificationDedupeKey('u_ahmed', spec('u_disp01'));
    const ahmedByB = notificationDedupeKey('u_ahmed', spec('u_disp02'));
    expect(ahmedByA).not.toBe(ahmedByB);
  });

  it('a different incident gets a different key', () => {
    const other: InAppNotificationSpec = { ...spec(null), incidentRef: 'CG-9ZZZ11', incidentId: 'other' };
    expect(notificationDedupeKey('u_ahmed', spec(null))).not.toBe(
      notificationDedupeKey('u_ahmed', other),
    );
  });

  it('the key contains no slash, because a slash would write to a NESTED path', () => {
    // Firestore treats `/` in a document id as a path separator, so a key
    // containing one would silently write somewhere else entirely.
    const key = notificationDedupeKey('u_who/../admin', spec('u_disp/01'));
    expect(key).not.toContain('/');
    expect(key).not.toContain('..');
  });

  it('a null incidentRef falls back to the id, then to a literal', () => {
    const noRef: InAppNotificationSpec = { ...spec(null), incidentRef: null, incidentId: null };
    expect(notificationDedupeKey('u_ahmed', noRef)).toContain('none');
  });
});

/* ========================================================================== */
/* The recipient matrix — docs/07 §10.2                                        */
/* ========================================================================== */

describe('recipients follow the documented dispatch matrix', () => {
  const actors = {
    responderUid: 'u_ahmed',
    responderName: 'Ahmed Khan',
    dispatcherUid: 'u_disp01',
    dispatcherName: 'Rehan',
    reporterUid: 'u_reporter',
  };

  it('an assignment notifies the RESPONDER only', () => {
    // docs/07 §10.2: `incident_assigned` -> assigned responder.
    const { uids, roles } = recipientsForEvent('assigned', actors);
    expect(uids).toEqual(['u_ahmed']);
    expect(roles.get('u_ahmed')).toBe('responder');
  });

  it('an acceptance or a decline notifies the DISPATCHER, not a broadcast', () => {
    // docs/07 §10.2's `status_changed` row says "all dispatchers", and
    // `responder_unavailable` says "dispatchers who had that responder". Narrowed
    // to the assigning dispatcher, because this is one person's answer and a
    // broadcast would page every dispatcher in the city for one response.
    for (const event of ['accepted', 'declined'] as const) {
      const { uids } = recipientsForEvent(event, actors);
      expect(uids, event).toEqual(['u_disp01']);
    }
  });

  it('a resolution notifies the reporter, the responder AND the dispatcher', () => {
    // docs/07 §10.2: `incident_resolved` -> reporter, all dispatchers, assignee.
    const { uids, roles } = recipientsForEvent('resolved', actors);
    expect(new Set(uids)).toEqual(new Set(['u_reporter', 'u_ahmed', 'u_disp01']));
    expect(roles.get('u_reporter')).toBe('citizen');
    expect(roles.get('u_ahmed')).toBe('responder');
  });

  it('a cancellation notifies the REPORTER only', () => {
    // docs/07 §10.2: `status_changed` -> "the reporter for terminal states only".
    // Dispatchers see the dispatch screen, not a notification.
    expect(recipientsForEvent('cancelled', actors).uids).toEqual(['u_reporter']);
  });

  it('a null uid is skipped rather than producing a notification for nobody', () => {
    const { uids } = recipientsForEvent('accepted', { ...actors, dispatcherUid: null });
    expect(uids).toEqual([]);
  });

  it('an empty string uid is treated as absent, not as a recipient named ""', () => {
    expect(recipientsForEvent('assigned', { ...actors, responderUid: '' }).uids).toEqual([]);
  });

  it('a person in TWO roles is notified ONCE', () => {
    // A dispatcher who is also the reporter would otherwise get two rows in their
    // bell for one fact.
    const { uids } = recipientsForEvent('resolved', {
      ...actors,
      reporterUid: 'u_disp01',
    });
    expect(uids.filter((uid) => uid === 'u_disp01')).toHaveLength(1);
    // And they keep the FIRST role the matrix assigned, so the list cannot
    // disagree with the matrix that built it.
    expect(recipientsForEvent('resolved', { ...actors, reporterUid: 'u_disp01' }).roles.get('u_disp01')).toBe(
      'citizen',
    );
  });

  it('every notification type this phase uses is in the documented enum', () => {
    for (const type of [
      'incident_assigned',
      'status_changed',
      'responder_unavailable',
      'incident_resolved',
    ] as const) {
      expect(NOTIFICATION_TYPES, type).toContain(type);
    }
  });

  it('never produces a role that is not one of the four', () => {
    const roles: UserRole[] = ['citizen', 'responder', 'dispatcher', 'admin'];
    for (const event of ['assigned', 'accepted', 'declined', 'resolved', 'cancelled'] as const) {
      const { roles: map } = recipientsForEvent(event, actors);
      for (const role of map.values()) expect(roles).toContain(role);
    }
  });
});

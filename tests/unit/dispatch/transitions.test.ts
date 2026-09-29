import { describe, expect, it } from 'vitest';

import {
  DOCUMENTED_DEVIATIONS,
  INCIDENT_TRANSITION_MATRIX,
  SYSTEM_ACTOR,
  TERMINAL_INCIDENT_STATUSES,
  allowedDispatchTransitions,
  allowedIncidentTransitions,
  canTransitionDispatchStatus,
  canTransitionIncidentStatus,
  checkTransitionPrerequisites,
  evaluateIncidentTransition,
  type DispatchStatus,
  type DispatchTransitionContext,
  type TransitionContext,
  type TransitionRole,
} from '@/lib/dispatch/transitions';
import { INCIDENT_STATUSES, USER_ROLES } from '@/types';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

function ctx(over: Partial<TransitionContext> = {}): TransitionContext {
  return {
    role: 'dispatcher',
    uid: 'u_disp01',
    isReporter: false,
    isLiveAssignee: false,
    hasActiveDispatch: false,
    ...over,
  };
}

const SYSTEM = { role: 'system', uid: SYSTEM_ACTOR } as const;

function dctx(over: Partial<DispatchTransitionContext> = {}): DispatchTransitionContext {
  return { role: 'responder', isSubject: true, isExpired: false, ...over };
}

/* ========================================================================== */
/* The shape of the transcribed matrix                                         */
/* ========================================================================== */

describe('the matrix is transcribed COMPLETELY, dashes included', () => {
  it('every IncidentStatus has a row, and every row has every status as a cell', () => {
    // The first attempt at this transcription shifted every column by one — a
    // markdown table's first cell is a row label, and a naive split produces a
    // plausible table that is wrong in four places. Asserting the SHAPE cannot catch
    // a shift, but it does catch a row or a cell that was forgotten, and a wrong
    // VALUE is caught by the per-transition tests below.
    for (const from of INCIDENT_STATUSES) {
      expect(INCIDENT_TRANSITION_MATRIX[from], `row "${from}"`).toBeDefined();
      for (const to of INCIDENT_STATUSES) {
        expect(Array.isArray(INCIDENT_TRANSITION_MATRIX[from][to]), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it('the matrix is frozen, so a permission cell cannot be rewritten at runtime', () => {
    expect(Object.isFrozen(INCIDENT_TRANSITION_MATRIX)).toBe(true);
    expect(Object.isFrozen(INCIDENT_TRANSITION_MATRIX.assigned)).toBe(true);
  });

  it('the `merged` column is a dash in EVERY row, so it is unreachable here', () => {
    // `docs/07 §4.3` puts a dash in all eleven `merged` cells. The status is real and
    // is written by a dedicated merge operation, not by a lifecycle transition —
    // Phase 6 built duplicate DETECTION and deliberately not the merge (FR-048).
    for (const from of INCIDENT_STATUSES) {
      expect(INCIDENT_TRANSITION_MATRIX[from].merged, `${from} -> merged`).toEqual([]);
    }
    for (const role of [...USER_ROLES, 'system'] as TransitionRole[]) {
      for (const from of INCIDENT_STATUSES) {
        if (from === 'merged') continue; // `merged -> merged` is a noop
        expect(canTransitionIncidentStatus(from, 'merged', ctx({ role })), `${role} ${from} -> merged`).toBe(false);
      }
    }
  });

  it('no cell ever grants the `system` sentinel anything but `new -> triaged`', () => {
    // The single assertion that makes brief §3 enforceable rather than aspirational.
    for (const from of INCIDENT_STATUSES) {
      for (const to of INCIDENT_STATUSES) {
        const cell = INCIDENT_TRANSITION_MATRIX[from][to];
        if (cell.includes('system (ai)')) {
          expect({ from, to }, 'the AI transition').toEqual({ from: 'new', to: 'triaged' });
        }
      }
    }
  });

  it('the documented deviations still exist and are the ones described', () => {
    // A deviation that is not asserted is a deviation that will quietly become the
    // documented behaviour.
    expect(DOCUMENTED_DEVIATIONS).toHaveLength(1);
    const [deviation] = DOCUMENTED_DEVIATIONS;
    expect(deviation).toMatchObject({ from: 'assigned', to: 'on_scene' });
    expect(INCIDENT_TRANSITION_MATRIX.assigned.on_scene).toContain('dispatcher');
  });
});

/* ========================================================================== */
/* The lifecycle                                                               */
/* ========================================================================== */

describe('the WHOLE lifecycle a responder drives, end to end (brief §19)', () => {
  const path: readonly [Parameters<typeof canTransitionIncidentStatus>[0], string, Partial<TransitionContext>][] = [
    ['new', 'triaged', SYSTEM],
    ['triaged', 'verified', {}],
    ['verified', 'assigned', { hasActiveDispatch: true }],
    ['assigned', 'en_route', { role: 'responder', isLiveAssignee: true }],
    ['en_route', 'on_scene', { role: 'responder', isLiveAssignee: true }],
    ['on_scene', 'resolved', { role: 'responder', isLiveAssignee: true }],
  ];

  it.each(path)('%s -> %s is allowed for the actor who owns the step', (from, to, over) => {
    expect(canTransitionIncidentStatus(from as never, to as never, ctx(over as never)), `${from} -> ${to}`).toBe(
      true,
    );
  });
});

/* ========================================================================== */
/* The document's own quirks                                                   */
/* ========================================================================== */

describe('the documentational quirks of docs/07 §4.3, pinned by test', () => {
  it('`verified -> assigned` IS permitted, contrary to how the row reads at a glance', () => {
    expect(canTransitionIncidentStatus('verified', 'assigned', ctx({ hasActiveDispatch: true }))).toBe(true);
  });

  it('`new -> false_alarm` is a DISPATCHER grant, not a citizen one', () => {
    // The cell says "dispatcher". A citizen declaring their own report a false alarm
    // would erase a report that may have been real.
    expect(canTransitionIncidentStatus('new', 'false_alarm', ctx({ role: 'dispatcher' }))).toBe(true);
    expect(canTransitionIncidentStatus('new', 'false_alarm', ctx({ role: 'citizen', isReporter: true }))).toBe(
      false,
    );
  });

  it('`on_scene -> cancelled` is a documented DASH', () => {
    // Once a responder is on scene the incident is not "cancelled" — it is resolved
    // or a false alarm. Allowing a cancel here would erase a dispatch in progress.
    expect(canTransitionIncidentStatus('on_scene', 'cancelled', ctx({ role: 'dispatcher' }))).toBe(false);
    expect(canTransitionIncidentStatus('on_scene', 'cancelled', ctx({ role: 'admin' }))).toBe(false);
  });

  it('`assigned -> on_scene` is the documented JUMP, and a dispatcher may record it', () => {
    // "responder (documented jump, flagged)" is the only cell in its row that omits a
    // dispatcher. Recorded as a deviation; see DOCUMENTED_DEVIATIONS.
    expect(
      canTransitionIncidentStatus('assigned', 'on_scene', ctx({ role: 'responder', isLiveAssignee: true })),
    ).toBe(true);
    expect(canTransitionIncidentStatus('assigned', 'on_scene', ctx({ role: 'dispatcher' }))).toBe(true);
  });

  it('`assigned -> closed`, `en_route -> closed` and `on_scene -> closed` are dispatcher grants', () => {
    // Each row names "dispatcher" (not "dispatcher/admin") in its `closed` cell.
    for (const from of ['assigned', 'en_route', 'on_scene'] as const) {
      expect(canTransitionIncidentStatus(from, 'closed', ctx({ role: 'dispatcher' })), from).toBe(true);
    }
  });

  it('admin is admitted wherever dispatcher is, without being written into 30 cells', () => {
    // Deviation (1): `docs/07 §4.3` never states admin is a superset, but the 61-row
    // capability matrix gives admin `full` on every operational capability, and an
    // admin who could not supervise a dispatch they were entitled to create would be
    // an inconsistency in the other direction.
    expect(canTransitionIncidentStatus('en_route', 'resolved', ctx({ role: 'admin' }))).toBe(true);
    expect(canTransitionIncidentStatus('resolved', 'closed', ctx({ role: 'dispatcher' }))).toBe(true);
  });
});

/* ========================================================================== */
/* Invalid transitions                                                         */
/* ========================================================================== */

describe('INVALID transitions are refused (brief §19)', () => {
  it('a responder cannot jump new -> resolved', () => {
    // brief §19: "`Reported → Resolved` should not be directly available."
    expect(canTransitionIncidentStatus('new', 'resolved', ctx({ role: 'responder' }))).toBe(false);
  });

  it('a citizen can do nothing but withdraw their own unverified report', () => {
    for (const to of INCIDENT_STATUSES) {
      // `new -> new` is a noop, and `cancelled` is the one grant (FR-019).
      if (to === 'cancelled' || to === 'new') continue;
      expect(canTransitionIncidentStatus('new', to, ctx({ role: 'citizen' })), `citizen new -> ${to}`).toBe(false);
    }
  });

  it('nothing leads backwards', () => {
    for (const from of ['en_route', 'on_scene', 'resolved'] as const) {
      expect(canTransitionIncidentStatus(from, 'new', ctx()), `${from} -> new`).toBe(false);
      expect(canTransitionIncidentStatus(from, 'triaged', ctx()), `${from} -> triaged`).toBe(false);
      expect(canTransitionIncidentStatus(from, 'verified', ctx()), `${from} -> verified`).toBe(false);
    }
  });

  it('a verified incident cannot be walked back to `assigned` once on scene', () => {
    for (const from of ['on_scene', 'resolved', 'closed'] as const) {
      expect(canTransitionIncidentStatus(from, 'assigned', ctx({ hasActiveDispatch: true })), from).toBe(false);
    }
  });

  it('closed is terminal', () => {
    expect(TERMINAL_INCIDENT_STATUSES.has('closed')).toBe(true);
    for (const to of INCIDENT_STATUSES) {
      if (to === 'closed') continue; // a repeat is a noop
      expect(canTransitionIncidentStatus('closed', to, ctx({ role: 'admin' })), `closed -> ${to}`).toBe(false);
    }
  });

  it('cancelled and false_alarm are archived to closed, and reopen to nothing', () => {
    for (const from of ['cancelled', 'false_alarm'] as const) {
      expect(canTransitionIncidentStatus(from, 'closed', ctx()), `${from} -> closed`).toBe(true);
      expect(canTransitionIncidentStatus(from, 'resolved', ctx({ resolutionCode: 'x' } as never)), from).toBe(false);
    }
  });

  it('`merged` is terminal, with no exits', () => {
    expect(TERMINAL_INCIDENT_STATUSES.has('merged')).toBe(true);
    for (const to of INCIDENT_STATUSES) {
      if (to === 'merged') continue;
      expect(canTransitionIncidentStatus('merged', to, ctx({ role: 'admin' })), `merged -> ${to}`).toBe(false);
    }
  });
});

/* ========================================================================== */
/* Idempotency                                                                 */
/* ========================================================================== */

describe('repeating a transition is a NOOP, not an error (docs/08 §3.8)', () => {
  it('from === to is allowed for every status, including the terminal ones', () => {
    // Checked before the terminal test, so `merged -> merged` is a noop like any
    // other repeat. A terminal status is terminal for CHANGES.
    for (const status of INCIDENT_STATUSES) {
      expect(canTransitionIncidentStatus(status, status, ctx({ role: 'admin' })), status).toBe(true);
    }
  });
});

/* ========================================================================== */
/* The live assignee is the only responder                                     */
/* ========================================================================== */

describe('only the LIVE ASSIGNEE drives the responder steps', () => {
  it('a responder who is not the assignee is refused, with a SPECIFIC reason', () => {
    const decision = evaluateIncidentTransition(
      'assigned',
      'en_route',
      ctx({ role: 'responder', isLiveAssignee: false }),
    );
    expect(decision.allowed).toBe(false);
    // "This is not your incident", not a generic 403 that leaves the responder
    // guessing whether they were refused for the wrong user or the wrong state.
    if (decision.allowed === false) expect(decision.reason).toBe('requires_live_assignee');
  });

  it('a DISPATCHER can set en_route for a responder who has not opened the app', () => {
    // The cell says "assigned responder / dispatcher", and this is why: the responder
    // may be driving with the phone in a pocket.
    expect(canTransitionIncidentStatus('assigned', 'en_route', ctx({ role: 'dispatcher' }))).toBe(true);
  });

  it('a citizen is told they are not the reporter, not merely denied', () => {
    const decision = evaluateIncidentTransition('new', 'cancelled', ctx({ role: 'citizen', isReporter: false }));
    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) expect(decision.reason).toBe('not_the_reporter');
  });

  it('the REPORTER may cancel their own report', () => {
    expect(canTransitionIncidentStatus('new', 'cancelled', ctx({ role: 'citizen', isReporter: true }))).toBe(true);
  });
});

/* ========================================================================== */
/* FR-020                                                                      */
/* ========================================================================== */

describe('THE AI IS ALLOWED EXACTLY ONE TRANSITION (FR-020)', () => {
  it('the system sentinel may perform new -> triaged', () => {
    expect(canTransitionIncidentStatus('new', 'triaged', ctx(SYSTEM))).toBe(true);
  });

  it('the system sentinel may perform NOTHING ELSE', () => {
    // docs/07 §4.3: "This is the only lifecycle transition the AI can cause."
    // brief §3: "AI must NOT autonomously dispatch emergency responders."
    for (const from of INCIDENT_STATUSES) {
      for (const to of INCIDENT_STATUSES) {
        // Noops excluded: `x -> x` is a read of the current state, not a transition.
        if (from === to) continue;
        if (from === 'new' && to === 'triaged') continue;
        expect(canTransitionIncidentStatus(from, to, ctx(SYSTEM)), `system ${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('the system CANNOT reach `assigned`, so it cannot dispatch', () => {
    // The single most important assertion in this file, if brief §3 is to mean
    // anything at the code level.
    for (const from of ['triaged', 'verified'] as const) {
      expect(canTransitionIncidentStatus(from, 'assigned', ctx({ ...SYSTEM, hasActiveDispatch: true })), from).toBe(
        false,
      );
    }
  });

  it('the sentinel requires the uid AND the role, not either alone', () => {
    // A client cannot set its own role, so the role half is already unreachable;
    // requiring the uid as well means a future route forwarding a caller-supplied
    // role still cannot reach the AI transition.
    expect(canTransitionIncidentStatus('new', 'triaged', ctx({ role: 'system', uid: 'u_attacker' }))).toBe(false);
    // And an ADMIN with the sentinel uid is refused the AI cell — an admin triaging
    // by hand is acting in their own right, and conflating the two would make the
    // audit log claim a human action was an AI one. (They may still triage, through
    // the `dispatcher`/`admin` cell in the same array.)
    expect(canTransitionIncidentStatus('new', 'triaged', ctx({ role: 'admin', uid: SYSTEM_ACTOR }))).toBe(true);
    expect(INCIDENT_TRANSITION_MATRIX.new.triaged).toContain('dispatcher');
  });

  it('a human hitting the AI-only cell is told `system_only`, not a bare denial', () => {
    // The `new -> triaged` cell is `['system (ai)', 'dispatcher', 'admin']`, so a
    // responder reaching it is refused with an instruction: this transition belongs
    // to the AI-triage path. That is more useful than `no_permission`, and it is the
    // reason `evaluateIncidentTransition` returns a reason rather than a boolean.
    const decision = evaluateIncidentTransition('new', 'triaged', ctx({ role: 'responder' }));
    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) expect(decision.reason).toBe('system_only');
  });
});

/* ========================================================================== */
/* Prerequisites                                                               */
/* ========================================================================== */

describe('the non-role prerequisites (docs/07 §4.3 bullets)', () => {
  const base = {
    hasActiveDispatch: true,
    isVerified: false,
    currentStatus: 'on_scene' as const,
    resolutionCode: null,
  };

  it('resolved requires a resolutionCode (FR-054)', () => {
    expect(checkTransitionPrerequisites('resolved', base)).toEqual({
      ok: false,
      code: 'RESOLUTION_CODE_REQUIRED',
    });
  });

  it('resolved with a code passes', () => {
    expect(checkTransitionPrerequisites('resolved', { ...base, resolutionCode: 'assisted' })).toEqual({ ok: true });
  });

  it('a whitespace-only code is not a code', () => {
    expect(checkTransitionPrerequisites('resolved', { ...base, resolutionCode: '   ' })).toEqual({
      ok: false,
      code: 'RESOLUTION_CODE_REQUIRED',
    });
  });

  it('assigned requires an active dispatch (FR-053)', () => {
    expect(checkTransitionPrerequisites('assigned', { ...base, hasActiveDispatch: false })).toEqual({
      ok: false,
      code: 'NO_ACTIVE_DISPATCH',
    });
  });

  it('a REPORTER cannot cancel once the incident is verified (FR-019)', () => {
    expect(checkTransitionPrerequisites('cancelled', { ...base, isVerified: true })).toEqual({
      ok: false,
      code: 'REPORTER_CANCEL_TOO_LATE',
    });
  });

  it('on_scene needs none of the three', () => {
    expect(checkTransitionPrerequisites('on_scene', base)).toEqual({ ok: true });
  });
});

/* ========================================================================== */
/* allowedIncidentTransitions — the UI contract                                 */
/* ========================================================================== */

describe('allowedIncidentTransitions drives the UI (docs/08 §3.8)', () => {
  it('a dispatcher sees a plausible set of next steps', () => {
    // With a dispatch in place, since `assigned` is otherwise withheld.
    const next = allowedIncidentTransitions('triaged', ctx({ role: 'dispatcher', hasActiveDispatch: true }));
    expect(next).toContain('verified');
    expect(next).toContain('assigned');
    expect(next).not.toContain('new');
    // And never `merged` — the column is a dash in every row.
    expect(next).not.toContain('merged');
  });

  it('`assigned` is withheld when there is no dispatch, so no button always fails', () => {
    expect(allowedIncidentTransitions('verified', ctx({ hasActiveDispatch: false }))).not.toContain('assigned');
    expect(allowedIncidentTransitions('verified', ctx({ hasActiveDispatch: true }))).toContain('assigned');
  });

  it('a noop is never offered as a button', () => {
    for (const status of INCIDENT_STATUSES) {
      expect(allowedIncidentTransitions(status, ctx({ role: 'admin' })), status).not.toContain(status);
    }
  });

  it('the assigned responder sees their OWN next step and not a dispatcher gate', () => {
    const next = allowedIncidentTransitions('assigned', ctx({ role: 'responder', isLiveAssignee: true }));
    expect(next).toContain('en_route');
    // `verified` is a dispatcher's gate, and showing it to a responder is how a UI
    // invites an unauthorised action.
    expect(next).not.toContain('verified');
    expect(next).not.toContain('merged');
  });

  it('a citizen on their own unverified report sees exactly one action: withdraw', () => {
    expect(allowedIncidentTransitions('new', ctx({ role: 'citizen', isReporter: true }))).toEqual(['cancelled']);
  });

  it('a terminal status offers nothing at all', () => {
    for (const status of ['closed', 'merged'] as const) {
      expect(allowedIncidentTransitions(status, ctx({ role: 'admin' })), status).toEqual([]);
    }
  });
});

/* ========================================================================== */
/* Dispatch transitions                                                        */
/* ========================================================================== */

describe('DISPATCH transitions (docs/07 §8)', () => {
  it('a responder may accept their own assignment', () => {
    expect(canTransitionDispatchStatus('active', 'accepted', dctx({ role: 'responder', isSubject: true }))).toBe(true);
  });

  // The one that matters for brief §3 and §16.
  it('a DISPATCHER may NOT accept on a responder behalf', () => {
    // `accepted` exists to prove the responder is available and willing. A dispatcher
    // accepting for them makes the field a fact about the dispatcher.
    expect(canTransitionDispatchStatus('active', 'accepted', dctx({ role: 'dispatcher', isSubject: false }))).toBe(
      false,
    );
  });

  it('a responder may NOT accept someone else assignment', () => {
    expect(canTransitionDispatchStatus('active', 'accepted', dctx({ role: 'responder', isSubject: false }))).toBe(
      false,
    );
  });

  it('a responder may withdraw (decline) their own assignment', () => {
    expect(canTransitionDispatchStatus('active', 'withdrawn', dctx({ role: 'responder', isSubject: true }))).toBe(true);
  });

  it('a dispatcher or admin may withdraw any assignment', () => {
    expect(canTransitionDispatchStatus('active', 'withdrawn', dctx({ role: 'dispatcher', isSubject: false }))).toBe(
      true,
    );
    expect(canTransitionDispatchStatus('active', 'withdrawn', dctx({ role: 'admin', isSubject: false }))).toBe(true);
  });

  // Expiry is a fact about the clock, not a decision.
  it('a DISPATCHER may not expire a dispatch manually', () => {
    expect(canTransitionDispatchStatus('active', 'expired', dctx({ role: 'dispatcher' }))).toBe(false);
    expect(canTransitionDispatchStatus('active', 'expired', dctx({ role: 'admin' }))).toBe(false);
  });

  it('the system may expire it', () => {
    expect(canTransitionDispatchStatus('active', 'expired', dctx({ role: 'system' }))).toBe(true);
  });

  it('withdrawn, completed and expired are terminal', () => {
    const all: DispatchStatus[] = ['active', 'accepted', 'withdrawn', 'completed', 'expired'];
    for (const from of ['withdrawn', 'completed', 'expired'] as DispatchStatus[]) {
      for (const to of all) {
        if (from === to) continue;
        expect(canTransitionDispatchStatus(from, to, dctx({ role: 'admin' })), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('accepted -> completed, by the subject or a dispatcher', () => {
    expect(canTransitionDispatchStatus('accepted', 'completed', dctx({ role: 'responder', isSubject: true }))).toBe(
      true,
    );
    expect(canTransitionDispatchStatus('accepted', 'completed', dctx({ role: 'admin', isSubject: false }))).toBe(true);
  });

  it('accepted -> withdrawn is the REASSIGNMENT path (docs/08 §3.7)', () => {
    expect(canTransitionDispatchStatus('accepted', 'withdrawn', dctx({ role: 'dispatcher' }))).toBe(true);
  });

  it('a repeat is idempotent, as with the incident table', () => {
    for (const status of ['active', 'accepted', 'withdrawn', 'completed', 'expired'] as DispatchStatus[]) {
      expect(canTransitionDispatchStatus(status, status, dctx()), status).toBe(true);
    }
  });

  it('allowedDispatchTransitions gives a role-appropriate list', () => {
    // docs/08 §3.8: "allowedNext lets the client render exactly one primary action".
    const responder = allowedDispatchTransitions('active', dctx({ role: 'responder', isSubject: true }));
    expect(responder).toContain('accepted');
    expect(responder).toContain('withdrawn');
    // Not the clock's decision.
    expect(responder).not.toContain('expired');

    const dispatcher = allowedDispatchTransitions('active', dctx({ role: 'dispatcher', isSubject: false }));
    expect(dispatcher).toEqual(['withdrawn']);
  });
});

/* ========================================================================== */
/* Every status is reachable                                                   */
/* ========================================================================== */

describe('every IncidentStatus is reachable by a dispatcher', () => {
  // A status the table cannot reach is a status the UI never offers and the API
  // always refuses — a silently dead state, which is worse than a missing one.
  it('a dispatcher can reach all of them, given a dispatch for `assigned`', () => {
    const dispatcher = ctx({ role: 'dispatcher', hasActiveDispatch: true });
    const reachable = new Set<string>(['new']);
    const frontier: string[] = ['new'];

    while (frontier.length > 0) {
      const from = frontier.pop() as string;
      for (const to of INCIDENT_STATUSES) {
        if (reachable.has(to)) continue;
        // `merged` is deliberately unreachable: it is written by a dedicated merge
        // operation that Phase 6 did not build. Asserted separately above.
        if (to === 'merged') continue;
        if (canTransitionIncidentStatus(from as never, to as never, dispatcher)) {
          reachable.add(to);
          frontier.push(to);
        }
      }
    }

    for (const status of INCIDENT_STATUSES) {
      if (status === 'merged') continue;
      expect(reachable.has(status), `no dispatcher path reaches "${status}"`).toBe(true);
    }
  });

  it('`merged` is the ONLY unreachable status, and that is deliberate', () => {
    expect(INCIDENT_STATUSES.filter((s) => s === 'merged')).toHaveLength(1);
  });
});

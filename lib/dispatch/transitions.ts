/**
 * ============================================================================
 * CareGrid AI — incident and dispatch lifecycle transitions
 * ============================================================================
 *
 * `docs/07 §4.3`, FR-050 / FR-051 / FR-052. **PURE.** No Firestore, no clock, no
 * randomness.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PURE MODULE AND NOT A SERVICE
 * ---------------------------------------------------------------------------
 * `docs/07 §4.3` names the location: "`lib/incidents/lifecycle.ts`". `lib/` is
 * correct because a transition table is **policy**, and policy is the one thing in
 * this system that must be testable without a database, a clock, or a network.
 *
 * A rule like "a responder may not move an incident from `on_scene` to `cancelled`"
 * has no business depending on whether Firestore was reachable when you tried to
 * enforce it. This module answers "is this allowed" and nothing else; the service
 * answers "perform it".
 *
 * ---------------------------------------------------------------------------
 * THE MATRIX IS TRANSCRIBED CELL BY CELL, NOT SUMMARISED
 * ---------------------------------------------------------------------------
 * `docs/07 §4.3` is a grid: one row per source status, one column per target, and
 * each cell names who may perform that transition. Every cell is written out below
 * including the empty ones, because **a dash in a cell means "nobody", which is
 * very different from "nobody I happened to think of".**
 *
 * `docs/07 §4.3`'s rows are transposed here relative to the document's
 * presentation — this is `byTarget[from][to]`, the document is `from -> to` — for
 * the same reason: the runtime question is "can this actor go from A to B".
 *
 * **The transcription was verified cell-by-cell against the source**, because the
 * first attempt at it was wrong in four places. `docs/07 §4.3` is a markdown table
 * whose first cell is a label, so a naive `split('|')` shifts every column by one
 * and produces a table that looks plausible and is wrong. The corrections are
 * listed in docs/30.8 §2.1.
 *
 * ---------------------------------------------------------------------------
 * THREE DOC-TO-CODE RECONCILIATIONS, EACH LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 * (1) `admin` IS A DISPATCHER FOR THIS TABLE, WITHOUT BEING WRITTEN INTO 30 CELLS.
 *     `docs/07 §4.3` writes "`dispatcher`" in the responder-driven rows and
 *     "`dispatcher/admin`" in the structural ones, with no statement that admin
 *     is a superset. But `lib/auth/permissions.ts`'s 61-row matrix gives `admin`
 *     `full` on every operational capability including `r29_assignResponder`, and
 *     an admin who cannot mark an incident `on_scene` could not supervise a
 *     dispatch they were themselves entitled to create. So `cellRoles()` expands a
 *     `dispatcher` cell to include `admin`, in ONE place, so the expansion is
 *     auditable rather than sprinkled through the grid.
 *
 * (2) `assigned -> on_scene` ALSO ADMITS A DISPATCHER.
 *     The document's cell reads "responder (documented jump, flagged)" — the only
 *     cell in the `assigned` row that does not also name a dispatcher, while its
 *     neighbours `en_route` ("assigned responder / dispatcher") and `resolved`
 *     ("responder / dispatcher") both do. Read literally, a dispatcher could take an
 *     incident straight from `assigned` to `resolved` while being forbidden from
 *     recording the `on_scene` step in between. That is a contradiction, not a
 *     policy, so the dispatcher is admitted. Recorded in
 *     `DOCUMENTED_DEVIATIONS` so the deviation is asserted by a test rather than
 *     being invisible.
 *
 * (3) THE WHOLE `merged` COLUMN IS DENIED, SO `merged` IS UNREACHABLE HERE.
 *     `docs/07 §4.3` puts a dash in `merged` in every one of the eleven rows. The
 *     status is real — `types/enums.ts` has it and `docs/07 §4` has
 *     `mergedIntoId` / `mergedBy` / `mergedAt` — but it is written by a dedicated
 *     merge operation, not by a lifecycle transition. Phase 6 built the duplicate
 *     *detection* and deliberately did not build the merge (FR-048: two incidents
 *     500 m apart are never auto-merged). So `allowedIncidentTransitions` never
 *     offers a `merged` button, because `PATCH /api/incidents/:id/status` would
 *     refuse it.
 */

import type { IncidentStatus, UserRole } from '@/types';

/* ========================================================================== */
/* Who the actor is, beyond their role                                          */
/* ========================================================================== */

/**
 * The actor's role, widened to include the `system` sentinel.
 *
 * `USER_ROLES` is the four HUMAN roles — a role a person can hold. `docs/07 §4.3`
 * additionally requires `actorUid = "system"` / `actorRole = "system"` for the
 * AI-triage transition, and `docs/07 §8` uses the same sentinel for the expiry
 * sweep. Those are not roles anyone can be assigned, so widening the union here is
 * the honest model: a `UserRole` is a subset, and a `TransitionRole` is "a human
 * role, or the system acting on its own authority".
 */
export type TransitionRole = UserRole | 'system';

/** The sentinel identity `docs/07 §4.3` and `docs/07 §8` both use. */
export const SYSTEM_ACTOR = 'system' as const;

/**
 * The context a transition is evaluated in.
 *
 * **Every field here is server-derived.** `docs/24` and brief §36 both forbid
 * trusting a client-supplied role, uid or ownership, so this object is only ever
 * constructed from a verified ID token and a server-side read.
 */
export type TransitionContext = {
  readonly role: TransitionRole;
  readonly uid: string;
  /**
   * Is this actor the incident's reporter?
   *
   * A boolean rather than a uid, because the comparison has already happened by the
   * time this is set — and a boolean cannot be wrong in the direction that matters.
   */
  readonly isReporter: boolean;
  /**
   * Is this actor the responder of the LIVE dispatch?
   *
   * The same reasoning. `docs/07 §4.3` grants `en_route` / `on_scene` to
   * "assigned responder / dispatcher", so the table needs the answer, not the uid.
   */
  readonly isLiveAssignee: boolean;
  /** `true` when a live dispatch exists at all. Gates the `assigned` target. */
  readonly hasActiveDispatch: boolean;
};

/* ========================================================================== */
/* The matrix                                                                  */
/* ========================================================================== */

/**
 * A matrix cell: a role, or a qualifier the table resolves at match time.
 *
 * | Cell | Meaning |
 * | --- | --- |
 * | `dispatcher` | a dispatcher, and — see the file header — an admin |
 * | `admin` | an admin only |
 * | `system (ai)` | the AI-triage path, and nothing else |
 * | `assigned responder` | the responder of the LIVE dispatch |
 * | `reporter` | the incident's reporter |
 */
type Cell = 'dispatcher' | 'admin' | 'system (ai)' | 'assigned responder' | 'reporter';

/** A documented dash. Named, so a dash is visible in the source as a dash. */
const NOBODY: readonly Cell[] = [];

/** `docs/07 §4.3`, row `new`. FR-019's reporter cancellation is the only citizen grant. */
const FROM_NEW: Record<IncidentStatus, readonly Cell[]> = {
  new: NOBODY,
  // `docs/07 §4.3`: "This is the only lifecycle transition the AI can cause
  // (FR-020)" — and it "never happens on the AI-failure path".
  triaged: ['system (ai)', 'dispatcher', 'admin'],
  verified: ['dispatcher', 'admin'],
  assigned: NOBODY,
  en_route: NOBODY,
  on_scene: NOBODY,
  resolved: NOBODY,
  closed: NOBODY,
  // "reporter (pre-verify) / dispatcher" — the pre-verify restriction is FR-019 and
  // is enforced by `checkTransitionPrerequisites`, not here.
  cancelled: ['reporter', 'dispatcher'],
  // Dispatcher only. A citizen may NOT declare their own report a false alarm; the
  // cell says "dispatcher" and a citizen self-cancelling as a false alarm would
  // erase a report that may have been real.
  false_alarm: ['dispatcher'],
  merged: NOBODY,
};

/** `docs/07 §4.3`, row `triaged`. */
const FROM_TRIAGED: Record<IncidentStatus, readonly Cell[]> = {
  new: NOBODY,
  triaged: NOBODY,
  verified: ['dispatcher', 'admin'],
  assigned: ['dispatcher', 'admin'],
  en_route: NOBODY,
  on_scene: NOBODY,
  resolved: NOBODY,
  closed: ['dispatcher', 'admin'],
  cancelled: ['dispatcher'],
  false_alarm: ['dispatcher'],
  merged: NOBODY,
};

/** `docs/07 §4.3`, row `verified`. Note `verified -> assigned` IS permitted. */
const FROM_VERIFIED: Record<IncidentStatus, readonly Cell[]> = {
  new: NOBODY,
  triaged: NOBODY,
  verified: NOBODY,
  assigned: ['dispatcher', 'admin'],
  en_route: NOBODY,
  on_scene: NOBODY,
  resolved: NOBODY,
  closed: ['dispatcher', 'admin'],
  cancelled: ['dispatcher'],
  false_alarm: ['dispatcher'],
  merged: NOBODY,
};

/**
 * `docs/07 §4.3`, row `assigned` — THE ROW THAT MAKES THE LIFECYCLE WORK.
 *
 * It is the only row where `assigned responder` appears. A responder who is not the
 * live assignee matches no cell anywhere in the grid, which is brief §20's "cannot
 * access unauthorized incidents" expressed as data rather than as an `if`.
 */
const FROM_ASSIGNED: Record<IncidentStatus, readonly Cell[]> = {
  new: NOBODY,
  triaged: NOBODY,
  verified: NOBODY,
  assigned: NOBODY,
  en_route: ['assigned responder', 'dispatcher'],
  // "responder (documented jump, flagged)" — deviation (2) in the file header adds
  // the dispatcher. The JUMP is what the flag reports: the service records that
  // `en_route` was skipped rather than refusing the transition, because a responder
  // who arrives without opening the app has told us something real and refusing it
  // would make them leave the app and phone instead.
  on_scene: ['assigned responder', 'dispatcher'],
  resolved: ['assigned responder', 'dispatcher'],
  closed: ['dispatcher'],
  cancelled: ['dispatcher'],
  false_alarm: ['dispatcher'],
  merged: NOBODY,
};

/** `docs/07 §4.3`, row `en_route`. */
const FROM_EN_ROUTE: Record<IncidentStatus, readonly Cell[]> = {
  new: NOBODY,
  triaged: NOBODY,
  verified: NOBODY,
  assigned: NOBODY,
  en_route: NOBODY,
  on_scene: ['assigned responder', 'dispatcher'],
  resolved: ['assigned responder', 'dispatcher'],
  closed: ['dispatcher'],
  cancelled: ['dispatcher'],
  false_alarm: ['dispatcher'],
  merged: NOBODY,
};

/**
 * `docs/07 §4.3`, row `on_scene`.
 *
 * `on_scene -> cancelled` is a documented dash: once a responder is on scene the
 * incident is not "cancelled", it is `resolved` or `false_alarm`. Allowing a cancel
 * here would let a dispatch in progress be erased rather than closed out.
 */
const FROM_ON_SCENE: Record<IncidentStatus, readonly Cell[]> = {
  new: NOBODY,
  triaged: NOBODY,
  verified: NOBODY,
  assigned: NOBODY,
  en_route: NOBODY,
  on_scene: NOBODY,
  // FR-054 additionally requires a `resolutionCode`; see
  // `checkTransitionPrerequisites`, because it depends on a field, not a role.
  resolved: ['assigned responder', 'dispatcher'],
  closed: ['dispatcher'],
  cancelled: NOBODY,
  false_alarm: ['dispatcher'],
  merged: NOBODY,
};

/** `docs/07 §4.3`, row `resolved`. */
const FROM_RESOLVED: Record<IncidentStatus, readonly Cell[]> = {
  new: NOBODY,
  triaged: NOBODY,
  verified: NOBODY,
  assigned: NOBODY,
  en_route: NOBODY,
  on_scene: NOBODY,
  resolved: NOBODY,
  closed: ['dispatcher', 'admin'],
  cancelled: NOBODY,
  false_alarm: NOBODY,
  merged: NOBODY,
};

/** Terminal: eleven documented dashes. */
const TERMINAL_ROW: Record<IncidentStatus, readonly Cell[]> = {
  new: NOBODY,
  triaged: NOBODY,
  verified: NOBODY,
  assigned: NOBODY,
  en_route: NOBODY,
  on_scene: NOBODY,
  resolved: NOBODY,
  closed: NOBODY,
  cancelled: NOBODY,
  false_alarm: NOBODY,
  merged: NOBODY,
};

/** `cancelled` and `false_alarm` are archived to `closed`, not reopened. */
const FROM_CANCELLED: Record<IncidentStatus, readonly Cell[]> = { ...TERMINAL_ROW, closed: ['dispatcher', 'admin'] };
const FROM_FALSE_ALARM: Record<IncidentStatus, readonly Cell[]> = { ...TERMINAL_ROW, closed: ['dispatcher', 'admin'] };

/** The complete matrix, keyed by source. Every cell present, including the dashes. */
const TRANSITION_MATRIX: Readonly<Record<IncidentStatus, Record<IncidentStatus, readonly Cell[]>>> = {
  new: FROM_NEW,
  triaged: FROM_TRIAGED,
  verified: FROM_VERIFIED,
  assigned: FROM_ASSIGNED,
  en_route: FROM_EN_ROUTE,
  on_scene: FROM_ON_SCENE,
  resolved: FROM_RESOLVED,
  closed: TERMINAL_ROW,
  cancelled: FROM_CANCELLED,
  false_alarm: FROM_FALSE_ALARM,
  merged: TERMINAL_ROW,
};

/**
 * The matrix, exposed for the transition tests and for a future admin screen that
 * would render the policy rather than infer it.
 *
 * **Deeply frozen at runtime.** A `Readonly<Record>` stops reassignment of the
 * top-level keys only; the inner rows would still be mutable, and a permission
 * lookup table that can be mutated at runtime is a lookup table that will be — by a
 * bug, or by someone debugging a permission problem in production.
 */
export const INCIDENT_TRANSITION_MATRIX: Readonly<
  Record<IncidentStatus, Readonly<Record<IncidentStatus, readonly Cell[]>>>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(TRANSITION_MATRIX).map(([from, row]) => [from, Object.freeze({ ...row })]),
  ) as Record<IncidentStatus, Readonly<Record<IncidentStatus, readonly Cell[]>>>,
);

/**
 * Where this module's answer to `docs/07 §4.3` is not a literal reading of it.
 *
 * Exported so a test can assert that each deviation still exists and is still the
 * one described here. A deviation that is not asserted is a deviation that will
 * quietly become the documented behaviour.
 */
export const DOCUMENTED_DEVIATIONS: readonly {
  readonly from: IncidentStatus;
  readonly to: IncidentStatus;
  readonly docSays: string;
  readonly implementedAs: string;
  readonly why: string;
}[] = [
  {
    from: 'assigned',
    to: 'on_scene',
    docSays: 'responder (documented jump, flagged)',
    implementedAs: 'assigned responder / dispatcher',
    why:
      'The only cell in the `assigned` row that does not name a dispatcher, while its ' +
      'neighbours `en_route` and `resolved` both do. Read literally a dispatcher could ' +
      'go `assigned -> resolved` while being forbidden from recording `on_scene`, which ' +
      'is a contradiction rather than a policy.',
  },
];

/* ========================================================================== */
/* Cell expansion — deviation (1)                                               */
/* ========================================================================== */

/**
 * The roles a `dispatcher` cell admits.
 *
 * This is the whole of deviation (1), and it is one function on purpose: 30 cells
 * would otherwise each need a hand-written `'admin'`, and the next person to add a
 * transition would forget.
 */
function cellGrantsDispatcherRole(context: TransitionContext): boolean {
  return context.role === 'dispatcher' || context.role === 'admin';
}

/** The statuses from which nothing further may happen. */
export const TERMINAL_INCIDENT_STATUSES: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>([
  'closed',
  'merged',
]);

/* ========================================================================== */
/* The single transition decision                                               */
/* ========================================================================== */

/** Why a transition was refused. Machine-readable for the API's error detail. */
export type TransitionRefusal =
  | 'same_status'
  | 'terminal_status'
  | 'not_in_transition_table'
  | 'requires_active_dispatch'
  | 'requires_live_assignee'
  | 'not_the_reporter'
  | 'system_only'
  | 'no_permission';

export type TransitionDecision =
  | { readonly allowed: true; readonly requiresDispatch: boolean }
  | { readonly allowed: false; readonly reason: TransitionRefusal };

/**
 * The one place a lifecycle transition is decided. `docs/07 §4.3`, brief §19.
 *
 * Returns a decision rather than a boolean, because three of the refusals carry an
 * instruction the caller must act on:
 *
 * - `requires_active_dispatch` — the incident cannot be `assigned` without one
 * - `requires_live_assignee` — the actor is not the assigned responder
 * - `system_only` — only the AI-triage path may do this, and the caller is not it
 *
 * A bare `false` would lose all three, and a caller that ignored them would produce
 * an `assigned` incident with no dispatch — the exact inconsistency FR-053 exists to
 * prevent.
 */
export function evaluateIncidentTransition(
  from: IncidentStatus,
  to: IncidentStatus,
  context: TransitionContext,
): TransitionDecision {
  /* --- 1. idempotency ------------------------------------------------- */
  // `docs/08 §3.8`: "Repeating the same transition returns `200` with
  // `meta.noop: true`". So a repeat is ALLOWED, and distinguished by the caller
  // from a real change. Treating it as an error would make a retry after a dropped
  // response look like a failure of the second request.
  //
  // This is checked BEFORE the terminal check, so `merged -> merged` is a noop like
  // every other repeat. A terminal status is terminal for *changes*, not for reads
  // of itself.
  if (from === to) return { allowed: true, requiresDispatch: false };

  /* --- 2. a terminal state has no exits ------------------------------- */
  if (TERMINAL_INCIDENT_STATUSES.has(from)) {
    return { allowed: false, reason: 'terminal_status' };
  }

  /* --- 3. find the permission set ------------------------------------- */
  const row = INCIDENT_TRANSITION_MATRIX[from];
  // A status absent from the matrix is a status the table has never heard of, which
  // is a programming error rather than a permission decision — so it is a refusal,
  // not a fall-through to a default.
  if (row === undefined) return { allowed: false, reason: 'not_in_transition_table' };

  const permissions = row[to];
  if (permissions === undefined || permissions.length === 0) {
    return { allowed: false, reason: 'not_in_transition_table' };
  }

  /* --- 4. match the actor --------------------------------------------- */
  let sawAssigneeCell = false;
  let sawReporterCell = false;
  let sawSystemCell = false;

  for (const cell of permissions) {
    if (cell === 'system (ai)') {
      sawSystemCell = true;
      // The AI-triage path, identified by BOTH the sentinel uid and the sentinel
      // role. A client cannot set its own role, so it cannot reach this branch;
      // requiring the uid as well means a future route forwarding a caller-supplied
      // role still cannot reach it. `admin` is NOT accepted here: an admin triaging
      // by hand is acting in their own right, through the `dispatcher`/`admin` cell
      // in the same array, and conflating the two would make the audit log claim a
      // human action was an AI one.
      if (context.uid === SYSTEM_ACTOR && context.role === 'system') {
        return { allowed: true, requiresDispatch: false };
      }
      continue;
    }
    if (cell === 'assigned responder') {
      sawAssigneeCell = true;
      // The live assignee, and only the live assignee. A responder who is not the
      // subject of the current dispatch matches no cell in the grid.
      if (context.isLiveAssignee) return { allowed: true, requiresDispatch: false };
      continue;
    }
    if (cell === 'reporter') {
      sawReporterCell = true;
      if (context.isReporter) return { allowed: true, requiresDispatch: false };
      continue;
    }
    if (cell === 'dispatcher') {
      if (cellGrantsDispatcherRole(context)) return { allowed: true, requiresDispatch: false };
      continue;
    }
    if (cell === 'admin') {
      if (context.role === 'admin') return { allowed: true, requiresDispatch: false };
      continue;
    }
  }

  /* --- 5. the SPECIFIC reason, so the caller can act ------------------- */
  // Order matters. Each of these is a different instruction, and a generic
  // `no_permission` would leave the responder guessing whether they were refused
  // for being the wrong user or for the wrong state.
  if (sawAssigneeCell) return { allowed: false, reason: 'requires_live_assignee' };
  if (sawReporterCell) return { allowed: false, reason: 'not_the_reporter' };
  if (sawSystemCell) return { allowed: false, reason: 'system_only' };
  return { allowed: false, reason: 'no_permission' };
}

/** The boolean form, for a caller that only needs yes/no. */
export function canTransitionIncidentStatus(
  from: IncidentStatus,
  to: IncidentStatus,
  context: TransitionContext,
): boolean {
  return evaluateIncidentTransition(from, to, context).allowed;
}

/* ========================================================================== */
/* The non-role prerequisites                                                  */
/* ========================================================================== */

/**
 * The conditions `docs/07 §4.3` states separately from the matrix, because they
 * depend on state this module deliberately does not read.
 *
 * Passing them in keeps this module pure, and the alternative — reading the
 * incident document here — would make the transition table untestable without
 * Firestore, which is the whole reason it lives in `lib/`.
 */
export type TransitionPrerequisites = {
  /** `true` when a dispatch with `status` `active` or `accepted` exists. */
  readonly hasActiveDispatch: boolean;
  /** `true` when the incident's `verifiedAt` is set. Gates reporter cancellation. */
  readonly isVerified: boolean;
  /** The incident's current `status`. */
  readonly currentStatus: IncidentStatus;
  /** Present for `resolved`. FR-054: `resolved` requires a `resolutionCode`. */
  readonly resolutionCode: string | null;
};

/** A prerequisite failure, with the HTTP-shaped code the route should return. */
export type PrerequisiteFailure =
  | 'RESOLUTION_CODE_REQUIRED'
  | 'REPORTER_CANCEL_TOO_LATE'
  | 'NO_ACTIVE_DISPATCH';

export type PrerequisiteResult = { readonly ok: true } | { readonly ok: false; readonly code: PrerequisiteFailure };

/**
 * The non-role prerequisites. `docs/07 §4.3`'s bullets, in intent.
 *
 * | Rule | Why here and not in the table |
 * | --- | --- |
 * | `resolved` requires `resolutionCode` (FR-054) | Depends on a field, not a role. |
 * | reporter `cancelled` rejected once `verifiedAt` is set (FR-019) | Depends on a timestamp, not a role — which is why `cancelled`'s `reporter` cell exists only in the `new` row. |
 * | `assigned` requires an `active` dispatch (FR-053) | Depends on another collection. |
 */
export function checkTransitionPrerequisites(
  to: IncidentStatus,
  prerequisites: TransitionPrerequisites,
): PrerequisiteResult {
  if (to === 'resolved' && prerequisites.currentStatus !== 'resolved') {
    if (prerequisites.resolutionCode === null || prerequisites.resolutionCode.trim().length === 0) {
      return { ok: false, code: 'RESOLUTION_CODE_REQUIRED' };
    }
  }
  if (to === 'assigned' && !prerequisites.hasActiveDispatch) {
    return { ok: false, code: 'NO_ACTIVE_DISPATCH' };
  }
  // FR-019. The reporter may withdraw their own report only before it is verified;
  // after verification the report is an operational record and only a dispatcher may
  // close it. A dispatcher cancelling is unaffected — this branch is gated on the
  // actor being the reporter, which the caller has already established.
  if (to === 'cancelled' && prerequisites.isVerified) {
    return { ok: false, code: 'REPORTER_CANCEL_TOO_LATE' };
  }
  return { ok: true };
}

/* ========================================================================== */
/* The dispatch transition table                                                */
/* ========================================================================== */

/** `active | accepted | withdrawn | completed | expired`. `docs/07 §8`. */
export type DispatchStatus = 'active' | 'accepted' | 'withdrawn' | 'completed' | 'expired';

export type DispatchTransitionContext = {
  readonly role: TransitionRole;
  /** Is this actor the dispatched responder? */
  readonly isSubject: boolean;
  /** `true` when `nowMs` is past the dispatch's `expiresAt`. */
  readonly isExpired: boolean;
};

/**
 * The reachable targets, before the role check.
 *
 * `docs/07 §8` gives the field list but no matrix, so this is derived from the three
 * rules that ARE stated — `expiresAt` with a sweep, `withdrawnReason`, and
 * `completedAt` — and the reasoning is recorded per transition in
 * `canTransitionDispatchStatus`.
 */
const DISPATCH_TRANSITIONS: Readonly<Record<DispatchStatus, readonly DispatchStatus[]>> = {
  // brief §17 proposes `assigned|accepted|rejected|en_route|on_scene|completed|
  // cancelled`. `docs/07 §8` specifies `active|accepted|withdrawn|completed|
  // expired` and Phase 3 already implemented it, so the documented set stands. The
  // mapping from the brief's names onto these is in docs/30.8 §2.
  active: ['accepted', 'withdrawn', 'expired'],
  accepted: ['completed', 'withdrawn'],
  withdrawn: [],
  completed: [],
  expired: [],
};

/**
 * Can this dispatch move to that status? brief §19's `canTransitionDispatchStatus`.
 *
 * | From → To | Who | Why |
 * | --- | --- | --- |
 * | `active → accepted` | the subject responder only | A responder accepting their own assignment. A dispatcher may NOT accept on a responder's behalf — that would make `accepted` a fact about the dispatcher rather than about the responder, and it exists to prove the responder is available. |
 * | `active → withdrawn` | dispatcher/admin, or the subject | The dispatcher cancelling (brief §33), or the responder declining (brief §16). |
 * | `active → expired` | **system only** | An unaccepted assignment times out. It is a fact about the clock, not a decision, so a human must not be able to make it. |
 * | `accepted → completed` | the subject, or a dispatcher | The incident is resolved (brief §34). |
 * | `accepted → withdrawn` | dispatcher/admin, or the subject | Reassignment. `docs/08 §3.7`: the previous dispatch is closed as `withdrawn` with reason `"reassigned"`. |
 *
 * **`expired` is a real transition, not an error.** `docs/07 §8` has an `expiresAt`
 * and a sweep, so a dispatch nobody accepted is *withdrawn by the clock*. The
 * consequence is that `active` is not a stable state, which is why the assignment
 * transaction must re-read the responder's state inside its transaction rather than
 * trust the client's view of it.
 */
export function canTransitionDispatchStatus(
  from: DispatchStatus,
  to: DispatchStatus,
  context: DispatchTransitionContext,
): boolean {
  if (from === to) return true; // idempotent, as with the incident table
  if (!DISPATCH_TRANSITIONS[from].includes(to)) return false;

  const isDispatcher = context.role === 'dispatcher' || context.role === 'admin';
  const isSubjectResponder = context.isSubject && context.role === 'responder';

  switch (to) {
    case 'accepted':
      return isSubjectResponder;

    case 'withdrawn':
      // `isExpired` is deliberately not consulted: an already-expired dispatch is
      // handled by the `expired` transition, and letting a dispatcher withdraw an
      // expired one would rewrite the reason a responder never picked it up.
      return isDispatcher || isSubjectResponder;

    case 'expired':
      // The clock, not a person.
      return context.role === 'system';

    case 'completed':
      return isSubjectResponder || isDispatcher;

    default:
      return false;
  }
}

/** The reachable targets from a state, for a UI that renders one primary action. */
export function allowedDispatchTransitions(
  from: DispatchStatus,
  context: DispatchTransitionContext,
): DispatchStatus[] {
  return DISPATCH_TRANSITIONS[from].filter((to) => canTransitionDispatchStatus(from, to, context));
}

/**
 * `docs/08 §3.8`: "`allowedNext` lets the client render exactly one primary action
 * without duplicating the transition table (US-012)."
 *
 * A LIST rather than a single value, because the answer genuinely differs by role: a
 * dispatcher sees `withdrawn`, a responder sees `accepted`. The client picks the
 * primary by its own role, which it already knows.
 */
export function allowedIncidentTransitions(
  from: IncidentStatus,
  context: TransitionContext,
): IncidentStatus[] {
  // Every status except `from` itself, since a noop is never a button.
  const targets = Object.keys(INCIDENT_TRANSITION_MATRIX[from] ?? {}).filter(
    (status): status is IncidentStatus => status !== from,
  );

  return targets.filter((to) => {
    if (!canTransitionIncidentStatus(from, to, context)) return false;
    // `assigned` needs a dispatch, and this module does not read Firestore. A client
    // rendering the button and finding out at submit time is a worse experience than
    // the button not appearing, so it is withheld here and enforced again by the
    // route.
    if (to === 'assigned' && !context.hasActiveDispatch) return false;
    return true;
  });
}

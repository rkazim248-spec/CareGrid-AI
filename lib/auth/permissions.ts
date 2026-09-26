/**
 * ============================================================================
 * CareGrid AI — the permission matrix, as data
 * ============================================================================
 *
 * A machine-readable transcription of the 61-row matrix in docs/22 §3. Row
 * numbers are preserved as the keys so a test failure, an audit entry, and a
 * documentation review can all point at the same row.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MATRIX LIVES HERE AND NOT IN THE ROLE CONFIG
 * ---------------------------------------------------------------------------
 * Because a role is four values and a capability set is 61 decisions. Putting
 * the decisions in `config/roles.ts` next to the icons and the landing routes
 * produces a file where a typo silently grants an admin-only capability, and
 * nothing in the type system notices. Here, every capability is a named key of
 * one record, the levels are a closed enum, and `tests/unit/permissions.test.ts`
 * asserts the shape of all 61.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR LEVELS (docs/22 §3 header)
 * ---------------------------------------------------------------------------
 * | `full`     | ● | no conditions |
 * | `scoped`    | ◐ | allowed, but narrowed by an ownership or state rule evaluated SERVER-side |
 * | `readonly`  | ○ | the data is visible with fields removed; the action is not available |
 * | `denied`    | — | not available, for any input |
 *
 * `scoped` is the one that gets misread. It is NOT "allowed". `can()` returns
 * `true` for it, because the action IS available to this role — but only on
 * resources the server will also allow, and the server is what decides. The
 * client never evaluates the scope; it cannot, because it does not have the
 * document.
 *
 * ---------------------------------------------------------------------------
 * THE TWO HARD DENIALS
 * ---------------------------------------------------------------------------
 * Row 59 (delete an audit entry) and row 61 (change your own role) are `denied`
 * for EVERY role, admin included. `hardDenials` below is a separate frozen set
 * rather than a comment, because these two rows are the ones that get removed
 * during a deadline — "we need to fix the stuck admin account" — and a comment
 * does not fail a test while a set does.
 */

import type { UserRole } from '@/types/enums';

export type PermissionLevel = 'full' | 'scoped' | 'readonly' | 'denied';

/** The matrix row key, prefixed with its docs/22 §3 row number. */
export type CapabilityKey =
  | 'r01_createIncident'
  | 'r02_addSupplement'
  | 'r03_cancelOwnIncident'
  | 'r04_cancelAnyIncident'
  | 'r05_readOwnIncidents'
  | 'r06_readAssignedIncidents'
  | 'r07_readUnassignedInRadius'
  | 'r08_readAllIncidents'
  | 'r09_readOriginalText'
  | 'r10_readReporterIdentity'
  | 'r11_readLocationText'
  | 'r12_readArchivedIncidents'
  | 'r13_readAiTriagePanel'
  | 'r14_verify'
  | 'r15_markFalseAlarm'
  | 'r16_setEnRoute'
  | 'r17_setOnScene'
  | 'r18_setResolved'
  | 'r19_setClosed'
  | 'r20_forceStatusOverride'
  | 'r21_editSummaryUrgencyCategory'
  | 'r22_editLocation'
  | 'r23_editAiInfluencedFields'
  | 'r24_seeDuplicateSuggestions'
  | 'r25_confirmMerge'
  | 'r26_undoMerge'
  | 'r27_dismissDuplicate'
  | 'r28_seeCandidateResponders'
  | 'r29_assignResponder'
  | 'r30_unassignWithdraw'
  | 'r31_claimOpenDispatch'
  | 'r32_readAllDispatches'
  | 'r33_readOwnResponderProfile'
  | 'r34_setOwnAvailability'
  | 'r35_readResponderDirectory'
  | 'r36_readResponderPhone'
  | 'r37_editAnyResponderProfile'
  | 'r38_verifyRejectResponder'
  | 'r39_seeResponderStats'
  | 'r40_submitOwnLocation'
  | 'r41_writeOwnResponderLocation'
  | 'r42_writeOtherResponderLocation'
  | 'r43_readResponderLiveLocations'
  | 'r44_readLiveMap'
  | 'r45_readOwnNotifications'
  | 'r46_markOwnNotificationsRead'
  | 'r47_sendNotificationToOther'
  | 'r48_readOperationalAnalytics'
  | 'r49_readRiskZones'
  | 'r50_recomputeAnalytics'
  | 'r51_exportCsv'
  | 'r52_listUsers'
  | 'r53_changeUserRole'
  | 'r54_enableSuspendAccount'
  | 'r55_readAuditLog'
  | 'r56_readWriteConfig'
  | 'r57_runMaintenanceJobs'
  | 'r58_softDeleteRestoreIncident'
  | 'r59_deleteAuditEntry'
  | 'r60_createOrPromoteDispatcher'
  | 'r61_changeOwnRole';

type Row = Record<UserRole, PermissionLevel>;

/**
 * The 61 rows. A transcription, not an interpretation.
 *
 * Read the `readonly` entries carefully: `r09_readOriginalText` for a responder
 * is `◐ summary only` in the docs, encoded here as `scoped` because the summary
 * IS readable — the server removes `originalText` at serialisation time (layer
 * 3, docs/22 §6), which is the mechanism the `readonly` level exists to
 * describe.
 */
export const PERMISSION_MATRIX: Readonly<Record<CapabilityKey, Row>> = {
  /* --- Reporting ---------------------------------------------------------- */
  r01_createIncident: { citizen: 'full', responder: 'full', dispatcher: 'full', admin: 'full' },
  r02_addSupplement: { citizen: 'full', responder: 'full', dispatcher: 'full', admin: 'full' },
  r03_cancelOwnIncident: { citizen: 'full', responder: 'full', dispatcher: 'denied', admin: 'denied' },
  r04_cancelAnyIncident: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },

  /* --- Incident reading --------------------------------------------------- */
  r05_readOwnIncidents: { citizen: 'full', responder: 'full', dispatcher: 'full', admin: 'full' },
  r06_readAssignedIncidents: { citizen: 'full', responder: 'full', dispatcher: 'full', admin: 'full' },
  r07_readUnassignedInRadius: { citizen: 'denied', responder: 'scoped', dispatcher: 'full', admin: 'full' },
  r08_readAllIncidents: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r09_readOriginalText: { citizen: 'full', responder: 'scoped', dispatcher: 'full', admin: 'full' },
  r10_readReporterIdentity: { citizen: 'full', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r11_readLocationText: { citizen: 'full', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r12_readArchivedIncidents: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r13_readAiTriagePanel: { citizen: 'denied', responder: 'readonly', dispatcher: 'full', admin: 'full' },

  /* --- Lifecycle ---------------------------------------------------------- */
  r14_verify: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r15_markFalseAlarm: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r16_setEnRoute: { citizen: 'denied', responder: 'scoped', dispatcher: 'full', admin: 'full' },
  r17_setOnScene: { citizen: 'denied', responder: 'scoped', dispatcher: 'full', admin: 'full' },
  r18_setResolved: { citizen: 'denied', responder: 'scoped', dispatcher: 'full', admin: 'full' },
  r19_setClosed: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r20_forceStatusOverride: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },

  /* --- Editing ------------------------------------------------------------ */
  r21_editSummaryUrgencyCategory: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r22_editLocation: { citizen: 'full', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r23_editAiInfluencedFields: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },

  /* --- Duplicates --------------------------------------------------------- */
  r24_seeDuplicateSuggestions: { citizen: 'scoped', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r25_confirmMerge: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r26_undoMerge: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r27_dismissDuplicate: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },

  /* --- Dispatch ----------------------------------------------------------- */
  r28_seeCandidateResponders: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r29_assignResponder: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r30_unassignWithdraw: { citizen: 'denied', responder: 'scoped', dispatcher: 'full', admin: 'full' },
  r31_claimOpenDispatch: { citizen: 'scoped', responder: 'full', dispatcher: 'full', admin: 'full' },
  r32_readAllDispatches: { citizen: 'denied', responder: 'scoped', dispatcher: 'full', admin: 'full' },

  /* --- Responders --------------------------------------------------------- */
  r33_readOwnResponderProfile: { citizen: 'denied', responder: 'full', dispatcher: 'full', admin: 'full' },
  r34_setOwnAvailability: { citizen: 'denied', responder: 'full', dispatcher: 'full', admin: 'full' },
  r35_readResponderDirectory: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r36_readResponderPhone: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r37_editAnyResponderProfile: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r38_verifyRejectResponder: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'full' },
  r39_seeResponderStats: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },

  /* --- Locations ---------------------------------------------------------- */
  r40_submitOwnLocation: { citizen: 'full', responder: 'full', dispatcher: 'full', admin: 'full' },
  r41_writeOwnResponderLocation: { citizen: 'denied', responder: 'full', dispatcher: 'full', admin: 'full' },
  r42_writeOtherResponderLocation: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r43_readResponderLiveLocations: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r44_readLiveMap: { citizen: 'readonly', responder: 'scoped', dispatcher: 'full', admin: 'full' },

  /* --- Notifications ------------------------------------------------------ */
  r45_readOwnNotifications: { citizen: 'full', responder: 'full', dispatcher: 'full', admin: 'full' },
  r46_markOwnNotificationsRead: { citizen: 'full', responder: 'full', dispatcher: 'full', admin: 'full' },
  r47_sendNotificationToOther: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'full' },

  /* --- Analytics ---------------------------------------------------------- */
  r48_readOperationalAnalytics: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },
  r49_readRiskZones: { citizen: 'denied', responder: 'readonly', dispatcher: 'full', admin: 'full' },
  r50_recomputeAnalytics: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'full' },
  r51_exportCsv: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },

  /* --- Administration ----------------------------------------------------- */
  r52_listUsers: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'full' },
  r53_changeUserRole: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'full' },
  r54_enableSuspendAccount: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'full' },
  r55_readAuditLog: { citizen: 'denied', responder: 'denied', dispatcher: 'readonly', admin: 'full' },
  r56_readWriteConfig: { citizen: 'denied', responder: 'denied', dispatcher: 'readonly', admin: 'full' },
  r57_runMaintenanceJobs: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'full' },
  r58_softDeleteRestoreIncident: { citizen: 'denied', responder: 'denied', dispatcher: 'full', admin: 'full' },

  /* --- THE TWO HARD DENIALS ---------------------------------------------- */
  // Denied for every role, admin included. See the file header.
  r59_deleteAuditEntry: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'denied' },
  r61_changeOwnRole: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'denied' },

  /* --- Provisioning ------------------------------------------------------- */
  r60_createOrPromoteDispatcher: { citizen: 'denied', responder: 'denied', dispatcher: 'denied', admin: 'full' },
};

/**
 * Every capability key, in row order. Exported so a test can assert the matrix
 * has exactly 61 entries and that `HARD_DENIALS` is a subset of it.
 */
export const CAPABILITY_KEYS = Object.keys(PERMISSION_MATRIX) as CapabilityKey[];

/**
 * The capabilities no role may ever hold, including admin.
 *
 * Frozen because a `readonly` set in a `Set` literal is a small but real
 * runtime cost and — more importantly — because it makes the intent greppable.
 * `rg HARD_DENIALS` should find every place that reasons about these two.
 */
export const HARD_DENIALS: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  'r59_deleteAuditEntry',
  'r61_changeOwnRole',
]);

/**
 * Is this capability available to this role?
 *
 * `scoped` returns `true` — the action exists for this role, subject to a scope
 * the SERVER evaluates. `readonly` returns `false`: the data may be visible, but
 * the action is not offered, and rendering the button and failing on click is
 * worse than not rendering it.
 */
export function can(role: UserRole, capability: CapabilityKey): boolean {
  const level = PERMISSION_MATRIX[capability]?.[role];
  return level === 'full' || level === 'scoped';
}

/** The full level, for a component that needs to render differently for ◐ and ○. */
export function levelOf(role: UserRole, capability: CapabilityKey): PermissionLevel {
  return PERMISSION_MATRIX[capability]?.[role] ?? 'denied';
}

/** `true` when the data is visible but the action is not (docs/22 §3 `○`). */
export function isReadOnly(role: UserRole, capability: CapabilityKey): boolean {
  return levelOf(role, capability) === 'readonly';
}

/** `true` for `scoped` — the action exists but the server narrows it. */
export function isScoped(role: UserRole, capability: CapabilityKey): boolean {
  return levelOf(role, capability) === 'scoped';
}

/**
 * Every capability this role can perform, as a stable list of strings.
 *
 * This is the shape `GET /api/me` returns in `permissions[]`, and it is the
 * contract `usePermission` reads. Comparing against the SERVER's list rather
 * than recomputing it locally is the point: a client that derived its own
 * permissions would be deriving them from a role it chose.
 */
export function capabilityListFor(role: UserRole): string[] {
  return CAPABILITY_KEYS.filter((key) => can(role, key));
}

/**
 * Public barrel for shared domain types AND the runtime enum arrays.
 *
 * `export type *` alone would hide `INCIDENT_STATUSES` and friends from every
 * component: a type-only re-export is erased at runtime, so the one thing a
 * filter dropdown needs — the ordered list of valid values — would become
 * unreachable. Both halves are re-exported here on purpose.
 */

export type * from '@/types/enums';

export {
  USER_ROLES,
  ACCOUNT_STATUSES,
  INCIDENT_CATEGORIES,
  URGENCIES,
  INCIDENT_STATUSES,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  VERIFICATION_SOURCES,
  DUPLICATE_STATUSES,
  LOCATION_SOURCES,
  ACCURACY_GRADES,
  SLA_STATES,
  SAFETY_FLAGS,
  RESOLUTION_CODES,
  RESPONDER_STATUSES,
  VERIFICATION_STATUSES,
  DISPATCH_STATUSES,
  NOTIFICATION_TYPES,
  HISTORY_EVENT_TYPES,
  AUDIT_ACTIONS,
} from '@/types/enums';

/**
 * Phase 14. Not in the block above because it is deliberately NOT part of the
 * "stable public surface" list — it is a Phase 9 value the admin review queue
 * filters on, and importing it by name from `enums` keeps that dependency visible
 * at the call site instead of implying every enum belongs in the barrel.
 */
export { AI_RUN_OUTCOMES, AUDIT_ENTITY_TYPES } from '@/types/enums';

export type * from '@/types/domain';

/**
 * The wire contract, re-exported so a component imports `@/types` and gets
 * everything. Added in Phase 3; the definitions live in `lib/api/envelope.ts`
 * and `lib/api/error-codes.ts` beside their Zod schemas, because a schema and
 * its inferred type declared apart are two definitions of one contract.
 */
export type * from '@/types/api';


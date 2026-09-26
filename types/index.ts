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

export type * from '@/types/domain';

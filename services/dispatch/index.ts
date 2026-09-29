/**
 * ============================================================================
 * CareGrid AI — the dispatch service surface
 * ============================================================================
 *
 * A barrel, so a route imports from `@/services/dispatch` and not from four
 * modules. The alternative — a route reaching into `services/dispatch/assign.ts`
 * directly — works right up until someone adds a service and forgets the export,
 * and the failure is a 500 at runtime rather than a type error.
 *
 * Only the functions a ROUTE may call are exported. The transactional internals
 * (`appendStatusHistoryInTransaction`, `auditLogInTransaction`,
 * `buildStatusHistoryEvent`, `buildAuditDiff`) are deliberately NOT re-exported
 * here: they are only correct inside a transaction that has already made its
 * authorisation decisions, and exposing them invites a call site that writes a
 * history event with no guard in front of it.
 */

export { assignResponder } from '@/services/dispatch/assign';
export type { AssignResponderInput, AssignResponderResult } from '@/services/dispatch/assign';

export { findAvailableResponders, toCandidate } from '@/services/dispatch/candidates';
export type { FindCandidatesResult } from '@/services/dispatch/candidates';

export {
  notifyDispatchAnswered,
  respondToDispatch,
  transitionIncident,
  type DispatchActor,
  type RequestContextLite,
  type RespondInput,
  type RespondResult,
  type TransitionIncidentInput,
  type TransitionIncidentResult,
} from '@/services/dispatch/lifecycle';

export {
  appendAuditLog,
  buildAuditDocument,
  buildAuditDiff,
  PRIVILEGED_ACTIONS,
  UnsafeAuditFieldError,
  type AppendAuditInput,
  type AuditEntityType,
  type AuditLogDocument,
} from '@/services/dispatch/audit';

export {
  FORBIDDEN_NOTIFICATION_CLAIMS,
  NOTIFICATION_COPY,
  notificationDedupeKey,
  notifyInApp,
  recipientsForEvent,
  type InAppRecipient,
  type InAppNotificationSpec,
  type NotifyOutcome,
} from '@/services/dispatch/notify';

export {
  buildStatusHistoryEvent,
  MissingHistoryReasonError,
  REASON_REQUIRED_EVENTS,
  type HistoryMetadata,
  type StatusHistoryEvent,
} from '@/services/dispatch/status-history';

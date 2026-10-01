/**
 * CareGrid AI — shared enums.
 *
 * NORMATIVE source: docs/07_DATABASE_SCHEMA.md §2 (conventions), §4.2 (categories),
 * §4.3 (statuses), §4.5 (safety flags), and docs/08_API_SPECIFICATION.md §1.5.
 *
 * These unions are the single source for the whole UI. The runtime tables that
 * turn each value into an icon, a label and a colour live in `config/**`, and
 * both are validated against each other by `tests/unit/config-invariants.test.ts`
 * (docs/30_DEVELOPMENT_PHASE_PLAN.md §4.5 acceptance criteria).
 */

import type { LucideIcon } from 'lucide-react';

/* -------------------------------------------------------------------------- */
/* Roles — docs/22_USER_ROLES_PERMISSIONS.md §1                                */
/* -------------------------------------------------------------------------- */

export const USER_ROLES = ['citizen', 'responder', 'dispatcher', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Actor identity used by history/audit entries. Not a login role. */
export type ActorRole = UserRole | 'system';

/** docs/22 §1. `status != 'active'` blocks every API call. */
export const ACCOUNT_STATUSES = [
  'active',
  'pending_verification',
  'suspended',
  'disabled',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Incident — docs/07 §4                                                      */
/* -------------------------------------------------------------------------- */

/** Exactly 11 values. FR-025. A value outside this set is mapped to `other`. */
export const INCIDENT_CATEGORIES = [
  'medical',
  'fire',
  'traffic_accident',
  'flood',
  'heatwave',
  'severe_storm',
  'missing_person',
  'violence_crime',
  'infrastructure',
  'community_aid',
  'other',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

/** Exactly 4 values with SLA targets. FR-026. */
export const URGENCIES = ['critical', 'high', 'medium', 'low'] as const;
export type Urgency = (typeof URGENCIES)[number];

/** Who set the urgency. Never shown as colour — a text qualifier. docs/04 §7.2 */
export type UrgencySource = 'ai' | 'human' | 'fallback';

export const INCIDENT_STATUSES = [
  'new',
  'triaged',
  'verified',
  'assigned',
  'en_route',
  'on_scene',
  'resolved',
  'closed',
  'cancelled',
  'false_alarm',
  'merged',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/**
 * The canonical 7-element active set. Exported so it is never written as a
 * literal anywhere — docs/07 §12.1.
 */
export const ACTIVE_STATUSES = [
  'new',
  'triaged',
  'verified',
  'assigned',
  'en_route',
  'on_scene',
  'resolved',
] as const satisfies readonly IncidentStatus[];

export const TERMINAL_STATUSES = [
  'closed',
  'cancelled',
  'false_alarm',
  'merged',
] as const satisfies readonly IncidentStatus[];

/** Who produced the triage. A text badge only — docs/04 §2.12 */
export type TriageSource = 'ai' | 'fallback' | 'manual';

export const VERIFICATION_SOURCES = ['ai', 'fallback', 'human'] as const;
export type VerificationSource = (typeof VERIFICATION_SOURCES)[number];

/** docs/07 §9.4. `potential_duplicate` is a suggestion, never a merge. */
export const DUPLICATE_STATUSES = [
  'none',
  'potential_duplicate',
  'confirmed_duplicate',
  'separate_incident',
] as const;
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];

/** Location provenance. FR-031. */
export const LOCATION_SOURCES = ['gps', 'manual_pin', 'address_text', 'none'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

/** FR-032. `unknown` is a real value and must be rendered, not hidden. */
export const ACCURACY_GRADES = ['high', 'medium', 'low', 'unknown'] as const;
export type AccuracyGrade = (typeof ACCURACY_GRADES)[number];

/** FR-057. Computed server-side; shown as colour + text + a meter. */
export const SLA_STATES = ['on_track', 'at_risk', 'breached'] as const;
export type SlaState = (typeof SLA_STATES)[number];

/** 13 values. docs/07 §4.5. */
export const SAFETY_FLAGS = [
  'medical_critical',
  'self_harm',
  'violence',
  'child_at_risk',
  'gas_leak',
  'fire',
  'flood_rising',
  'crowd_panic',
  'possible_duplicate',
  'low_confidence',
  'unclear_location',
  'injured_trapped',
  'electrical_hazard',
] as const;
export type SafetyFlag = (typeof SAFETY_FLAGS)[number];

/**
 * How an AI triage run ended. `docs/09 §5`.
 *
 * Promoted out of `AiAnalysis.outcome` in Phase 14 so the admin review queue can
 * offer `?runOutcome=` as a filter without copying the union by hand. A
 * hand-copied list is the exact thing that drifts: it keeps working after a value
 * is added to the type, and the filter then silently omits the new state from
 * every report, which reads as "nothing happened" rather than "the filter is
 * stale".
 *
 * `blocked` is the value most worth keeping distinct from `error`: it is a refusal
 * (safety policy), not a fault, and collapsing the two makes a safety refusal look
 * like an outage in the health panel.
 */
export const AI_RUN_OUTCOMES = [
  'success',
  'validation_failed',
  'timeout',
  'error',
  'blocked',
] as const;
export type AiRunOutcome = (typeof AI_RUN_OUTCOMES)[number];

/** FR-054. `resolved` requires one of these. */
export const RESOLUTION_CODES = [
  'resolved_safe',
  'false_positive',
  'transferred_to_authority',
  'no_assistance_needed',
  'duplicate',
  'withdrawn_by_reporter',
] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

/** Report channel. `app` is the only implemented value in v1. FR-009. */
export type ReportChannel = 'app';

/* -------------------------------------------------------------------------- */
/* Responders — docs/07 §7                                                    */
/* -------------------------------------------------------------------------- */

export const RESPONDER_STATUSES = ['available', 'busy', 'offline'] as const;
export type ResponderStatus = (typeof RESPONDER_STATUSES)[number];

export const VERIFICATION_STATUSES = [
  'unverified',
  'pending',
  'verified',
  'rejected',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Dispatch — docs/07 §8                                                      */
/* -------------------------------------------------------------------------- */

export const DISPATCH_STATUSES = [
  'active',
  'accepted',
  'withdrawn',
  'completed',
  'expired',
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export type DispatchMode = 'auto_suggest' | 'manual' | 'self_claimed';

/* -------------------------------------------------------------------------- */
/* Notifications — docs/07 §10.2                                              */
/* -------------------------------------------------------------------------- */

export const NOTIFICATION_TYPES = [
  'incident_created',
  'incident_verified',
  'incident_assigned',
  'critical_incident_alert',
  'status_changed',
  'incident_resolved',
  'duplicate_suggested',
  'responder_unavailable',
  'sla_breached',
  'responder_verified',
  'role_changed',
  'account_suspended',
  'dispatch_received',
  'dispatch_accepted',
  'dispatch_declined',
  'incident_update',
  'system',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationSeverity = 'info' | 'warning' | 'critical';

/* -------------------------------------------------------------------------- */
/* History / audit — docs/07 §6, §11.5                                         */
/* -------------------------------------------------------------------------- */

export const HISTORY_EVENT_TYPES = [
  'created',
  'ai_triaged',
  'status_change',
  'verified',
  'assigned',
  'unassigned',
  'merged',
  'merged_in',
  'comment',
  'false_alarm',
  'evidence_added',
] as const;
export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];

export const AUDIT_ACTIONS = [
  'incident.create',
  'incident.update',
  'incident.status_change',
  'incident.assign',
  'incident.unassign',
  'incident.merge',
  'incident.merge_revert',
  'incident.false_alarm',
  'incident.delete',
  'incident.restore',
  'incident.reporter_location_update',
  'responder.verify',
  'responder.reject',
  'responder.update',
  'responder.location_opt_out',
  'user.create',
  'user.update',
  'user.role_change',
  'user.disable',
  'user.enable',
  'config.update',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  /**
   * A request refused because the ACCOUNT was not active — suspended,
   * disabled, or pending verification. Distinct from `auth.login_failed`
   * (a credential problem) and from `auth.role_mismatch` (a claim drift).
   *
   * Added for Phase 2: `lib/server/auth-guard.ts` writes one of these on every
   * `403 ACCOUNT_UNAVAILABLE`, and docs/10 §3.5's account gate names
   * `auth.blocked` in its sample. The docs' own consistency report flagged this
   * as D-16-7 (an action used in a sample but absent from the enum).
   */
  'auth.blocked',
  'auth.role_mismatch',
  'notification.sent',
  'analytics.recompute',
  'maintenance.run',
  /**
   * Phase 14. A HUMAN reviewed an AI triage result and recorded a decision.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS NOT `incident.update`
   * ---------------------------------------------------------------------------
   * Because the reviewer does not change the AI's answer — the AI result is
   * immutable history and the decision is recorded ALONGSIDE it. Folding this
   * into `incident.update` would make the two indistinguishable in the audit log a
   * year from now, and "the model was low confidence and a human disagreed" is a
   * materially different fact from "someone edited a field".
   *
   * It is also deliberately separate from `auth.*`: a review is an authorised
   * judgement, not an authorisation event.
   */
  'ai.review',
  /**
   * Phase 14. A reviewer dismissed an AI triage result as a false positive —
   * there was nothing for the model to be wrong about, so no correction exists.
   */
  'ai.review.dismissed',
] as const;
/**
 * What an audit entry is ABOUT. Phase 14.
 *
 * Promoted to a runtime array so the admin audit-log filter can offer
 * `?entityType=` without hand-copying `AuditInput.entityType`, which is the same
 * drift the `AI_RUN_OUTCOMES` promotion prevents. The union and the filter are
 * now the same declaration.
 *
 * `'aiReview'` is separate from `'incident'` even though a review belongs to an
 * incident: a reviewer query must find every review regardless of which incident
 * it was on, and reusing `'incident'` would make the filter answer a question
 * nobody asked.
 */
export const AUDIT_ENTITY_TYPES = [
  'incident',
  'user',
  'responder',
  'dispatch',
  'config',
  'auth',
  'notification',
  'aiReview',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/* -------------------------------------------------------------------------- */
/* Map visual language — docs/04 §11.1                                        */
/* -------------------------------------------------------------------------- */

/**
 * Marker SHAPE is a second, non-colour channel for urgency. A map that can
 * draw shapes must use them; the legend and the list still carry icon + label.
 */
export type MarkerShape = 'octagon' | 'triangle' | 'circle' | 'hollow-circle' | 'unknown';

/* -------------------------------------------------------------------------- */
/* Shared UI prop vocabulary                                                  */
/* -------------------------------------------------------------------------- */

export type Tone = 'default' | 'accent' | 'danger' | 'warning' | 'success' | 'info' | 'neutral';

export type ControlSize = 'sm' | 'md' | 'lg' | 'xl';

/** A `danger` tone is reserved for `critical` urgency and real errors (doc 04 A3). */
export type AlertTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export type { LucideIcon };

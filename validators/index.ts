/**
 * ============================================================================
 * CareGrid AI — the validators barrel
 * ============================================================================
 *
 * The ONLY import path a route handler uses for a schema. docs/17 §1.1.
 *
 * ---------------------------------------------------------------------------
 * WHY ROUTES IMPORT FROM HERE AND NOT FROM `validators/incident.ts`
 * ---------------------------------------------------------------------------
 * Two reasons, and the second is the important one.
 *
 *   1. One line to read. A reviewer opening a route sees one schema import and
 *      knows where the contract lives.
 *   2. **The barrel is the dependency boundary.** A route that imports a schema
 *      directly can be edited to import a `lib/` helper "just for a comparison",
 *      and the layering is gone. Through the barrel it cannot: nothing here
 *      imports Firestore, `process.env`, React, or `next/*`, so a schema is
 *      provably runnable on both sides of the wire (docs/17 §0 rule 5).
 *
 * A barrel is a boundary, not a shortcut (docs/20 §1 P10).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT EXPORTED IN PHASE 3
 * ---------------------------------------------------------------------------
 * Exported: the account schemas (Phase 2), the shared primitives, the query
 * primitives, the AI probe, and the admin surface (Phase 14). NOT exported:
 * `incident`, `dispatch`, `responder`, `notification`, `upload`, or `config` —
 * those have no route yet, and a schema with no caller is dead code
 * (docs/32 MUST 14).
 */

/* --- identity and account ------------------------------------------------- */
export {
  authEventBodySchema,
  meBootstrapBodySchema,
  mePatchBodySchema,
  meResponseSchema,
  profileSchema,
  userPublicSchema,
  type MeBootstrapBody,
  type MeResponse,
  type Profile,
  type UserPublic,
} from '@/validators/me';

/* --- the single validation source for every controlled value -------------- */
export {
  accountStatusSchema,
  auditActionSchema,
  auditReasonSchema,
  displayNameSchema,
  emailSchema,
  ENUMS,
  incidentCategorySchema,
  incidentStatusSchema,
  isoDateTimeSchema,
  locationSourceSchema,
  notificationTypeSchema,
  passwordSchema,
  referenceSchema,
  requestIdSchema,
  resolutionCodeSchema,
  responderStatusSchema,
  safetyFlagSchema,
  selfServiceRoleSchema,
  terminalStatusSchema,
  timezoneSchema,
  urgencySchema,
  userRoleSchema,
  verificationStatusSchema,
} from '@/validators/enums';

/* --- shared primitives: docs/17 §2.1 -------------------------------------- */
export {
  BASE32_ALPHABET,
  boundedInt,
  boundedText,
  coordinateField,
  dispatchIdField,
  emailField,
  firestoreId,
  firstIssuePerField,
  geohash6Field,
  isoDateField,
  isoInstantField,
  mediaIdField,
  phoneField,
  reasonField,
  referenceField,
  reportIdField,
  requestIdField,
  strictObject,
  timezoneField,
  trimmedString,
} from '@/validators/common';

/* --- query-string primitives: docs/17 §9 ---------------------------------- */
export {
  booleanField,
  boundedIntFromQuery,
  cursorField,
  DEFAULT_PAGE_SIZE,
  enumListField,
  limitField,
  MAX_PAGE_SIZE,
  paginationShape,
  searchTermField,
  sortDirectionField,
} from '@/validators/query';

/* --- the AI boundary: docs/09 §4 ------------------------------------------ */
export {
  aiSanitisationBounds,
  aiTriageProbeBodySchema,
  aiTriageProbeResponseSchema,
  type AiTriageProbeBody,
  type AiTriageProbeResponse,
} from '@/validators/ai';

/* --- the admin + operations surface: docs/22 §3, Phase 14 ---------------- */
export {
  adminAuditLogQuerySchema,
  adminAuditLogResponseSchema,
  adminChangeAccountStateBodySchema,
  adminChangeRoleBodySchema,
  adminIncidentDetailQuerySchema,
  adminIncidentListQuerySchema,
  adminIncidentStatusBodySchema,
  adminOverviewQuerySchema,
  adminOverviewResponseSchema,
  adminPaginationSchema,
  adminProvidersQuerySchema,
  adminProvidersResponseSchema,
  adminResponderDetailQuerySchema,
  adminResponderListQuerySchema,
  adminReviewDecisionBodySchema,
  adminReviewQueueQuerySchema,
  adminUserListQuerySchema,
  aiReviewSchema,
  providerHealthSchema,
  type AdminAuditLogResponse,
  type AdminOverviewResponse,
  type AdminProvidersResponse,
  type AdminReviewDecisionBody,
  type AiReviewRecord,
  type ReviewDecision,
  type ReviewDispatchOutcome,
} from '@/validators/admin';

/* --- incident creation: docs/08 §3.1, FR-001 … FR-003 --------------------- */
export {
  incidentCreateBodySchema,
  incidentCreateResponseSchema,
  incidentLocationSchema,
  incidentListQuerySchema,
  incidentListResponseSchema,
  incidentRowSchema,
  incidentDetailResponseSchema,
  type IncidentCreateBody,
  type IncidentCreateResponse,
} from '@/validators/incident';

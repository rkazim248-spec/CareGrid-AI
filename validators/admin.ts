/**
 * ============================================================================
 * CareGrid AI — admin request and response schemas (Phase 14)
 * ============================================================================
 *
 * `docs/17`, `docs/22`. The client is untrusted; these are the FIRST gate, not
 * the security boundary. The boundary is `lib/server/permissions.ts` plus the
 * transaction in each `services/admin/**` module, all of which re-derive every
 * fact from Firestore.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THIS FILE REFUSES
 * ---------------------------------------------------------------------------
 * These are requests a permissions matrix alone does not stop, and each has a
 * named guard rather than relying on a schema:
 *
 *   1. **A body that writes a field recording the AI's own output.**
 *      `assertNoAiResultInBody()` (lib/server/auth-guard.ts) runs BEFORE this
 *      file's schemas, so the refusal is `403 AI_RESULT_IMMUTABLE` rather than a
 *      generic "unrecognised key". A reviewer disagrees by writing a REVIEW.
 *   2. **A body that names its own reviewer.** `reviewedBy` is in the guard's
 *      list even though a review legitimately sets it — the service writes it
 *      from the authenticated caller, never reads it from a body.
 *   3. **A body that escalates a role.** `changeUserRoleBodySchema` accepts a
 *      role, because that is the endpoint's purpose; `assertNotSelfRoleChange()`
 *      and the r61 hard denial make it safe. That is the difference between an
 *      endpoint that must exist and one that must never exist, and it is why the
 *      two are not handled the same way.
 *
 * ---------------------------------------------------------------------------
 * WHY `role` IS ABSENT FROM EVERY SCHEMA EXCEPT THE ROLE-CHANGE ONE
 * ---------------------------------------------------------------------------
 * Seven of the nine admin mutations would be a privilege-escalation hole if a
 * body could carry `role`. They read it from the Firestore document or the
 * matrix, and they do not declare it. `.strict()` makes the absence a property of
 * the type rather than a line a future edit can forget.
 */

import { z } from 'zod';

import {
  ACCOUNT_STATUSES,
  AI_RUN_OUTCOMES,
  AUDIT_ENTITY_TYPES,
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  RESPONDER_STATUSES,
  SLA_STATES,
  URGENCIES,
  USER_ROLES,
  VERIFICATION_STATUSES,
} from '@/types';
import { AUDIT_ACTIONS } from '@/types/enums';
import { isoInstantField, reasonField, strictObject } from '@/validators/common';
import { accountStatusSchema, isoDateTimeSchema, userRoleSchema } from '@/validators/enums';
import { booleanField, cursorField, enumListField, limitField, searchTermField } from '@/validators/query';

/* ========================================================================== */
/* Primitives                                                                  */
/* ========================================================================== */

/**
 * The reason for a privileged change. The shared 10..280 field, not a copy.
 *
 * Every mutating body below takes a `reason`, not only the role-changing ones.
 * The reason is the only thing that makes an audit entry readable a year later,
 * and "an admin clicked a button" is not it.
 */
const adminReason = reasonField;

/**
 * A Firebase Auth uid in a QUERY STRING.
 *
 * Deliberately NOT `firestoreId()`. That field demands exactly 20 alphanumerics
 * because it validates the app's own `rep_`-less document ids, and a Firebase
 * uid is 28 characters — so reusing it here would reject every real actor and
 * make `?actorUid=` a filter that can never match. The rule that matters is
 * narrower: no `/`, because a `/` would let a caller address a different document
 * than the one they named, and not `.`/`..` for the same reason Firestore
 * forbids them.
 */
const uidQueryField = z
  .string()
  .trim()
  .min(1, 'Required.')
  .max(128, 'That identifier is too long.')
  .refine(
    (value) => !value.includes('/') && value !== '.' && value !== '..',
    'That identifier is not valid.',
  );

/**
 * A reviewer's judgement about whether the incident needed an ambulance.
 *
 * Three values and not a boolean: "no" and "not enough information" are different
 * facts, and collapsing them records a data-quality problem as a clean negative,
 * where it disappears from every report. `insufficient_information` is the value
 * that makes the queue self-improving — it is the one that says "the model could
 * not tell, and neither could the reviewer", which is the signal worth counting.
 */
const REVIEW_DISPATCH_OUTCOMES = ['needed', 'not_needed', 'insufficient_information'] as const;
export type ReviewDispatchOutcome = (typeof REVIEW_DISPATCH_OUTCOMES)[number];

/**
 * The three shapes a review decision can take.
 *
 * `accept` — the model was right; nothing changes.
 * `override` — the reviewer disagrees with a triage field.
 * `dismiss` — the model was not wrong, but there is nothing to act on (a
 *   duplicate already open, a resolved incident, a test record). Distinct from
 *   `accept` because it retires the incident from the queue for a different
 *   reason, and from `override` because it changes no field.
 *
 * Kept as an inline union rather than an enum: it is not a domain value that
 * appears on any other surface, and adding it to `types/enums.ts` would imply a
 * `AUDIT_ACTIONS`-level stability it does not need.
 */
const REVIEW_DECISIONS = ['accept', 'override', 'dismiss'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/* ========================================================================== */
/* GET /api/admin/overview                                                     */
/* ========================================================================== */

/**
 * The dashboard has no filters by design: it is a fixed set of counters, and a
 * "filtered overview" is a different product nobody asked for. Strict so an
 * unrecognised query key is a visible 400 rather than a silent no-op that makes a
 * stale cache look correct.
 */
export const adminOverviewQuerySchema = strictObject({});

/* ========================================================================== */
/* GET /api/admin/incidents                                                    */
/* ========================================================================== */

/**
 * The incident search.
 *
 * `q` is `searchTermField` — 60 characters, at most three words — so the search
 * box cannot be turned into a 60 KB regex for Firestore to read.
 *
 * `includeDeleted` is `booleanField` and not `z.coerce.boolean()`: a hand-typed
 * `?includeDeleted=yes` must be a 400, because a truthy coercion is how a
 * "deleted only" view silently becomes "everything".
 */
export const adminIncidentListQuerySchema = strictObject({
  status: enumListField(INCIDENT_STATUSES).optional(),
  category: enumListField(INCIDENT_CATEGORIES).optional(),
  urgency: enumListField(URGENCIES).optional(),
  sla: enumListField(SLA_STATES).optional(),
  includeDeleted: booleanField.optional(),
  q: searchTermField.optional(),
  limit: limitField.optional(),
  cursor: cursorField,
});

/* ========================================================================== */
/* GET /api/admin/incidents/:id                                                */
/* ========================================================================== */

/**
 * No query keys. The detail view takes the id from the path and returns the
 * server's truth about it; adding a filter here would invite a caller to request
 * a projection and get a redaction bug instead of the redactor.
 */
export const adminIncidentDetailQuerySchema = strictObject({});

/* ========================================================================== */
/* POST /api/admin/incidents/:id/status                                        */
/* ========================================================================== */

/**
 * An administrative status change.
 *
 * This body resembles the dispatch and responder transition bodies and is
 * deliberately a DIFFERENT shape from both:
 *
 *   - `resolutionCode` is optional here and required for `resolved` inside
 *     `services/dispatch/lifecycle.ts`. The schema cannot express "required only
 *     when `to` is `resolved`" without a `superRefine` that duplicates the
 *     lifecycle's transition table, and duplicating a transition table is exactly
 *     how two of them disagree.
 *   - `note` is optional. An admin correcting a mis-clicked status has nothing
 *     useful to add beyond the reason, and a required note becomes filler.
 *   - Dispatch-only statuses (`en_route`, `on_scene`) are NOT filtered out here.
 *     An admin CAN set them — an operator with a radio is a legitimate source of
 *     truth — but only through the lifecycle's own table, which is what keeps the
 *     dispatch bookkeeping consistent. The service calls `transitionIncident()`;
 *     it never writes `incidents.status` itself.
 */
export const adminIncidentStatusBodySchema = strictObject({
  to: z.enum(INCIDENT_STATUSES),
  reason: adminReason,
  note: z.string().trim().max(400, 'Keep this under 400 characters.').optional(),
  /** Required by the lifecycle when `to` is `resolved` (FR-054). */
  resolutionCode: z
    .string()
    .trim()
    .min(1, 'Required.')
    .max(64, 'That resolution code is not valid.')
    .optional(),
});

/* ========================================================================== */
/* GET /api/admin/review-queue                                                 */
/* ========================================================================== */

export const adminReviewQueueQuerySchema = strictObject({
  category: enumListField(INCIDENT_CATEGORIES).optional(),
  urgency: enumListField(URGENCIES).optional(),
  /**
   * Filter on the run outcome so an operator can find the runs that never
   * completed. Read from `AI_RUN_OUTCOMES`, so adding a state to the domain type
   * automatically makes it filterable instead of silently unfilterable.
   */
  runOutcome: enumListField(AI_RUN_OUTCOMES).optional(),
  q: searchTermField.optional(),
  limit: limitField.optional(),
  cursor: cursorField,
});

/* ========================================================================== */
/* POST /api/admin/review-queue/:incidentId/decision                           */
/* ========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * THE MOST IMPORTANT SCHEMA IN THIS FILE
 * ---------------------------------------------------------------------------
 * It has NO `aiConfidence`, NO `aiRuns`, NO `triageSource`, NO `reviewedBy`, and
 * NO `reviewedAt`. A reviewer cannot make the model look more confident, cannot
 * rewrite what it said, and cannot sign someone else's name to a decision.
 *
 * `adjustment` holds the reviewer's OWN answer. It is deliberately NOT written
 * back over the AI's output: the incident's live triage fields keep the machine's
 * value, and the review sits beside it labelled `sourceOfTruth: 'human_review'`.
 * That is the difference between "a human corrected this" and "the system was
 * never wrong" — and it is why the queue stays auditable after the incident
 * closes.
 */
export const adminReviewDecisionBodySchema = strictObject({
  decision: z.enum(REVIEW_DECISIONS),
  reason: adminReason,
  note: z.string().trim().max(1000, 'Keep this under 1000 characters.').optional(),
  /**
   * The human's judgement, optional and partial.
   *
   * Every field is `.optional()` because a reviewer may agree with the urgency
   * and disagree with the category, and forcing a full triple to record that is
   * how reviewers stop reviewing. Absent keys are set individually and mean "the
   * reviewer said nothing about this" — never "reset this to nothing".
   */
  adjustment: strictObject({
    urgency: z.enum(URGENCIES).optional(),
    category: z.enum(INCIDENT_CATEGORIES).optional(),
    dispatchOutcome: z.enum(REVIEW_DISPATCH_OUTCOMES).optional(),
  }).optional(),
});

export type AdminReviewDecisionBody = z.infer<typeof adminReviewDecisionBodySchema>;

/* ========================================================================== */
/* GET /api/admin/responders                                                   */
/* ========================================================================== */

/**
 * `capability` is `searchTermField`, so it is bounded at 60 characters and three
 * words. It is NOT a free string for the reason given on `entityType` in the audit
 * query: a capability nobody holds returns an empty page that reads as "there are
 * no responders", which is a wrong answer rather than a small bug.
 */
export const adminResponderListQuerySchema = strictObject({
  status: enumListField(RESPONDER_STATUSES).optional(),
  verification: enumListField(VERIFICATION_STATUSES).optional(),
  capability: searchTermField.optional(),
  q: searchTermField.optional(),
  limit: limitField.optional(),
  cursor: cursorField,
});

/* ========================================================================== */
/* GET /api/admin/responders/:uid                                              */
/* ========================================================================== */

export const adminResponderDetailQuerySchema = strictObject({
  /**
   * `includeContact` defaults OFF and is separate from the redaction layer on
   * purpose. Redaction decides what this ROLE may ever see; this flag is a
   * deliberate, audited narrowing of an already-permitted payload for a specific
   * screen. Without the split, "hide the phone number by default" and "never send
   * the phone number to a dispatcher" become the same mechanism, and loosening the
   * first quietly loosens the second.
   */
  includeContact: booleanField.optional(),
});

/* ========================================================================== */
/* GET /api/admin/users                                                        */
/* ========================================================================== */

export const adminUserListQuerySchema = strictObject({
  role: enumListField(USER_ROLES).optional(),
  status: enumListField(ACCOUNT_STATUSES).optional(),
  q: searchTermField.optional(),
  limit: limitField.optional(),
  cursor: cursorField,
});

/* ========================================================================== */
/* POST /api/admin/users/:uid/role                                             */
/* ========================================================================== */

/**
 * The ONE admin body that accepts a role, because changing it is the endpoint.
 *
 * The safety does not come from this schema and never could — it comes from three
 * checks a schema cannot express:
 *
 *   1. `requireCapability(user, 'r53_changeUserRole')` — admin only.
 *   2. `assertNotSelfRoleChange()` — nobody edits their own role, INCLUDING an
 *      admin repairing their own mistake.
 *   3. The r61 `changeOwnRole` hard denial, refused before the matrix lookup for
 *      every role including admin.
 *
 * `.strict()` is load-bearing for the same reason `role` is absent elsewhere: a
 * body cannot also carry `status`, so a role change cannot smuggle an account
 * enable/disable through a route that only audits one of them.
 */
export const adminChangeRoleBodySchema = strictObject({
  role: userRoleSchema,
  reason: adminReason,
});

/* ========================================================================== */
/* POST /api/admin/users/:uid/account-status                                   */
/* ========================================================================== */

export const adminChangeAccountStateBodySchema = strictObject({
  status: accountStatusSchema,
  reason: adminReason,
});

/* ========================================================================== */
/* GET /api/admin/audit-logs                                                   */
/* ========================================================================== */

/**
 * `action` filters on the real `AUDIT_ACTIONS` array rather than a copy. A
 * hand-written list is the failure mode where the filter keeps working after a new
 * action is added — and then silently omits that action from every filtered
 * report, which reads as "nothing happened" rather than "the filter is stale".
 */
export const adminAuditLogQuerySchema = strictObject({
  action: enumListField(AUDIT_ACTIONS, 20).optional(),
  actorUid: uidQueryField.optional(),
  /**
   * An ISO INSTANT, not a calendar date: the log is an ordered timeline, and "since
   * Monday" is ambiguous across a DST boundary in a timezone the server does not
   * know. The client sends a full instant it has already localised, and
   * `isoInstantField` requires the offset so it cannot arrive naive by accident.
   */
  from: isoInstantField.optional(),
  to: isoInstantField.optional(),
  entityType: enumListField(AUDIT_ENTITY_TYPES, 8).optional(),
  q: searchTermField.optional(),
  limit: limitField.optional(),
  cursor: cursorField,
});

/* ========================================================================== */
/* GET /api/admin/providers                                                    */
/* ========================================================================== */

/** No query keys. Health is a fixed five-provider report and is never filtered. */
export const adminProvidersQuerySchema = strictObject({});

/* ========================================================================== */
/* Response schemas                                                            */
/* ========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * WHY RESPONSES ARE SCHEMAS AND NOT `.strict()`
 * ---------------------------------------------------------------------------
 * These use Zod's default strip behaviour, per `validators/common.ts`: an unknown
 * key from a NEWER server is dropped rather than fatal, so an older cached client
 * keeps working. That is the opposite of the request rule, and deliberately so.
 *
 * They earn their place by catching the failure that actually matters here — a
 * service accidentally serialising a credential into a response shape. A test
 * asserting each response parses against these is worth far more than the schema
 * at runtime, because the schema at runtime proves nothing about what the
 * Firestore read contained.
 */
export const providerHealthSchema = z.object({
  id: z.enum(['firebase', 'gemini', 'mapbox', 'imagekit', 'assemblyai']),
  label: z.string(),
  /**
   * The five states the ops panel is allowed to show, and no others.
   *
   * A boolean `ok` would be a lie for a provider that is merely unconfigured, and
   * a free-text status would let a provider return "kinda fine" and defeat every
   * consumer that sorts or filters on it.
   */
  state: z.enum(['configured', 'unconfigured', 'healthy', 'degraded', 'failed']),
  /** Present only for `degraded`/`failed`. Never contains a value or a var name. */
  detail: z.string().optional(),
  /**
   * Whether this deployment is EXPECTED to have the provider.
   *
   * Named `expected`, not `required`, because `IntegrationStatus.required` in
   * `lib/env.server.ts` already means "the NAMES of the variables you must set".
   * Two fields called `required` meaning opposite things in the same feature is a
   * bug waiting to be read the wrong way, and the admin panel is the one screen
   * where confusing "missing" with "not needed" causes a page at 3am.
   */
  expected: z.boolean(),
});

export const adminProvidersResponseSchema = z.object({
  providers: z.array(providerHealthSchema),
  healthyCount: z.number().int().min(0),
  degradedCount: z.number().int().min(0),
  unconfiguredCount: z.number().int().min(0),
  generatedAt: isoDateTimeSchema,
});

/** Every list route returns this, so every table renders `hasMore` the same way. */
export const adminPaginationSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const adminOverviewResponseSchema = z.object({
  generatedAt: isoDateTimeSchema,
  incidents: z.object({
    total: z.number().int().min(0),
    open: z.number().int().min(0),
    /**
     * A PARTIAL map keyed by status or role, not a full enum map.
     *
     * `z.record(z.string(), …)` rather than a fixed shape or `z.enum()` keys on
     * purpose: a count map omits statuses with zero incidents, and forcing every
     * key to exist would make "0 closed incidents" indistinguishable from "the
     * closed count was not read". A missing key genuinely means zero.
     *
     * Zod 4 requires both the key and value schemas; the one-argument form was
     * removed, so the key type has to be stated even though it is always a string.
     */
    byStatus: z.record(z.string(), z.number().int().min(0)),
    /**
     * `undefined` when no incident exists — NOT `0` from an empty read. "Median
     * open age is 0 minutes" is a measurable claim about the system; "there are no
     * open incidents" is a different one, and only the second is true.
     */
    medianOpenAgeMinutes: z.number().min(0).optional(),
  }),
  ai: z.object({
    /** `aiNeedsReview` and not yet reviewed. The server's flag, not a client guess. */
    pendingReviewCount: z.number().int().min(0),
    reviewedCount: z.number().int().min(0),
    threshold: z.number().min(0).max(1),
    failedRunCount: z.number().int().min(0),
    averageConfidence: z.number().min(0).max(1).optional(),
  }),
  responders: z.object({
    total: z.number().int().min(0),
    /**
     * A PARTIAL map keyed by status or role, not a full enum map.
     *
     * `z.record(z.string(), …)` rather than a fixed shape or `z.enum()` keys on
     * purpose: a count map omits statuses with zero incidents, and forcing every
     * key to exist would make "0 closed incidents" indistinguishable from "the
     * closed count was not read". A missing key genuinely means zero.
     *
     * Zod 4 requires both the key and value schemas; the one-argument form was
     * removed, so the key type has to be stated even though it is always a string.
     */
    byStatus: z.record(z.string(), z.number().int().min(0)),
    /** `lastSeenAt` older than the staleness threshold. */
    staleCount: z.number().int().min(0),
  }),
  users: z.object({
    total: z.number().int().min(0),
    activeCount: z.number().int().min(0),
    disabledCount: z.number().int().min(0),
  }),
});

export const adminAuditLogEntrySchema = z.object({
  id: z.string(),
  at: isoDateTimeSchema,
  action: z.string(),
  actorUid: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  reason: z.string().nullable(),
  /** Free-form, but only ever the shapes `lib/server/audit.ts` itself writes. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const adminAuditLogResponseSchema = z.object({
  entries: z.array(adminAuditLogEntrySchema),
  pagination: adminPaginationSchema,
});

/** The recorded review. Exported so the detail response can embed it. */
export const aiReviewSchema = z.object({
  reviewId: z.string(),
  incidentId: z.string(),
  decision: z.enum(REVIEW_DECISIONS),
  /** ALWAYS the authenticated caller. Never read from a request body. */
  reviewerUid: z.string(),
  reviewedAt: isoDateTimeSchema,
  reason: z.string(),
  note: z.string().nullable(),
  adjustment: z
    .object({
      urgency: z.enum(URGENCIES).optional(),
      category: z.enum(INCIDENT_CATEGORIES).optional(),
      dispatchOutcome: z.enum(REVIEW_DISPATCH_OUTCOMES).optional(),
    })
    .nullable(),
  /** The immutable machine answer, copied for context and never edited. */
  aiConfidenceAtReview: z.number().min(0).max(1).nullable(),
  thresholdAtReview: z.number().min(0).max(1),
});

export type AdminProvidersResponse = z.infer<typeof adminProvidersResponseSchema>;
export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;
export type AdminAuditLogResponse = z.infer<typeof adminAuditLogResponseSchema>;
export type AiReviewRecord = z.infer<typeof aiReviewSchema>;
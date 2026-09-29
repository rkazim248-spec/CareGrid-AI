/**
 * ============================================================================
 * CareGrid AI — dispatch request and response schemas
 * ============================================================================
 *
 * `docs/17`, `docs/08`. The client is untrusted; these are the first gate, not the
 * security boundary. The boundary is `lib/dispatch/transitions.ts` plus the
 * transaction in `services/dispatch/assign.ts`, both of which re-derive every fact
 * from Firestore.
 *
 * ---------------------------------------------------------------------------
 * `.strict()` ON EVERY REQUEST BODY
 * ---------------------------------------------------------------------------
 * An unrecognised field is REJECTED rather than ignored, for two reasons. The first
 * is that a body carrying `role: 'admin'` or `status: 'resolved'` is an attempt, and
 * silently dropping it would let a caller believe a field they sent was honoured.
 * The second is quieter: if a future field is added and a schema does not declare
 * it, a client sending it gets a 400 naming the field, instead of a silent no-op
 * that a dispatcher debugs for an hour.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT IN HERE, AND WHY
 * ---------------------------------------------------------------------------
 * **No `role`, no `uid`, no `status`, no `isLiveAssignee`, no `verification`,
 * no `distanceM`, no `etaSec`, no `capabilityMatch`.** Every one of those is either
 * a server-derived fact or a server-computed value, and accepting any of them from
 * a client would be accepting a claim about the world. `docs/17` is the authority
 * and it groups them as rejected inputs rather than optional ones.
 *
 * **`incidentId` appears in the path, not the body**, for the same reason a
 * mismatch between the two would be a request that says one thing in two places.
 */

import { z } from 'zod';

import { AUDIT_REASON_MAX, DISPATCH_NOTE_MAX, RESOLUTION_NOTE_MAX } from '@/config/dispatch';
import { INCIDENT_STATUSES, RESOLUTION_CODES } from '@/types';

/* ========================================================================== */
/* Primitives                                                                  */
/* ========================================================================== */

/**
 * A Firestore document id, as this app generates them.
 *
 * Permissive on purpose, and narrower than it looks in one specific way: it is
 * `.trim()`ed, so `"   "` is rejected rather than becoming a document id of three
 * spaces. A whitespace id would not be caught by the length check (it is longer
 * than zero) and would be used verbatim as a `responders/{uid}` path — a document
 * that exists, matches nothing, and produces a "responder not found" for a
 * dispatcher who did nothing wrong.
 *
 * Beyond the trim it is permissive. A 20-character cap with a `[A-Za-z0-9_-]`
 * alphabet matches what the Admin SDK's auto-IDs produce, and tightening it further
 * would reject a legitimate id rather than catch an injection — Firestore document
 * ids cannot contain `/` and cannot be `.` or `..`, and the SDK enforces both, so a
 * stricter regex here would be theatre that could only produce false refusals.
 */
const documentId = z
  .string()
  .trim()
  .min(1, 'Required.')
  .max(1500, 'That identifier is too long.')
  .refine((value) => !value.includes('/'), 'That identifier is not valid.');

/**
 * A free-text note.
 *
 * Trimmed, and the emptiness check is on the TRIMMED value — `"   "` becoming a
 * valid note would let a whitespace-only "instruction" reach a responder as if a
 * dispatcher had said something.
 */
const note = z
  .string()
  .trim()
  .min(1, 'Required.')
  .max(DISPATCH_NOTE_MAX, `Keep this under ${DISPATCH_NOTE_MAX} characters.`);

/** A reason for a privileged action. `docs/07 §11.5`: "<= 200 chars". */
const reason = z
  .string()
  .trim()
  .min(1, 'A short reason is required so the change can be understood later.')
  .max(AUDIT_REASON_MAX, `Keep this under ${AUDIT_REASON_MAX} characters.`);

/* ========================================================================== */
/* POST /api/incidents/:id/dispatch                                             */
/* ========================================================================== */

export const assignResponderBodySchema = z
  .object({
    /**
     * The responder to assign. **Verified, not trusted**: the transaction re-reads
     * this responder's `verification`, `status` and `activeIncidentCount` and
     * refuses the assignment on what it finds. A client that names a different uid
     * than the one it was shown gets that responder's real state, not the panel's.
     */
    responderUid: documentId,
    /** Optional dispatcher instruction. `docs/07 §8`. */
    note: note.optional(),
  })
  .strict();

/* ========================================================================== */
/* POST /api/dispatches/:id/accept  /  /reject                                 */
/* ========================================================================== */

export const acceptDispatchBodySchema = z
  .object({})
  .strict()
  // An empty object still needs a body on the wire for `withRequest` to see one.
  // `{}` is the whole contract: accepting needs no parameters, and a schema with
  // optional fields would let a client send a `note` that is silently discarded.
  .refine(() => true, 'No parameters are accepted.');

export const rejectDispatchBodySchema = z
  .object({
    /**
     * brief §16: "If rejected, require or allow a reason where appropriate."
     *
     * **Allowed, not required** — and that is a deliberate reading. The brief's own
     * example list ends with "Other", which is only reachable if free text is
     * accepted; a mandatory enumerated field would force a responder to record a
     * reason that is not true in order to decline an incident they are entitled to
     * decline. It is `.optional()` here and the decline is still fully recorded —
     * the `statusHistory` event and the audit row both exist regardless, so nothing
     * about the refusal is lost by not having prose.
     */
    reason: reason.optional(),
  })
  .strict();

/* ========================================================================== */
/* DELETE /api/dispatches/:id  (brief §33 — cancellation)                      */
/* ========================================================================== */

export const withdrawDispatchBodySchema = z
  .object({
    /** brief §33: "Require confirmation." A dispatcher cancelling a live assignment
     *  is removing a responder who may already be driving, so the reason is
     *  mandatory here even though a responder's decline does not require one. */
    reason,
  })
  .strict();

/* ========================================================================== */
/* PATCH /api/incidents/:id/status — docs/08 §3.8                               */
/* ========================================================================== */

export const incidentStatusBodySchema = z
  .object({
    /** The target. Validated against the enum here AND against the table in the
     *  transaction — the enum check is a 400 for a typo, the table check is a 409
     *  for an illegal move, and conflating them would tell a dispatcher their
     *  request was malformed when the truth is that `on_scene` is not available
     *  from `new`. */
    to: z.enum(INCIDENT_STATUSES),
    /** Required by the table for `cancelled`, `false_alarm` and unassign. */
    reason: reason.optional(),
    /** `docs/07 §6`: "responder on-scene note, dispatcher comment". */
    note: z
      .string()
      .trim()
      .max(RESOLUTION_NOTE_MAX, `Keep this under ${RESOLUTION_NOTE_MAX} characters.`)
      .optional(),
    /** FR-054. `docs/07 §4`'s vocabulary. */
    resolutionCode: z.enum(RESOLUTION_CODES).optional(),
    /**
     * brief §34's optional capture. **Every field is optional and nullable, and
     * `null` means "not recorded"** — never `0` and never `""`. A system that
     * demands a body count at the moment a responder steps away from an incident
     * will be given a guess, and a guess about how many people were helped is a
     * fabrication about a rescue.
     */
    resolution: z
      .object({
        resourcesUsed: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
        peopleAssisted: z.number().int().min(0).max(100_000).nullable().optional(),
        followUpRequired: z.boolean().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  // FR-054. `docs/08 §3.8` step 4: "`resolved` → `resolutionCode` required from the
  // controlled list (FR-054)".
  //
  // Checked here as well as in `checkTransitionPrerequisites`, because here it is a
  // 400 that NAMES THE FIELD — more use to a client than a 409 whose only message
  // is "unresolved prerequisite". The pure function keeps the check for callers
  // that do not go through a route.
  .refine((value) => value.to !== 'resolved' || value.resolutionCode !== undefined, {
    message: 'Choose how this incident was resolved.',
    path: ['resolutionCode'],
  })
  // `docs/17 §212` rule 8: "A resolution code only with `resolved` |
  // `resolutionCode` present and `status !== 'resolved'` | `not_allowed_for_status`
  // | `VALIDATION_FAILED`".
  //
  // A code on an `en_route` transition is a caller who believes they have already
  // finished, or one whose UI sent a stale field. Either way it is a request the
  // server should refuse rather than quietly ignore — and ignoring it is the
  // failure mode, because the incident would reach `resolved` later with no code.
  .refine((value) => value.to === 'resolved' || value.resolutionCode === undefined, {
    message: 'A resolution code only applies when the incident is being resolved.',
    path: ['resolutionCode'],
  });

/* ========================================================================== */
/* GET /api/incidents/:id/candidates — brief §11                                */
/* ========================================================================== */

export const candidatesQuerySchema = z
  .object({
    /** How many to return. Capped server-side at `CANDIDATE_LIMIT_CEILING`. */
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/* ========================================================================== */
/* Responses                                                                   */
/* ========================================================================== */

/**
 * The candidate row a dispatcher sees.
 *
 * **`factors` is required, not optional.** brief §12: "The recommendation should be
 * explainable." A response schema that permitted a candidate without its reasons
 * would make the explainable panel optional in exactly the place where a future
 * contributor would drop it for tidiness.
 */
export const candidateSchema = z.object({
  rank: z.number().int().min(1),
  responderUid: z.string(),
  displayName: z.string(),
  status: z.enum(['available', 'busy', 'offline']),
  capabilities: z.array(z.string()),
  /** `null` when no position is known — never `0`, which would read as "on the spot". */
  distanceM: z.number().nullable(),
  /** brief §30: distance is not ETA, and no ETA is claimed anywhere in this phase. */
  distanceLabel: z.string().nullable(),
  capabilityMatch: z.boolean(),
  missingResources: z.array(z.string()),
  isAssignable: z.boolean(),
  outOfServiceArea: z.boolean(),
  staleLocation: z.boolean(),
  accuracyGrade: z.enum(['high', 'medium', 'low', 'unknown']).nullable(),
  factors: z.array(
    z.object({
      kind: z.string(),
      detail: z.string(),
      metres: z.number().optional(),
      missing: z.array(z.string()).optional(),
      ageMinutes: z.number().optional(),
    }),
  ),
});

export const candidatesResponseSchema = z.object({
  incidentId: z.string(),
  /** `true` when the query hit its limit, so the panel is known to be partial. */
  truncated: z.boolean(),
  /** brief §31's "no available responder" state, or `null` when populated. */
  emptyReason: z.enum(['no_responders', 'none_verified', 'capability_required', 'not_found']).nullable(),
  /** The heading a dispatcher reads first. brief §13. */
  heading: z.string(),
  candidates: z.array(candidateSchema),
});

export const assignResponseSchema = z.object({
  dispatchId: z.string(),
  incidentId: z.string(),
  /** The human `CG-XXXXXX` reference. `docs/07 §1.1`. */
  incidentReference: z.string(),
  responderUid: z.string(),
  status: z.literal('active'),
  distanceM: z.number().nullable(),
  capabilityMatch: z.boolean(),
  replacedDispatchId: z.string().nullable(),
  incidentStatusChanged: z.boolean(),
  noop: z.boolean(),
});

export const respondResponseSchema = z.object({
  dispatchId: z.string(),
  status: z.enum(['active', 'accepted', 'withdrawn', 'completed', 'expired']),
  incidentId: z.string(),
  noop: z.boolean(),
});

export const incidentStatusResponseSchema = z.object({
  incidentId: z.string(),
  from: z.enum(INCIDENT_STATUSES),
  to: z.enum(INCIDENT_STATUSES),
  /** `docs/08 §3.8`: `meta.noop` for a repeated transition. */
  noop: z.boolean(),
  historyEventId: z.string().nullable(),
  /** US-012: the legal targets, so the client renders one primary action. */
  allowedNext: z.array(z.enum(INCIDENT_STATUSES)),
  completedDispatchId: z.string().nullable(),
});

/* ========================================================================== */
/* The route parameter schemas                                                 */
/* ========================================================================== */

export const incidentIdParamSchema = z.object({ id: documentId }).strict();
export const dispatchIdParamSchema = z.object({ dispatchId: documentId }).strict();

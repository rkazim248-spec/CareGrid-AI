/**
 * ============================================================================
 * CareGrid AI — the AI review queue (Phase 14)
 * ============================================================================
 *
 * `GET /api/admin/review-queue` and
 * `POST /api/admin/review-queue/:incidentId/decision`.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT: THE MODEL'S ANSWER IS IMMUTABLE HISTORY
 * ---------------------------------------------------------------------------
 * This is the file the whole Phase 14 rests on, so the rule is stated plainly.
 *
 * When the model triaged an incident it made a PREDICTION: this confidence, this
 * category, this urgency, this explanation. A reviewer may conclude it was wrong.
 * What a reviewer may NOT do is change what the model said. If they could, then
 * after the first review the system could no longer tell the difference between
 * "the model was wrong and we corrected it" and "the model was right and someone
 * tidied up the record" — and every downstream number computed from AI
 * performance becomes unfalsifiable.
 *
 * So a review is an APPEND-ONLY DOCUMENT BESIDE the AI's answer, not an edit to
 * it. The incident keeps the machine's `aiConfidence`, `category`, and `urgency`
 * forever. The review records the human's own judgement, who made it, when, and
 * why. Both are readable side by side, which is the only arrangement in which
 * "the low-confidence queue is empty because humans reviewed it" is a statement
 * about reality.
 *
 * Four separate mechanisms enforce this, and removing any one leaves it open:
 *
 *   1. `assertNoAiResultInBody()` refuses a request naming `aiConfidence`,
 *      `aiRuns`, `triageSource`, `reviewedBy`, or `reviewedAt`.
 *   2. `adminReviewDecisionBodySchema` is `.strict()`, so those keys are not
 *      declared and an unrecognised key is a 400 naming the field.
 *   3. This service writes ONLY the fields listed in `APPLIED_FIELDS` below, so a
 *      future edit cannot spread a body into the document.
 *   4. `reviewedBy` is always `actor.uid`. It is never read from the input, so no
 *      body can sign someone else's name to a judgement.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND REVIEW IS A 409 AND NOT AN OVERWRITE
 * ---------------------------------------------------------------------------
 * Two reviewers opening the same incident is ordinary, not an attack. The second
 * one gets `409 REVIEW_ALREADY_RECORDED` and is shown the recorded decision. That
 * is deliberate: last-write-wins would let whoever clicked last erase the record of
 * the first judgement, and a queue that silently overwrites itself cannot be used
 * to measure reviewer disagreement.
 */

import 'server-only';

import { FieldValue, type DocumentData, type QueryDocumentSnapshot } from 'firebase-admin/firestore';

import { COLLECTIONS, SUB_COLLECTIONS } from '@/config/collections';
import { geminiConfig } from '@/lib/env.server';
import { AppError } from '@/lib/server/errors';
import { getAdminDb } from '@/lib/server/firebase-admin';
import { readBoolean, readNumber, readString, toIso } from '@/lib/server/serialize';
import { requireCapability } from '@/lib/server/permissions';
import { auditLogInTransaction } from '@/services/dispatch/audit';
import type { RequestContextLite } from '@/services/dispatch/lifecycle';
import type { AuthedUser } from '@/lib/server/auth-guard';
import type {
  AiReviewRecord,
  ReviewDecision,
  ReviewDispatchOutcome,
} from '@/validators/admin';
import type { AdminPage } from '@/services/admin/query';
import {
  buildFilters,
  deletedFilter,
  DOC_ID_TIEBREAK,
  inFilter,
  runPagedQuery,
} from '@/services/admin/query';

import type { IncidentCategory, IncidentStatus, Urgency } from '@/types/enums';

/* ========================================================================== */
/* The queue                                                                    */
/* ========================================================================== */

export type ReviewQueueRow = {
  readonly incidentId: string;
  readonly reference: string;
  readonly status: IncidentStatus;
  readonly category: IncidentCategory;
  readonly urgency: Urgency;
  /** The MODEL's confidence, exactly as recorded. Never the reviewer's opinion. */
  readonly aiConfidence: number;
  /** The threshold in force when this response was built. */
  readonly threshold: number;
  readonly summary: string;
  readonly createdAt: string | null;
  readonly reporterCount: number;
  readonly safetyFlags: readonly string[];
  /** `true` when a reviewer has already recorded a decision. */
  readonly reviewed: boolean;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
};

export type ReviewQueueResult = {
  readonly items: ReviewQueueRow[];
  readonly page: AdminPage;
  readonly threshold: number;
};

export type ListReviewQueueQuery = {
  readonly category?: readonly IncidentCategory[];
  readonly urgency?: readonly Urgency[];
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
};

/**
 * The incidents waiting for a human to look at the model's answer.
 *
 * Driven by `incidents.aiNeedsReview`, which is a SERVER-PROVIDED boolean
 * (docs/09 §2.8) rather than something recomputed here from `aiConfidence`.
 * That distinction matters: the flag is set by the triage path at the moment the
 * run completed, so it also captures the cases where triage FAILED and a fallback
 * ran, which a bare confidence comparison would miss entirely — an incident
 * triaged by fallback has no meaningful confidence and must still be reviewed.
 *
 * Sorted by `aiConfidence` ASCENDING, with the document id as tiebreak. Least
 * confident first is the queue an operator wants: if they only have time for two,
 * those are the two the model knew least about. Sorting newest-first would fill
 * the top of the queue with incidents triage already handled well.
 */
export async function listReviewQueue(
  actor: AuthedUser,
  query: ListReviewQueueQuery,
  context: RequestContextLite,
): Promise<ReviewQueueResult> {
  requireCapability(actor, 'r13_readAiTriagePanel', context);

  const threshold = reviewThreshold();
  const filters = buildFilters(
    { field: 'aiNeedsReview', op: '==', value: true },
    inFilter('category', query.category),
    inFilter('urgency', query.urgency),
    deletedFilter(undefined),
  );

  const page = await runPagedQuery<ReviewQueueRow>({
    collection: getAdminDb().collection(COLLECTIONS.incidents),
    filters,
    sort: ['aiConfidence', DOC_ID_TIEBREAK],
    limit: query.limit,
    cursor: query.cursor,
    fingerprintParts: {
      kind: 'review-queue',
      category: query.category,
      urgency: query.urgency,
      q: query.q,
    },
    serialize: (doc) => toQueueRow(doc, threshold),
  });

  return { items: page.items, page: page.page, threshold };
}

function toQueueRow(doc: QueryDocumentSnapshot<DocumentData>, threshold: number): ReviewQueueRow {
  const data = doc.data();
  const humanReview = readHumanReview(data);
  return {
    incidentId: doc.id,
    reference: readString(data, 'reference'),
    status: readString(data, 'status') as IncidentStatus,
    category: readString(data, 'category') as IncidentCategory,
    urgency: readString(data, 'urgency') as Urgency,
    aiConfidence: readNumber(data, 'aiConfidence') ?? 0,
    threshold,
    summary: readString(data, 'summary'),
    createdAt: toIso(data.createdAt),
    reporterCount: readNumber(data, 'reporterCount') ?? 0,
    safetyFlags: Array.isArray(data.safetyFlags) ? (data.safetyFlags as string[]) : [],
    reviewed: humanReview !== null,
    reviewedBy: humanReview?.reviewedBy ?? null,
    reviewedAt: humanReview?.reviewedAt ?? null,
  };
}

/* ========================================================================== */
/* The decision                                                                 */
/* ========================================================================== */

export type RecordReviewInput = {
  readonly incidentId: string;
  readonly decision: ReviewDecision;
  readonly reason: string;
  readonly note: string | null;
  readonly adjustment: {
    readonly urgency?: Urgency;
    readonly category?: IncidentCategory;
    readonly dispatchOutcome?: ReviewDispatchOutcome;
  } | null;
  readonly context: RequestContextLite;
};

export type RecordReviewResult = {
  readonly reviewId: string;
  readonly incidentId: string;
  readonly decision: ReviewDecision;
  /** The model's confidence at the moment of review. Frozen into the review doc. */
  readonly aiConfidenceAtReview: number;
  readonly thresholdAtReview: number;
  readonly noop: boolean;
};

/**
 * The ONLY incident fields a review may write.
 *
 * Mechanism 3 from the header comment. Every key is a field that RECORDS a human
 * judgement or clears a queue flag — none of them is a field the model wrote. If
 * a future change needs to write something else, it has to be added here
 * deliberately, in a file where the reason is visible, rather than arriving
 * through a spread.
 *
 * Note what is ABSENT: `aiConfidence`, `category`, `urgency`, `triageSource`,
 * `summary`. The reviewer's adjustment is recorded in the review document and in
 * `humanReview.*` — a parallel, clearly-labelled space — and deliberately does not
 * overwrite the incident's live triage fields. An operator who wants the incident
 * re-triaged edits it through `r21_editSummaryUrgencyCategory`, which is a
 * different capability, a different audit action, and an explicit statement that a
 * person is overriding the machine.
 */
const APPLIED_FIELDS = {
  aiNeedsReview: false,
  reviewedBy: null as string | null,
  reviewedAt: null as unknown,
  reviewedDecision: null as string | null,
  humanReview: null as Record<string, unknown> | null,
} as const;

/**
 * Record a reviewer's decision. Transactional, audited inside the transaction.
 *
 * Reads happen before writes, as Firestore requires: the incident is read, then the
 * existing reviews are queried, and only then is anything written. Querying a
 * subcollection inside a transaction is supported and is the only way to make
 * "already reviewed" a CHECK rather than a race — two concurrent submissions both
 * read an empty collection, but only one transaction commits, and the loser is
 * retried, re-reads, and finds the winner's review.
 */
export async function recordReviewDecision(
  actor: AuthedUser,
  input: RecordReviewInput,
): Promise<RecordReviewResult> {
  const { context } = input;
  requireCapability(actor, 'r23_editAiInfluencedFields', context);

  const threshold = reviewThreshold();
  const db = getAdminDb();
  let outcome: RecordReviewResult | null = null;

  try {
    await db.runTransaction(async (transaction) => {
      const incidentRef = db.collection(COLLECTIONS.incidents).doc(input.incidentId);
      const snap = await transaction.get(incidentRef);

      if (!snap.exists) {
        throw new AppError({ code: 'INCIDENT_NOT_FOUND', message: 'We could not find that incident.' });
      }

      const data = snap.data() as Record<string, unknown>;

      // A soft-deleted incident cannot be reviewed: the reviewer would be recording
      // a judgement about something that is no longer part of the world.
      if (data.deletedAt != null) {
        throw new AppError({ code: 'INCIDENT_NOT_FOUND', message: 'We could not find that incident.' });
      }

      /* --- reads complete; writes may begin ------------------------------ */

      // ORDER IS LOAD-BEARING. The "already reviewed" check must come BEFORE the
      // queue-membership check. Recording a review flips `aiNeedsReview` to false,
      // so a retried or concurrent decision would otherwise be rejected as
      // NOT_IN_REVIEW_QUEUE (422) — telling the operator to try again for a
      // request that can never succeed again, on an incident whose review is
      // already permanent. Checking the review log first lets the caller learn the
      // true thing: someone else's decision is on the record (409).
      //
      // Both of these are reads, and Firestore requires reads before writes, so
      // the swap is free.
      const reviewsQuery = incidentRef.collection(SUB_COLLECTIONS.aiReviews);
      const existing = await transaction.get(reviewsQuery);

      if (!existing.empty) {
        throw new AppError({
          code: 'REVIEW_ALREADY_RECORDED',
          message:
            'Someone has already reviewed this incident. Their decision is on the record and was not overwritten.',
        });
      }

      // Only incidents actually IN the queue may be reviewed. Reviewing a
      // confident triage would let a reviewer manufacture an audit entry that says
      // a human checked something the system never asked anyone to check.
      // Checked second precisely because "never queued" and "already reviewed" must
      // not collapse into the same answer.
      if (readBoolean(data, 'aiNeedsReview', false) !== true) {
        throw new AppError({
          code: 'NOT_IN_REVIEW_QUEUE',
          message: 'That incident is not waiting for AI review.',
        });
      }

      // Frozen copies of the machine's answer. These are what make the review
      // interpretable a year later: they record what the model said AT THE TIME,
      // so a later model change cannot retroactively alter what the reviewer was
      // responding to.
      const aiConfidenceAtReview = readNumber(data, 'aiConfidence');
      const reviewedAt = new Date().toISOString();

      const reviewRef = reviewsQuery.doc();
      transaction.set(reviewRef, {
        reviewId: reviewRef.id,
        incidentId: input.incidentId,
        decision: input.decision,
        reviewerUid: actor.uid,
        reviewerRole: actor.role,
        reviewedAt,
        reason: input.reason,
        note: input.note,
        adjustment: input.adjustment,
        aiConfidenceAtReview,
        thresholdAtReview: threshold,
        requestId: context.requestId,
        schemaVersion: 1,
        createdAt: FieldValue.serverTimestamp(),
      });

      transaction.update(incidentRef, {
        // Mechanism 3, applied literally. Only these keys.
        aiNeedsReview: APPLIED_FIELDS.aiNeedsReview,
        reviewedBy: actor.uid,
        reviewedAt: FieldValue.serverTimestamp(),
        reviewedDecision: input.decision,
        humanReview: {
          decision: input.decision,
          by: actor.uid,
          at: reviewedAt,
          reason: input.reason,
          ...(input.note === null ? {} : { note: input.note }),
          ...(input.adjustment === null ? {} : { adjustment: input.adjustment }),
        },
      });

      transaction.set(
        db.collection(COLLECTIONS.auditLogs).doc(),
        auditLogInTransaction({
          actorUid: actor.uid,
          actorRole: actor.role,
          action: input.decision === 'dismiss' ? 'ai.review.dismissed' : 'ai.review',
          entityType: 'aiReview',
          entityId: reviewRef.id,
          incidentRef: typeof data.reference === 'string' ? data.reference : null,
          summary: `AI triage ${input.decision} by a human reviewer.`,
          // The model's confidence, not the reviewer's — the audit row's value is
          // that it records what was being judged.
          before: { aiConfidence: aiConfidenceAtReview, aiNeedsReview: true },
          after: { aiNeedsReview: false },
          reason: input.reason,
          requestId: context.requestId,
          ipHash: context.ipHash,
          userAgent: context.userAgent,
        }),
      );

      outcome = {
        reviewId: reviewRef.id,
        incidentId: input.incidentId,
        decision: input.decision,
        aiConfidenceAtReview: aiConfidenceAtReview ?? 0,
        thresholdAtReview: threshold,
        noop: false,
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw error;
  }

  /* c8 ignore next 7 -- the transaction either assigns `outcome` or throws. */
  if (outcome === null) {
    throw new AppError({ code: 'DB_UNAVAILABLE', message: 'The database is temporarily unavailable.' });
  }
  return outcome;
}

/* ========================================================================== */
/* Reading recorded reviews                                                      */
/* ========================================================================== */

/**
 * Every review recorded for one incident, newest first.
 *
 * Server-only: `firestore.rules` denies every client read of
 * `incidents/{id}/aiReviews`, so this is the only way to see them. Used by the
 * incident detail view so a reviewer can read the previous decision before
 * arguing with it.
 */
export async function reviewsForIncident(incidentId: string): Promise<AiReviewRecord[]> {
  const snapshot = await getAdminDb()
    .collection(COLLECTIONS.incidents)
    .doc(incidentId)
    .collection(SUB_COLLECTIONS.aiReviews)
    .orderBy('reviewedAt', 'desc')
    .limit(50)
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    const adjustment = data.adjustment;
    return {
      reviewId: doc.id,
      incidentId,
      decision: readString(data, 'decision') as ReviewDecision,
      reviewerUid: readString(data, 'reviewerUid'),
      reviewedAt: toIso(data.reviewedAt) ?? new Date(0).toISOString(),
      reason: readString(data, 'reason'),
      note: typeof data.note === 'string' ? data.note : null,
      adjustment:
        typeof adjustment === 'object' && adjustment !== null
          ? (adjustment as AiReviewRecord['adjustment'])
          : null,
      aiConfidenceAtReview: readNumber(data, 'aiConfidenceAtReview'),
      thresholdAtReview: readNumber(data, 'thresholdAtReview') ?? 0.6,
    };
  });
}

/* ========================================================================== */
/* Helpers                                                                      */
/* ========================================================================== */

/**
 * The threshold in force RIGHT NOW.
 *
 * Read per request rather than cached at module load, because it is an env var an
 * operator may legitimately change, and a review recorded against a stale
 * threshold would claim the model was low-confidence when the current threshold
 * says it was not. `thresholdAtReview` is stored on every review so the judgement
 * is always reproducible.
 */
export function reviewThreshold(): number {
  return geminiConfig().confidenceReviewThreshold;
}

type HumanReviewSummary = {
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
};

function readHumanReview(data: Record<string, unknown>): HumanReviewSummary | null {
  const value = data.humanReview;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    reviewedBy: typeof record.by === 'string' ? record.by : null,
    reviewedAt: typeof record.at === 'string' ? record.at : null,
  };
}
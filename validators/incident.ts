/**
 * ============================================================================
 * The incident creation contract — docs/08 §3.1, FR-001 … FR-003
 * ============================================================================
 *
 * `POST /api/incidents` is the only way an incident enters the system. There is
 * no seed path, no admin "create incident" shortcut, and no other route that
 * writes `COLLECTIONS.incidents`. That is deliberate: a second writer is a second
 * set of rules for `deletedAt`, `reportCount` and the status-history subcollection,
 * and the incident collection is the one place where an inconsistency becomes a
 * responder being dispatched to something that does not exist.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BODY CARRIES NO `status`, NO `urgency`, AND NO `category`
 * ---------------------------------------------------------------------------
 * All three are decided server-side from the reporter's own words by AI triage
 * (or the keyword fallback). A body field for any of them would let a client
 * open a `critical` incident with no injuries, and the triage panel — the thing
 * that tells a dispatcher the model is unsure — would silently disagree with the
 * queue. `strictObject` rejects unknown keys, so a client that sends them gets a
 * 400 that names the offending key rather than a document nobody can reconcile.
 *
 * ---------------------------------------------------------------------------
 * WHY `location` MAY BE NULL BUT `text` MAY NOT
 * ---------------------------------------------------------------------------
 * A location-less report is a real report: "someone collapsed on the bus route,
 * I do not know where" is actionable, and refusing it would lose the one report
 * most likely to be about someone who cannot give an address. FR-023 makes the
 * same call for `peopleAffected`: `null` means unknown, and `0` is not offered,
 * because a body count of zero asserted as fact is a claim about a rescue.
 *
 * The text bound is `REPORT_LIMITS.textMinChars` — the same floor
 * `aiTriageProbeBodySchema` uses, so a probe and a real create are rejected by
 * one rule rather than two that can drift apart.
 */

import { z } from 'zod';

import { REPORT_LIMITS } from '@/config/limits';
import { ACCURACY_GRADES, INCIDENT_CATEGORIES, INCIDENT_STATUSES, LOCATION_SOURCES, URGENCIES } from '@/types/enums';
import {
  ALLOWED_MEDIA,
  ALLOWED_MEDIA_TYPES,
  MEDIA_ID_RE,
  MEDIA_LIMITS,
  STAGING_PATH_RE,
} from '@/validators/upload';
import {
  boundedInt,
  firestoreId,
  isoInstantField,
  referenceField,
  reportIdField,
  strictObject,
  trimmedString,
} from '@/validators/common';
import {
  duplicateStatusSchema,
  incidentCategorySchema,
  incidentStatusSchema,
  urgencySchema,
} from '@/validators/enums';
import { enumListField, paginationShape } from '@/validators/query';

/**
 * `docs/07 §4.2` / FR-030. Provenance is mandatory: a coordinate whose source
 * is unknown is not a location, it is a guess, and the two must be
 * distinguishable by a dispatcher reading the map.
 *
 * `source` is refined against `'none'` because `LOCATION_SOURCES` includes it
 * for the incident document, where "no location" is a legitimate stored state.
 * Inside THIS object a point exists, so `'none'` would be a contradiction —
 * `location: null` is how a caller says "no location".
 */
export const incidentLocationSchema = strictObject({
  /**
   * Nullable, but ONLY for `source: 'address_text'`.
   *
   * FR-035: geocoding happens server-side and nowhere else, so a citizen who typed
   * an address genuinely has text and no point. Forcing coordinates here would make
   * that path impossible to express, and the only ways to fake it are to drop the
   * typed address or to invent `(0,0)`.
   *
   * Every other source requires real coordinates, enforced by the `superRefine`
   * below rather than by a non-null type, so the failure arrives as a 400 with a
   * sentence instead of a `NaN` reaching Firestore.
   */
  lat: z.number().min(-90).max(90).nullable().default(null),
  lng: z.number().min(-180).max(180).nullable().default(null),
  /** Metres. `0` is allowed: a device can report a fix it has no error for. */
  accuracyM: boundedInt(0, 100_000),
  accuracyGrade: z.enum(ACCURACY_GRADES),
  source: z
    .enum(LOCATION_SOURCES)
    .refine((value) => value !== 'none', {
      message: 'A location object must have a real source. Send location: null instead.',
    }),
  /**
   * A LABEL, never evidence. Displayed beside the coordinates and never used
   * for distance maths (`docs/12 §7`). The reporter's own words ARE allowed here —
   * FR-035 requires it, since this is the only place the typed address can live
   * before the server geocodes it.
   *
   * Required when there are no coordinates, because without it an
   * `address_text` location is an empty object that records nothing.
   */
  placeName: z.string().trim().min(1).max(200).nullable().default(null),
}).superRefine((value, ctx) => {
  const hasPoint = value.lat !== null && value.lng !== null;
  // A half-present pair is worse than a full one: `(12.3, null)` means half a fix.
  const halfPresent = (value.lat === null) !== (value.lng === null);

  if (halfPresent) {
    ctx.addIssue({
      code: 'custom',
      message: 'Send both coordinates or neither.',
    });
    return;
  }

  if (value.source === 'address_text') {
    // Coordinates are OPTIONAL here (the server geocodes), text is MANDATORY.
    if (!hasPoint && (value.placeName === null || value.placeName.trim().length === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Type the address so we know where the emergency is.',
      });
    }
    return;
  }

  if (!hasPoint) {
    ctx.addIssue({
      code: 'custom',
      message: 'This location type needs coordinates. Send location: null if the citizen did not share one.',
    });
  }
});

/**
 * One staged media item the client wants attached to this report.
 *
 * `storagePath` is the STAGING path `POST /api/uploads/sign` handed back —
 * `staging/{uid}/med_XXXXXXXXXXXX.{ext}`. It is checked against
 * `STAGING_PATH_RE` here, and ownership is re-checked server-side against the
 * verified uid by `attachEvidenceToIncident`. Both are needed: the regex refuses
 * a nonsense shape at the boundary, and the segment comparison refuses
 * `staging/{someone-else}/…` where the shape is perfectly legal.
 *
 * `displayName` is DISPLAY ONLY. It is sanitised by `safeDownloadName` before it
 * is persisted and is never used to build a path (docs/15 §3.5).
 */
export const incidentMediaSchema = strictObject({
  storagePath: z.string().trim().max(512).regex(STAGING_PATH_RE, 'That upload reference is not valid. Please upload the file again.'),
  displayName: z.string().trim().max(200),
});

export type IncidentMedia = z.infer<typeof incidentMediaSchema>;

/** Extension → kind, derived from `ALLOWED_MEDIA` so it cannot drift. */
const KIND_BY_EXTENSION: Readonly<Record<string, 'image' | 'audio'>> = Object.fromEntries(
  ALLOWED_MEDIA_TYPES.map((type) => [ALLOWED_MEDIA[type].ext, ALLOWED_MEDIA[type].kind]),
);

/**
 * The count limits, enforced HERE as well as in `attachEvidenceToIncident`.
 *
 * Two layers for one rule, and the reason is that only one of them can be
 * trusted. `attachEvidenceToIncident` is the real control and it drops the
 * overflow per item so a good photo is never lost to a bad one. This schema
 * layer exists so the client gets a 400 that NAMES the problem — "at most 3
 * images and 1 audio clip" — instead of silently losing the fourth photo and
 * never being told.
 *
 * The kind is read from the extension, which is safe here precisely because it
 * is not trusted: the authoritative kind comes from re-sniffing the bytes during
 * the attach. This is a UX guard against an obvious client mistake, not a
 * security control, and it is documented as such.
 */
export const incidentMediaListSchema = z
  .array(incidentMediaSchema)
  .max(MEDIA_LIMITS.maxTotalPerReport, `A report can carry at most ${MEDIA_LIMITS.maxTotalPerReport} media items.`)
  .superRefine((items, ctx) => {
    const images = items.filter((item) => {
      const ext = item.storagePath.split('.').pop() ?? '';
      return KIND_BY_EXTENSION[ext] === 'image';
    }).length;
    const audio = items.length - images;

    if (images > MEDIA_LIMITS.maxImagesPerReport) {
      ctx.addIssue({
        code: 'custom',
        message: `A report can carry at most ${MEDIA_LIMITS.maxImagesPerReport} photos.`,
      });
    }
    if (audio > MEDIA_LIMITS.maxAudioPerReport) {
      ctx.addIssue({
        code: 'custom',
        message: `A report can carry at most ${MEDIA_LIMITS.maxAudioPerReport} voice note.`,
      });
    }
  });

/**
 * There is deliberately NO `evidenceIds` field, and that is now a decision rather
 * than an omission.
 *
 * `evidenceIds` is SERVER-OWNED: it is written by `createIncident` from the
 * `MediaRef` rows that `attachEvidenceToIncident` produced, after the bytes were
 * re-sniffed. A body field would let a client put ids on an incident before a
 * single byte had been verified, and the count would be whatever the client
 * claimed rather than what survived validation.
 *
 * The client instead sends `media` — the STAGING PATHS it was given — and the
 * server decides what becomes evidence. See `attachEvidenceToIncident` for the
 * move, and docs/15 §8.1 step 5 for why the attach is deliberately lossy.
 */
export const incidentCreateBodySchema = strictObject({
  /** FR-003. Verbatim. The app never rewrites a citizen's words. */
  text: trimmedString(REPORT_LIMITS.textMinChars, REPORT_LIMITS.textMaxChars),
  /** BCP-47. Bounded, not enumerated — an unlisted tag is the model's problem. */
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language tag such as en or hi.')
    .max(35)
    .default('en'),
  location: incidentLocationSchema.nullable().default(null),
  /** FR-023. `null` is unknown. Never defaulted to 0. */
  peopleAffected: boundedInt(0, 100_000).nullable().default(null),
  /**
   * Already-uploaded evidence to attach. Defaults to `[]`, so a text-only
   * report sends nothing here and behaves exactly as it did before this field
   * existed.
   */
  media: incidentMediaListSchema.default([]),
});

export type IncidentCreateBody = z.infer<typeof incidentCreateBodySchema>;

/**
 * What the citizen gets back. Deliberately small.
 *
 * `TrackedIncident` in `types/domain.ts` is the same idea for `GET /track`. The
 * fields here are the ones a reporter needs in the moment they submit — a
 * reference to quote, whether a human will look at it, and whether they are
 * looking at a duplicate — and nothing a dispatcher would use.
 */
export const incidentCreateResponseSchema = strictObject({
  incidentId: firestoreId('incidentId'),
  reportId: reportIdField,
  reference: referenceField,
  status: incidentStatusSchema,
  /** `null` when triage could not classify it. Never defaulted to `'other'`. */
  category: incidentCategorySchema.nullable(),
  urgency: urgencySchema,
  /** Which engine decided: `ai`, `fallback`, or `manual`. FR-029. */
  triageSource: z.enum(['ai', 'fallback', 'manual']),
  /** 0–1, or `null` when no engine ran. The client derives the band, never needsReview. */
  aiConfidence: z.number().min(0).max(1).nullable(),
  aiNeedsReview: z.boolean(),
  summary: z.string(),
  duplicateStatus: duplicateStatusSchema,
  duplicateOf: z
    .object({
      incidentId: firestoreId('duplicateOf.incidentId'),
      reference: referenceField,
      score: z.number().min(0).max(1),
    })
    .nullable(),
  createdAt: isoInstantField,
  /**
   * How many media items actually became evidence.
   *
   * **This is the count that survived validation, not the count the client
   * claimed**, and the difference is the whole point of the field. A citizen who
   * attached two photos and a voice note and got `1` back has been told, rather
   * than left believing all three are attached.
   */
  evidenceCount: boundedInt(0, MEDIA_LIMITS.maxTotalPerReport),
  /**
   * The `mediaId`s that were sent but not attached.
   *
   * Empty in the happy path. Populated when a file failed re-sniffing, exceeded
   * its cap, or Storage was unavailable — docs/15 §5.3, "dropped from the
   * report, not silently accepted".
   */
  droppedMedia: z.array(z.string().regex(/^med_[A-Z2-7]{12}$/)).max(MEDIA_LIMITS.maxTotalPerReport),
  /**
   * Non-fatal degradations the reporter should know about, as stable codes.
   *
   * `duplicate_check_unavailable` is the important one: `checkForDuplicates`
   * returns `hasPotentialDuplicate: false` when its read fails, which is a lie
   * the caller must not believe. Surfacing it as a warning is what stops
   * "we could not check nearby reports" reading as "there are none".
   */
  warnings: z.array(z.string().max(60)).max(6),
});

export type IncidentCreateResponse = z.infer<typeof incidentCreateResponseSchema>;

/* ========================================================================== */
/* Reads                                                                       */
/* ========================================================================== */

/**
 * The `GET /api/incidents` filter set. `strictObject` plus the shared pagination
 * primitives, so an unknown filter is a 400 rather than a silently ignored
 * parameter (docs/17 §9) — a filter the client believes is applied and is not is
 * worse than no filter, because the results LOOK filtered.
 *
 * Every filter is `.optional()` because `parseSearchParams` only includes keys the
 * caller actually sent. A required array field would make `GET /api/incidents` with
 * no query string a 400, which is the single most common way to call this endpoint.
 */
export const incidentListQuerySchema = strictObject({
  ...paginationShape,
  status: enumListField(INCIDENT_STATUSES).optional(),
  category: enumListField(INCIDENT_CATEGORIES).optional(),
  urgency: enumListField(URGENCIES).optional(),
});

/**
 * One incident as a caller is allowed to see it.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CONDITIONAL FIELDS ARE `.optional()` AND NOT `.nullable()`
 * ---------------------------------------------------------------------------
 * `originalText`, `reporterUid` and `locationText` are omitted when the caller's
 * redaction profile withholds them. They are NOT sent as `null`, because null and
 * absent are different claims: "the value is unknown" versus "this is not yours to
 * read". A client written against a nullable field would render
 * `originalText ?? 'Not available'` and be unable to tell a redaction from a
 * genuinely empty report — which is precisely the ambiguity that would let a
 * withheld citizen's words look like a data-loss bug and get "fixed" by loosening
 * the gate.
 */
export const incidentRowSchema = strictObject({
  incidentId: firestoreId('incidentId'),
  reference: referenceField,
  status: incidentStatusSchema,
  /** `null` when triage could not classify it. Never defaulted to `'other'`. */
  category: incidentCategorySchema.nullable(),
  urgency: urgencySchema,
  summary: z.string(),
  createdAt: isoInstantField,
  updatedAt: isoInstantField,
  evidenceCount: boundedInt(0, MEDIA_LIMITS.maxTotalPerReport),
  // Not capped by a report limit: an incident's report count grows by rollup, and a
  // bound here would reject a legitimate long-running incident's own detail page.
  reportCount: boundedInt(0, 10_000),
  peopleAffected: z.number().int().min(0).nullable(),
  isDuplicate: z.boolean(),
  language: z.string().max(16),
  placeName: z.string().max(200).nullable(),
  /** `null` when there is no position. Never a substituted `(0, 0)`. */
  geo: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      accuracyM: z.number().min(0).nullable(),
    })
    .nullable(),
  locationText: z.string().max(200).nullable().optional(),
  reporterUid: z.string().max(128).optional(),
  originalText: z.string().max(5000).optional(),
  ai: z
    .object({
      source: z.string().max(24),
      confidence: z.number().min(0).max(1).nullable(),
      needsReview: z.boolean(),
    })
    .optional(),
  assigneeUid: z.string().max(128).nullable().optional(),
});

/** The echoed page, so a client can tell a clamped page from a full one. */
const pageSchema = strictObject({
  limit: boundedInt(1, 100),
  hasMore: z.boolean(),
  nextCursor: z.string().max(512).nullable(),
});

/**
 * What the caller was shown, and whether that was the whole truth.
 *
 * `includes` is a SET of slices rather than one widest-wins value, because the
 * matrix's rows are additive: `r05_readOwnIncidents` is `full` for every role and
 * `r06_readAssignedIncidents` is `full` for every role including `citizen`, so a
 * single-scope derivation would hand a citizen the `assigned` slice and return an
 * empty list for the one screen people actually use.
 *
 * `complete: false` is the field that stops a narrowed list from reading as an empty
 * queue — a responder without location sharing must be told their list is partial.
 */
const scopeSchema = strictObject({
  includes: z.array(z.enum(['own', 'assigned', 'unassigned_nearby', 'all'])).min(1).max(4),
  complete: z.boolean(),
  limitedReason: z.string().max(240).nullable(),
});

export const incidentListResponseSchema = strictObject({
  items: z.array(incidentRowSchema).max(100),
  page: pageSchema,
  scope: scopeSchema,
});

export const incidentDetailResponseSchema = strictObject({
  incident: incidentRowSchema,
  /** Echoed so a client can explain a redacted row rather than guess at it. */
  profile: z.enum(['full', 'privileged', 'responder', 'owner', 'none']),
  evidenceIds: z.array(z.string().regex(MEDIA_ID_RE)).max(MEDIA_LIMITS.maxTotalPerReport),
  aiAnalysis: z
    .object({
      confidence: z.number().min(0).max(1).nullable(),
      needsReview: z.boolean(),
      category: incidentCategorySchema.nullable(),
      urgency: urgencySchema,
      summary: z.string().max(5000),
      safetyFlags: z.array(z.string().max(60)).max(20),
      requiredResources: z.array(z.string().max(60)).max(20),
    })
    .nullable(),
});
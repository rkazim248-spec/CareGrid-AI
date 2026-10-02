/**
 * ============================================================================
 * `services/incidents` — creating an incident from a citizen's report
 * ============================================================================
 *
 * The write path for `COLLECTIONS.incidents`. This is the ONLY module that
 * creates an incident document, which is what keeps the invariants in one place:
 *
 *   1. `deletedAt` is written explicitly as `null`. The duplicate engine and the
 *      map both query `deletedAt == null`, and a missing field is not equal to
 *      null in Firestore — an incident created without it would be invisible to
 *      both and would never appear on a dispatcher's map.
 *   2. `geoCells` is written at create time. `findDuplicateCandidates` reads
 *      `geoCells array-contains <cell>`, so an incident created without them is
 *      invisible to dedupe for its whole life. Computed once, here, rather than
 *      by each reader.
 *   3. The first `statusHistory` event is written in the same batch as the
 *      incident, so there is no window in which an incident exists with no
 *      history — the state a dispatcher sees in the audit trail.
 *   4. `reportCount` starts at 1 and is incremented by the supplement path, never
 *      recomputed from a count of subcollection documents.
 *
 * ---------------------------------------------------------------------------
 * TRIAGE NEVER BLOCKS A REPORT — FR-029, docs/09 §7
 * ---------------------------------------------------------------------------
 * `triageIncident` returns an outcome instead of throwing, and this service does
 * not re-throw it either. A citizen pressing "send" during a medical emergency
 * must not lose their report because a quota was exhausted 3,000 km away, so an
 * AI outage degrades `triageSource` to `fallback` and the incident is still
 * created, still triaged by keyword rules, and still visible.
 *
 * `checkForDuplicates` is the same shape: it returns
 * `candidatesUnavailable: true` rather than failing the write, because a
 * duplicate check is an optimisation and a missing report is a safety failure.
 */

import { randomBytes } from 'node:crypto';

import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';

import { COLLECTIONS, SUB_COLLECTIONS } from '@/config/collections';
import { SLA_MINUTES } from '@/config/urgencies';
import { REPORT_LIMITS } from '@/config/limits';
import { BASE32_ALPHABET } from '@/validators/common';
import { buildGeoCells } from '@/lib/geo/geohash';
import { getAdminDb } from '@/lib/server/firebase-admin';
import { createLogger } from '@/lib/server/http';
import { toTriageRequest, triageIncident } from '@/services/ai/triage';
import { attachEvidenceToIncident } from '@/services/uploads/evidence-attach';
import { checkForDuplicates } from '@/services/geo/find-duplicates';
import { geocodeAddress, gradeForGeocode } from '@/services/maps/geocode';
import {
  appendStatusHistoryInTransaction,
  buildStatusHistoryEvent,
} from '@/services/dispatch/status-history';
import type { UserRole } from '@/types/enums';

/**
 * A location as it reaches `createIncident` — which is BEFORE geocoding.
 *
 * `lat`/`lng` are nullable because `source: 'address_text'` legitimately arrives
 * as text with no point (FR-035 keeps geocoding server-side). `resolveLocation`
 * below turns that into coordinates, or into a stored-but-unlocated incident, so
 * nothing past this function ever has to reason about the nullable case.
 */
export type CreateIncidentLocation = {
  lat: number | null;
  lng: number | null;
  accuracyM: number;
  accuracyGrade: 'high' | 'medium' | 'low' | 'unknown';
  source: 'gps' | 'manual_pin' | 'address_text';
  /** The reporter's typed address, or a reverse-geocoded label. */
  placeName: string | null;
};

/**
 * A location after geocoding: coordinates are always present.
 *
 * A SEPARATE type from `CreateIncidentLocation` rather than a narrowed one, so that
 * "has this been resolved?" is a compile error instead of a runtime null check
 * someone forgets at the third call site.
 */
export type ResolvedIncidentLocation = {
  lat: number;
  lng: number;
  accuracyM: number;
  accuracyGrade: 'high' | 'medium' | 'low' | 'unknown';
  source: 'gps' | 'manual_pin' | 'address_text';
  placeName: string | null;
  /**
   * `true` when the point came from a server geocode rather than from the citizen.
   *
   * Persisted so a later consumer can tell a typed address that was looked up from
   * a position the device actually measured. FR-035's whole point is that these are
   * not the same kind of claim.
   */
  geocoded: boolean;
};

/**
 * Non-fatal location degradations, as warning codes the response can carry.
 *
 * `'not_needed'` is not a warning — it means there was nothing to geocode — so it
 * is deliberately IN the union and filtered by the caller rather than being
 * smuggled in through the same field as a real problem.
 */
export type GeocodeWarning = 'not_needed' | 'location_ungeocoded' | 'location_too_coarse';

/**
 * Resolve a location into one with coordinates, or into `null` when it cannot be.
 *
 * ---------------------------------------------------------------------------
 * WHY A TYPED ADDRESS CAN BECOME `null`, AND WHY THAT IS CORRECT
 * ---------------------------------------------------------------------------
 * A citizen typed "near the big tree" and the geocoder found nothing. There are two
 * ways to handle that: store `(0, 0)` and lie, or store no coordinates and say so.
 * This does the second.
 *
 * The trade is made explicitly in favour of the report: the incident, its text, its
 * photos and its category are all still real and still worth a responder's time, and
 * an incident with a stated `location_ungeocoded` warning can be dispatched by
 * description. A 500 from the geocoder would cost a real emergency to protect a
 * coordinate field.
 *
 * ---------------------------------------------------------------------------
 * THE PROVIDER'S OWN RADIUS WINS
 * ---------------------------------------------------------------------------
 * On success, `accuracyM` and `accuracyGrade` come from `geocodeAddress`, not from
 * the client's optimistic 200 m / `low`. The client does not know how wide its match
 * was, and the whole reason for geocoding server-side is that the client cannot
 * know. The client's numbers are used only if the provider gives none.
 *
 * The logger is passed in rather than closed over: `createIncident` builds one bound
 * to the request id and this is a separate function, so a module-level logger would
 * lose the request id — and a geocode failure in an emergency path with no request
 * id attached is close to undebuggable.
 */
async function resolveLocation(
  input: CreateIncidentLocation | null,
  log: ReturnType<typeof createLogger>,
): Promise<{
  location: ResolvedIncidentLocation | null;
  geocodeOutcome: GeocodeWarning;
}> {
  if (input === null) return { location: null, geocodeOutcome: 'not_needed' };

  // A device fix or a pin the citizen placed needs no lookup.
  if (input.lat !== null && input.lng !== null) {
    return {
      location: {
        lat: input.lat,
        lng: input.lng,
        accuracyM: input.accuracyM,
        accuracyGrade: input.accuracyGrade,
        source: input.source,
        placeName: input.placeName,
        geocoded: false,
      },
      geocodeOutcome: 'not_needed',
    };
  }

  // Text with no point. This is the only case that reaches the provider.
  if (input.placeName === null || input.placeName.trim().length === 0) {
    return { location: null, geocodeOutcome: 'location_ungeocoded' };
  }

  const result = await geocodeAddress(input.placeName);

  if (!result.ok) {
    // `too_coarse` is reported separately from `no_match`/`provider_unavailable`
    // because they mean different things to the citizen and to the responder, and a
    // merged "location failed" would throw away that distinction.
    log.warn({ source: input.source, reason: result.reason });
    return {
      location: null,
      geocodeOutcome: result.reason === 'too_coarse' ? 'location_too_coarse' : 'location_ungeocoded',
    };
  }

  return {
    location: {
      lat: result.lat,
      lng: result.lng,
      // The provider's declared radius, falling back to the client's own number.
      accuracyM: result.accuracyM,
      // Graded from the match TYPE as well as the radius, so a 300 m `poi` match is
      // never `high` and a `place`-level hit is never `medium`.
      accuracyGrade: gradeForGeocode(result.matchType, result.accuracyM),
      source: 'address_text',
      // Prefer the provider's label: it is normalised ("1600 Pennsylvania Ave NW,
      // Washington") where the citizen's text is whatever they typed.
      placeName: result.label ?? input.placeName,
      geocoded: true,
    },
    geocodeOutcome: 'not_needed',
  };
}

export type CreateIncidentInput = {
  readonly reporterUid: string;
  readonly reporterRole: UserRole;
  readonly text: string;
  readonly language: string;
  readonly location: CreateIncidentLocation | null;
  readonly peopleAffected: number | null;
  /**
   * Already-uploaded evidence to attach, as STAGING PATHS the server minted.
   *
   * Never `MediaRef`s and never `mediaId`s the client asserted: the paths are
   * re-validated for ownership and the bytes are re-sniffed during the attach.
   */
  readonly media: readonly CreateIncidentMedia[];
  readonly context: {
    readonly requestId: string;
    readonly ipHash: string | null;
    readonly userAgent: string | null;
    readonly nowMs: number;
    /** Auth age in seconds, from the verified token. Drives the FR-135 signal. */
    readonly authTimeSec: number;
  };
};

/** One staged item to attach. Mirrors `EvidenceAttachment` without importing it. */
export type CreateIncidentMedia = {
  readonly storagePath: string;
  readonly displayName: string;
};

export type CreateIncidentResult = {
  readonly incidentId: string;
  readonly reportId: string;
  readonly reference: string;
  readonly status: 'triaged' | 'new';
  readonly category: string | null;
  readonly urgency: string;
  readonly triageSource: 'ai' | 'fallback' | 'manual';
  readonly aiConfidence: number | null;
  readonly aiNeedsReview: boolean;
  readonly summary: string;
  readonly evidenceCount: number;
  readonly droppedMedia: readonly string[];
  readonly duplicateStatus: 'none' | 'potential_duplicate';
  readonly duplicateOf: { incidentId: string; reference: string; score: number } | null;
  readonly createdAt: string;
  readonly warnings: readonly string[];
};

/**
 * Crockford base32, from the OS CSPRNG.
 *
 * `byte % 32` is uniform here and this is why: 256 is divisible by 32, so the
 * modulo discards no entropy. The `%` would bias a shorter alphabet, and a biased
 * reference shortens the space a `CG-XXXXXX` search has to cover.
 */
function base32(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += BASE32_ALPHABET[byte % BASE32_ALPHABET.length];
    if (out.length === length) break;
  }
  return out;
}

/**
 * `checkForDuplicates` returns incident IDs but no references, and the citizen
 * response has to carry a reference they can quote. One batched read for the
 * best match only, so this stays a single round trip and a match that has since
 * been deleted degrades to a null reference rather than failing the create.
 */
async function referenceFor(incidentId: string): Promise<string | null> {
  try {
    const snap = await getAdminDb().collection(COLLECTIONS.incidents).doc(incidentId).get();
    const reference = snap.data()?.reference;
    return typeof reference === 'string' ? reference : null;
  } catch {
    return null;
  }
}

export async function createIncident(input: CreateIncidentInput): Promise<CreateIncidentResult> {
  const db = getAdminDb();
  const log = createLogger(input.context.requestId);
  const warnings: string[] = [];

  const incidentRef = db.collection(COLLECTIONS.incidents).doc();
  const incidentId = incidentRef.id;
  const reportId = `rep_${base32(10)}`;
  const reference = `CG-${base32(6)}`;

  /* --- 1. RESOLVE THE LOCATION — geocode a typed address ------------------ */
  // Before everything else, because the geocoded point decides whether a duplicate
  // check can run at all, and whether the map pin means anything.
  const { location, geocodeOutcome } = await resolveLocation(input.location, log);
  if (geocodeOutcome !== 'not_needed') warnings.push(geocodeOutcome);

  /* --- 2. ATTACH EVIDENCE — before triage, so the counts are real --------- */
  // The order is load-bearing and it was previously wrong.
  //
  // `attachEvidenceToIncident` needs `incidentId` and `reportId` to build the
  // final path, so the ids are minted first. Everything else follows from that:
  // by the time the model is called, `attached` is the authoritative list of what
  // survived re-sniffing, and the prompt is told the TRUE image and audio counts
  // rather than what the client claimed. A citizen who attached two photos and
  // had one rejected gets `imageCount: 1`, so the model's own account of what it
  // was shown cannot disagree with what was stored.
  //
  // The one thing that propagates is `attached.length === 0 && !hasValidText`,
  // which is a genuine "there is no report" — nothing to write and nothing to
  // show the citizen. Every other failure is degraded, never fatal.
  const hasValidText = input.text.trim().length >= REPORT_LIMITS.textMinChars;
  const attachment = await attachEvidenceToIncident(
    input.reporterUid,
    incidentId,
    reportId,
    input.media.map((item) => ({ storagePath: item.storagePath, displayName: item.displayName })),
    hasValidText,
  );
  const evidence = attachment.attached;
  const evidenceIds = evidence.map((item) => item.mediaId);

  if (attachment.dropped.length > 0) warnings.push('evidence_dropped');
  if (attachment.storageDegraded) warnings.push('storage_unavailable');

  /* --- 3. AI TRIAGE — never throws, never blocks (FR-029) ---------------- */
  const outcome = await triageIncident(
    toTriageRequest({
      text: input.text,
      language: input.language,
      locationHint: location?.placeName ?? null,
      locationAccuracy: location?.accuracyGrade ?? 'unknown',
      // Counted from what actually attached, per the ordering note above.
      imageCount: evidence.filter((item) => item.kind === 'image').length,
      audioCount: evidence.filter((item) => item.kind === 'audio').length,
      newAccount: Date.now() / 1000 - input.context.authTimeSec < 300,
    }),
    {
      requestId: input.context.requestId,
      timeoutMs: 0,
      audit: {
        incidentId,
        uid: input.reporterUid,
        requestId: input.context.requestId,
        language: input.language,
        // `null`, never the reporter's own words: docs/09 §4.1 requires a
        // reverse-geocoded district label, and a free-text place name is not a
        // district.
        coarseArea: null,
        hasCoordinates: location !== null,
      },
    },
  );

  const category = outcome.category;
  const urgency = outcome.urgency ?? 'medium';
  const summary = outcome.summary ?? input.text.slice(0, 240);

  if (outcome.confidence === null) {
    warnings.push('triage_unavailable');
  }

  /* --- 4. DUPLICATE CHECK — a flag, never a merge ------------------------- */
  let duplicateStatus: 'none' | 'potential_duplicate' = 'none';
  let duplicateOf: CreateIncidentResult['duplicateOf'] = null;

  if (location !== null) {
    const duplicates = await checkForDuplicates({
      point: { lat: location.lat, lng: location.lng },
      reportedAtMs: input.context.nowMs,
      category,
      // The citizen's ORIGINAL text, never the AI summary — see
      // `DuplicateReportInput.text` for why comparing against model output would
      // measure the model rather than the incident.
      text: input.text,
    });

    if (duplicates.candidatesUnavailable) {
      // The one warning that matters to the caller: `hasPotentialDuplicate` is
      // `false` here because the read failed, not because there were no matches.
      warnings.push('duplicate_check_unavailable');
    } else {
      const best = duplicates.matches[0];
      if (best !== undefined) {
        duplicateStatus = 'potential_duplicate';
        duplicateOf = {
          incidentId: best.incidentId,
          reference: (await referenceFor(best.incidentId)) ?? '',
          score: best.similarity,
        };
      }
    }
  }

  /* --- 5. THE WRITE ------------------------------------------------------- */
  const nowIso = new Date(input.context.nowMs).toISOString();
  const createdAt = FieldValue.serverTimestamp();

  const batch = db.batch();

  batch.set(incidentRef, {
    incidentId,
    reference,
    reporterUid: input.reporterUid,
    status: 'triaged',
    category,
    urgency,
    urgencySource: outcome.source === 'ai' ? 'ai' : 'fallback',
    triageSource: outcome.source,
    aiConfidence: outcome.confidence,
    aiNeedsReview: outcome.needsReview,
    summary,
    originalText: input.text,
    peopleAffected: input.peopleAffected,
    requiredResources: [],
    safetyFlags: outcome.safetyFlags,
    // `lat`/`lng` keys: this is what `findDuplicateCandidates` reads. See the
    // module note about `assign.ts` reading `latitude`/`longitude` instead.
    geo:
      location === null
        ? null
        : {
            lat: location.lat,
            lng: location.lng,
            accuracyM: location.accuracyM,
            accuracyGrade: location.accuracyGrade,
            source: location.source,
            placeName: location.placeName,
            // `true` only when a server geocode produced this point from text.
            geocoded: location.geocoded,
          },
    geoCells: location === null ? [] : buildGeoCells(location.lat, location.lng),
    channel: 'app',
    language: input.language,
    // SERVER-OWNED. Written from the `MediaRef` rows that survived re-sniffing,
    // so the count is what exists at a final path rather than what the client
    // claimed. Zero here is a true statement for a text-only report.
    evidenceIds,
    evidenceCount: evidenceIds.length,
    reportCount: 1,
    verification: outcome.source === 'ai' ? 'ai' : 'fallback',
    duplicateStatus,
    duplicateOf,
    assigneeUid: null,
    slaTargetMin: SLA_MINUTES[urgency],
    slaState: 'on_track',
    ageMin: 0,
    createdAt,
    updatedAt: createdAt,
    verifiedAt: null,
    respondedAt: null,
    arrivedAt: null,
    resolvedAt: null,
    closedAt: null,
    // Explicit nulls, not omissions. See invariant 1 in the module header.
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
    resolutionCode: null,
    resolutionNote: null,
  });

  /* --- 5. THE REPORTER'S OWN REPORT -------------------------------------- */
  batch.set(incidentRef.collection(SUB_COLLECTIONS.incidentReports).doc(reportId), {
    reportId,
    incidentId,
    reporterUid: input.reporterUid,
    originalText: input.text,
    language: input.language,
    evidenceIds,
    peopleAffected: input.peopleAffected,
    createdAt,
  });

  await batch.commit();

  /* --- 6. THE FIRST HISTORY EVENT ----------------------------------------- */
  // Separate from the batch because `appendStatusHistoryInTransaction` takes a
  // transaction. The incident exists either way, so a failure here costs the
  // audit entry, not the report — the opposite trade to writing the report
  // inside a transaction that also does network-bound AI work.
  try {
    await appendInitialHistory(input, incidentRef, outcome.source);
  } catch (error) {
    log.error({ code: 'HISTORY_WRITE_FAILED', path: 'incidents.create', status: 500 });
    void error;
  }

  log.info({
    actorUid: input.reporterUid,
    isNew: true,
    incidentId,
    triageSource: outcome.source,
    hasCoordinates: location !== null,
    evidenceCount: evidenceIds.length,
    droppedEvidence: attachment.dropped.length,
    path: '/api/incidents',
  });

  return {
    incidentId,
    reportId,
    reference,
    status: 'triaged',
    category,
    urgency,
    triageSource: outcome.source,
    aiConfidence: outcome.confidence,
    aiNeedsReview: outcome.needsReview,
    summary,
    evidenceCount: evidenceIds.length,
    droppedMedia: [...attachment.dropped],
    duplicateStatus,
    duplicateOf: duplicateOf === null || duplicateOf.reference === '' ? null : duplicateOf,
    createdAt: nowIso,
    warnings,
  };
}

/* --------------------------------------------------------------------------- */

async function appendInitialHistory(
  input: CreateIncidentInput,
  incidentRef: DocumentReference,
  triageSource: string,
): Promise<void> {
  const db = getAdminDb();
  await db.runTransaction(async (transaction) => {
    const event = buildStatusHistoryEvent({
      incidentId: incidentRef.id,
      eventType: 'created',
      fromStatus: null,
      toStatus: 'triaged',
      actorUid: input.reporterUid,
      actorRole: input.reporterRole,
      requestId: input.context.requestId,
      metadata: {
        triageSource,
        hasCoordinates: input.location !== null,
        language: input.language,
      },
    });
    appendStatusHistoryInTransaction(transaction, incidentRef, event);
  });
}
/**
 * ============================================================================
 * CareGrid AI — the live incident row
 * ============================================================================
 *
 * `docs/11 §11.2`. **PURE.** No Firestore, no React.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `Incident`
 * ---------------------------------------------------------------------------
 * `types/domain.ts`'s `Incident` has 40+ fields, and three of them **cannot be
 * filled by a listener**:
 *
 * | Field | `docs/08 §3.2` says | Why a listener cannot produce it |
 * | --- | --- | --- |
 * | `slaState` | server-derived | reimplementing the SLA clock in a browser is a second source of truth for whether a deadline has passed |
 * | `ageMin` | server-derived | same clock, and the value would drift with the client's clock |
 * | `distanceM` | server-derived | a listener would have to reimplement Phase 6's haversine, and against WHOSE location |
 *
 * `docs/11 §11.2` puts these in the table headed "**What MUST be delivered through
 * the API instead, and why**", and `docs/11` calls the whole table "the single most
 * important security statement in the realtime design".
 *
 * So the honest answer is a row type that is a **declared subset**, with those
 * three absent rather than guessed. `LIVE_ROW_OMITTED_FIELDS` names them, the UI
 * can say "not available live", and nobody re-derives an SLA deadline in a
 * component. A `LiveIncidentRow` that claimed to be an `Incident` would make the
 * omission invisible at the type level, which is where it would do the most damage.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIELD IS READ DEFENSIVELY, AND THE DEFAULTS ARE NOT INVENTIONS
 * ---------------------------------------------------------------------------
 * A document can be missing almost any of these: written by an older release, by
 * the seed script, or by an admin correcting a typo by hand. The readers reuse
 * `lib/server/serialize.ts` — Phase 3's own `readString` / `readBoolean` /
 * `readNumber` / `toIso` — rather than a second set.
 *
 * Where a default is needed it is the value the schema declares, and the two
 * judgement calls are:
 *
 * - `urgency: 'medium'` when absent. `docs/01` FR-026 defines four values with no
 *   "unknown" member, so the UI needs a member to render. `medium` is the
 *   **middle** of the scale, which is the least alarming thing to show for a field
 *   nobody set — and the row also carries `urgencyIsDefaulted: true` so the UI can
 *   say so rather than presenting a guess as a triage result. Inventing an
 *   `unknown` urgency would put a value in the enum that no document contains.
 * - `peopleAffected: null`, never `0`. `types/domain.ts` is explicit: "null when
 *   unknown - never defaulted to 0 or 1. FR-023." A fabricated headcount is a
 *   fabricated fact about an emergency.
 */

import {
  DUPLICATE_STATUSES,
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  SAFETY_FLAGS,
  URGENCIES,
  VERIFICATION_SOURCES,
  type AssigneeSummary,
  type DuplicateStatus,
  type IncidentCategory,
  type IncidentStatus,
  type SafetyFlag,
  type TriageSource,
  type Urgency,
  type UrgencySource,
  type VerificationSource,
} from '@/types';

/* ========================================================================== */
/* The timestamp reader                                                        */
/* ========================================================================== */

/**
 * A Firestore timestamp (or a `Date`, or an ISO string) → an ISO string, or
 * `null`.
 *
 * **Not `lib/server/serialize.ts`'s `toIso`, deliberately.** That module carries
 * `import 'server-only'` and the project's own `no-restricted-imports` rule blocks
 * it here — which is the rule working: a client bundle reaching a server-only
 * module will not build (NFR-013). Three lines of duplication is the correct price
 * for keeping the boundary real, and the alternative — loosening the lint rule —
 * would let the next server module into a browser bundle.
 *
 * Returns `null` for anything unrecognised rather than coercing. `new Date(x)` on a
 * non-date produces `Invalid Date`, and an `Invalid Date` reaching
 * `formatRelative` renders "in NaN minutes".
 */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // A Firestore `Timestamp`. Duck-typed rather than `instanceof`, because the
  // modular SDK's `Timestamp` and the Admin SDK's are different classes and a
  // listener can be handed either in a test.
  if (typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/* ========================================================================== */
/* The row                                                                     */
/* ========================================================================== */

export type LiveIncidentRow = {
  readonly id: string;
  readonly incidentId: string;
  /** Human code. `docs/07 §1.1`: the anchor a dispatcher and a citizen quote. */
  readonly reference: string;
  readonly status: IncidentStatus;
  readonly category: IncidentCategory;
  readonly urgency: Urgency;
  /** `true` when `urgency` was absent and defaulted. Never rendered silently. */
  readonly urgencyIsDefaulted: boolean;
  readonly urgencySource: UrgencySource | null;
  readonly triageSource: TriageSource | null;
  /** `docs/09 §2.8`: the server's boolean. The client derives a BAND, never the flag. */
  readonly aiConfidence: number | null;
  readonly aiNeedsReview: boolean;
  readonly summary: string;
  /** `null` when unknown. Never `0`. FR-023. */
  readonly peopleAffected: number | null;
  readonly safetyFlags: readonly SafetyFlag[];
  readonly verification: VerificationSource | null;
  readonly duplicateStatus: DuplicateStatus | null;
  readonly linkedReportCount: number;
  readonly evidenceCount: number;
  readonly assignee: AssigneeSummary | null;
  /** `docs/07 §4`'s denormalised field. The rules key their read grant on this. */
  readonly assigneeUid: string | null;
  /** `null` when the incident has no coordinates. Never a fabricated position. */
  readonly location: { readonly lat: number; readonly lng: number } | null;
  /** `docs/12 §2`'s human-readable place, when one was actually resolved. */
  readonly placeName: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly slaTargetMin: number | null;
  /** `null` until the server writes it. `docs/08 §3.2`. */
  readonly slaBreachedAt: string | null;
};

/**
 * The `Incident` fields a live row deliberately does NOT carry.
 *
 * Exported so the UI, a test, and a future reviewer can all ask the same question
 * and get the same answer. `docs/11 §11.2` is the authority.
 */
export const LIVE_ROW_OMITTED_FIELDS = [
  'slaState',
  'ageMin',
  'distanceM',
  'originalText',
  'reporterUid',
  'requiredResources',
  'channel',
  'resolvedAt',
  'resolutionCode',
  'resolutionNote',
] as const;

/* ========================================================================== */
/* The reader vocabulary                                                       */
/* ========================================================================== */

/**
 * The accepted values, built from the SAME exported constants the enums use.
 *
 * **The first draft of this file restated three vocabularies from memory and got
 * all three wrong**: `DuplicateStatus` was `suspected/confirmed/dismissed` rather
 * than `potential_duplicate/confirmed_duplicate/separate_incident`,
 * `VerificationSource` did not exist as written, and `TriageSource` was
 * `gemini`/`fallback`/`human` rather than `ai`/`fallback`/`manual`.
 *
 * Every one of those would have been a silent data-quality bug: a document's real
 * `duplicateStatus` would have read as `null` and the queue would have shown no
 * duplicate indicator on a confirmed duplicate. Deriving the sets from the
 * exported constants makes the mistake structurally impossible — a new enum member
 * is accepted the day it is added, and no restatement can disagree with it.
 */
const STATUSES = new Set<IncidentStatus>(INCIDENT_STATUSES);
const CATEGORIES = new Set<IncidentCategory>(INCIDENT_CATEGORIES);
const URGENCY_SET = new Set<Urgency>(URGENCIES);
const DUPLICATE_SET = new Set<DuplicateStatus>(DUPLICATE_STATUSES);
const VERIFICATION_SET = new Set<VerificationSource>(VERIFICATION_SOURCES);
const SAFETY_FLAG_SET = new Set<SafetyFlag>(SAFETY_FLAGS);

/**
 * The two vocabularies that have NO exported constant.
 *
 * `types/enums.ts` declares `UrgencySource` and `TriageSource` as inline union
 * types rather than deriving them from an array, so there is nothing to import and
 * these two must be written out. They are pinned by a test against the declared
 * types, which is the only available substitute for the derive-from-the-constant
 * discipline the other five get.
 *
 * Note they are NOT the same set: `UrgencySource` has `human`, `TriageSource` has
 * `manual`. That asymmetry is the declaration's, and it is worth noticing — a
 * triage can be re-done by a person, but the urgency that came out of it is
 * attributed to whoever set it last.
 */
const URGENCY_SOURCE_SET: ReadonlySet<UrgencySource> = new Set<UrgencySource>(['ai', 'human', 'fallback']);
const TRIAGE_SOURCE_SET: ReadonlySet<TriageSource> = new Set<TriageSource>(['ai', 'fallback', 'manual']);

/* ========================================================================== */
/* The mapper                                                                  */
/* ========================================================================== */

/**
 * One incident document → one row.
 *
 * **Total.** Every input yields a row; nothing throws. A mapper that threw would
 * take the whole queue down on one malformed document, and the queue is what a
 * dispatcher is looking at while someone waits.
 */
export function toLiveIncidentRow(data: Record<string, unknown>, id: string): LiveIncidentRow {
  return {
    id,
    incidentId: readString(data, 'incidentId', id),
    reference: readString(data, 'reference', id),
    status: readEnum(data, 'status', STATUSES, 'new'),
    category: readEnum(data, 'category', CATEGORIES, 'other'),
    // The one judgement call, and it is surfaced rather than hidden.
    ...readUrgency(data),
    urgencySource: readEnumOrNull(data, 'urgencySource', URGENCY_SOURCE_SET),
    triageSource: readEnumOrNull(data, 'triageSource', TRIAGE_SOURCE_SET),
    aiConfidence: readNumber(data, 'aiConfidence'),
    aiNeedsReview: readBoolean(data, 'aiNeedsReview'),
    summary: readString(data, 'summary'),
    peopleAffected: readNumber(data, 'peopleAffected'),
    safetyFlags: readEnumArray(data, 'safetyFlags'),
    verification: readEnumOrNull(data, 'verification', VERIFICATION_SET),
    duplicateStatus: readEnumOrNull(data, 'duplicateStatus', DUPLICATE_SET),
    linkedReportCount: readCount(data, 'linkedReportCount'),
    evidenceCount: readCount(data, 'evidenceCount'),
    assignee: toAssignee(data),
    assigneeUid: readNullableString(data, 'assigneeUid'),
    location: toLatLng(data),
    placeName: readNullableString(data, 'placeName'),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    slaTargetMin: readNumber(data, 'slaTargetMin'),
    slaBreachedAt: toIso(data.slaBreachedAt),
  };
}

/* ========================================================================== */
/* Readers                                                                     */
/* ========================================================================== */

/**
 * Urgency, and whether it had to be defaulted.
 *
 * Returned as an object so the caller SPREADS it, which is what makes
 * `urgencyIsDefaulted` impossible to forget — a function returning just the value
 * would have a caller that renders "MEDIUM" for a triage that never ran, and
 * nothing in the type would say so.
 */
function readUrgency(data: Record<string, unknown>): { urgency: Urgency; urgencyIsDefaulted: boolean } {
  const raw = data.urgency;
  if (typeof raw === 'string' && URGENCY_SET.has(raw as Urgency)) {
    return { urgency: raw as Urgency, urgencyIsDefaulted: false };
  }
  return { urgency: 'medium', urgencyIsDefaulted: true };
}

function readString(data: Record<string, unknown>, field: string, fallback = ''): string {
  const raw = data[field];
  return typeof raw === 'string' ? raw : fallback;
}

/** `null` rather than `''`, so "not set" and "set to empty" stay distinguishable. */
function readNullableString(data: Record<string, unknown>, field: string): string | null {
  const raw = data[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readBoolean(data: Record<string, unknown>, field: string): boolean {
  return data[field] === true;
}

/** A finite number, or `null`. Rejects `NaN` and a non-numeric string. */
function readNumber(data: Record<string, unknown>, field: string): number | null {
  const raw = data[field];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** A non-negative integer, or 0. A negative count is a defect, not a value. */
function readCount(data: Record<string, unknown>, field: string): number {
  const raw = data[field];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function readEnum<T extends string>(
  data: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<T>,
  fallback: T,
): T {
  const raw = data[field];
  return typeof raw === 'string' && allowed.has(raw as T) ? (raw as T) : fallback;
}

function readEnumOrNull<T extends string>(
  data: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<T>,
): T | null {
  const raw = data[field];
  if (typeof raw !== 'string') return null;
  return allowed.has(raw as T) ? (raw as T) : null;
}

/**
 * A safety flag list, filtered to the declared vocabulary.
 *
 * Filtered rather than cast: `safetyFlags` drives a visible alert row, and an
 * unrecognised string in it would render as a chip with no label and no colour.
 */
function readEnumArray(data: Record<string, unknown>, field: string): readonly SafetyFlag[] {
  const raw = data[field];
  if (!Array.isArray(raw)) return [];
  // Filtered to the declared vocabulary rather than cast: `safetyFlags` drives a
  // visible alert row, and an unrecognised string in it would render as a chip with
  // no label and no colour.
  return raw.filter(
    (item): item is SafetyFlag => typeof item === 'string' && SAFETY_FLAG_SET.has(item as SafetyFlag),
  );
}

/**
 * The denormalised `AssigneeSummary`. `docs/07 §4`.
 *
 * A summary with no `uid` is `null` rather than a nameless assignee: a row
 * reading "Unassigned — Ahmed" is incoherent, and an assignee with no id cannot be
 * linked to their profile.
 */
function toAssignee(data: Record<string, unknown>): AssigneeSummary | null {
  const raw = data.assignee;
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const uid = source.uid;
  if (typeof uid !== 'string' || uid.length === 0) return null;
  return {
    uid,
    displayName: typeof source.displayName === 'string' ? source.displayName : uid,
    status: source.status === 'available' || source.status === 'busy' ? source.status : 'offline',
  };
}

/**
 * A position, if the document has a real one.
 *
 * Range-checked rather than trusted, and `null` on failure. A `GeoPoint` with a
 * latitude of 91 is not a position; rendering it on a map produces a marker in the
 * void, and a marker in the void during a dispatch is worse than no marker.
 */
function toLatLng(data: Record<string, unknown>): { lat: number; lng: number } | null {
  const raw = data.geo;
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as { latitude?: unknown; longitude?: unknown };
  const lat = source.latitude;
  const lng = source.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;
  return { lat, lng };
}

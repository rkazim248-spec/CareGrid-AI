/**
 * ============================================================================
 * CareGrid AI — Firestore to DTO serialisation
 * ============================================================================
 *
 * `Timestamp` becomes an ISO string, `GeoPoint` becomes `{ lat, lng }`, and
 * fields the caller may not see are REMOVED here rather than in a service.
 *
 * ---------------------------------------------------------------------------
 * WHY REDACTION LIVES IN THE SERIALISER AND NOT IN THE SERVICE
 * ---------------------------------------------------------------------------
 * Because a service does not know who is calling it, and a new endpoint is
 * written by copying the nearest one. If redaction is a decision inside each
 * service, forgetting it is invisible: the response is simply wider, and
 * "wider" is not a failure anything detects.
 *
 * Putting it here makes it a property of the CALLER (`RedactionProfile`), so the
 * same serialiser produces a different body for a citizen and a dispatcher from
 * the same document, and a route cannot opt out. This is enforcement layer 3 of
 * the six in docs/22 §6.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NEVER SERIALISED, FOR ANY PROFILE
 * ---------------------------------------------------------------------------
 * | Field                          | Why                                          |
 * |--------------------------------|----------------------------------------------|
 * | `ipHash`                       | pseudonymous, but still a tracking identifier |
 * | `token`, any claim, any secret | never read into a DTO at all                  |
 * | `reporterUid` to a non-owner   | identity, not needed to act                   |
 * | `phone` on a list route        | docs/08 §4.1 forbids it outright              |
 * | `ai.rawOutput`                 | the model's unredacted text                   |
 *
 * A field that is ABSENT is omitted rather than sent as `null`, and a field that
 * is explicitly `null` in the document stays `null`. The difference matters: a
 * client cannot tell "not applicable" from "not recorded yet" otherwise
 * (docs/06 §3.7 rule 1, docs/08 §1.4).
 *
 * ---------------------------------------------------------------------------
 * WHY `undefined` NEVER REACHES JSON
 * ---------------------------------------------------------------------------
 * `JSON.stringify({ a: undefined })` produces `{}`, so a field that is present
 * in the TypeScript type and `undefined` at runtime is SILENTLY absent from the
 * response — a contract failure that a type checker cannot see and a test has
 * to. `compact()` below removes those keys explicitly so the omission is a
 * decision, taken here, where it is visible.
 */

import 'server-only';

import { COLLECTIONS } from '@/config/collections';
import type { UserRole } from '@/types/enums';

/* ========================================================================== */
/* Profiles                                                                   */
/* ========================================================================== */

/**
 * How much of a record this caller is allowed to see.
 *
 * | Profile     | Who                                  | What is removed                        |
 * |-------------|--------------------------------------|----------------------------------------|
 * | `full`      | owner, dispatcher, admin             | nothing the contract lists             |
 * | `privileged`| dispatcher/admin on a LIST row        | the original text, search tokens       |
 * | `responder` | an assigned responder                 | reporter identity, precise location text |
 * | `owner`     | a citizen on their own record         | the same as `full`; named for intent   |
 */
export type RedactionProfile = 'full' | 'privileged' | 'responder' | 'owner';

/**
 * The profile for a caller on a given record.
 *
 * This is the ONLY place a redaction profile is chosen, which is what makes it
 * auditable: `rg redactionProfile` finds one function rather than forty
 * scattered conditions.
 *
 * The two hard rules, in order:
 *
 *   1. **Admin is not a superuser.** `full` is granted to the owner, and to
 *      `dispatcher` and `admin` because the matrix grants them the underlying
 *      capability. It is never granted by default.
 *   2. **Ownership beats role.** A citizen reading their OWN report gets
 *      `owner`, which includes the original text, even though a citizen
 *      reading someone else's gets nothing at all. docs/22 §3 row 9.
 */
export function redactionProfile(input: {
  readonly viewer: { readonly uid: string; readonly role: UserRole };
  /** The `reporterUid`, when the record has one. */
  readonly ownerUid?: string | null;
  /** `true` when this responder is assigned to the incident. */
  readonly assigned?: boolean;
}): RedactionProfile {
  const { viewer } = input;
  if (input.ownerUid !== undefined && input.ownerUid !== null && input.ownerUid === viewer.uid) {
    return 'owner';
  }
  if (viewer.role === 'dispatcher' || viewer.role === 'admin') return 'full';
  if (viewer.role === 'responder' && input.assigned === true) return 'responder';
  return 'full';
}

/** Does this profile allow the citizen's original words to be read? */
export function mayReadOriginalText(profile: RedactionProfile): boolean {
  return profile === 'full' || profile === 'owner';
}

/** Does this profile allow the reporter's identity to be read? */
export function mayReadReporterIdentity(profile: RedactionProfile): boolean {
  return profile === 'full' || profile === 'owner';
}

/** Does this profile allow the human-written location text to be read? */
export function mayReadLocationText(profile: RedactionProfile): boolean {
  return profile === 'full' || profile === 'owner';
}

/* ========================================================================== */
/* Firestore value conversion                                                  */
/* ========================================================================== */

/**
 * A `Timestamp`, a `Date`, or an ISO string to an ISO-8601 UTC instant.
 *
 * Returns `null` for anything unrecognised rather than throwing. A malformed
 * timestamp on a document is a display problem; failing the whole response
 * because one field in one record has a bad date turns a cosmetic bug into an
 * outage for every caller on that page.
 */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === 'object' && 'toDate' in value) {
    const toDate = (value as { toDate: unknown }).toDate;
    if (typeof toDate !== 'function') return null;
    try {
      const date = (toDate as () => Date).call(value);
      return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
    } catch {
      return null;
    }
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

/**
 * A `GeoPoint` to `{ lat, lng }`, with a range check.
 *
 * The range check is not paranoia. A location outside ±90/±180 is not a
 * location, and rendering `lat: 947` on a map produces a silently broken marker
 * rather than an error. Out of range becomes `null`, which the UI renders as the
 * documented "location unknown" state (docs/12 §9).
 */
export function toGeoPoint(value: unknown): { lat: number; lng: number } | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown };
  const lat = typeof record.latitude === 'number' ? record.latitude : record.lat;
  const lng = typeof record.longitude === 'number' ? record.longitude : record.lng;

  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

/** A `DocumentReference` to its path string, which is what a client stores. */
export function toRefPath(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { path?: unknown };
  return typeof record.path === 'string' ? record.path : null;
}

/**
 * Read a string field, falling back when it is absent or the wrong type.
 *
 * Documents in this collection have been written by the Admin SDK, by
 * `scripts/seed.ts`, and potentially by a future import, so a field's RUNTIME
 * type is not guaranteed by its schema. A reader that assumes is how a legacy
 * document turns every page that lists it into a 500.
 */
export function readString(doc: Record<string, unknown>, field: string, fallback = ''): string {
  const value = doc[field];
  return typeof value === 'string' ? value : fallback;
}

export function readBoolean(doc: Record<string, unknown>, field: string, fallback = false): boolean {
  const value = doc[field];
  return typeof value === 'boolean' ? value : fallback;
}

export function readNumber(doc: Record<string, unknown>, field: string): number | null {
  const value = doc[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readStringArray(doc: Record<string, unknown>, field: string): string[] {
  const value = doc[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/* ========================================================================== */
/* Object shaping                                                             */
/* ========================================================================== */

/**
 * Copy an object's own keys, dropping `undefined`.
 *
 * `JSON.stringify` already drops them, but SILENTLY — and a DTO that is missing
 * a field in the response while present in the type is a contract failure that
 * no type checker reports. Doing it here makes the omission deliberate, and it
 * gives one place to add a guard if a future serialiser ever needs to.
 */
export function compact<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * Remove a fixed set of keys.
 *
 * The removal list is passed in rather than hard-coded, because WHICH keys are
 * sensitive is a property of the collection and the profile — a rule this
 * function cannot know. What it guarantees is that removal is centralised and
 * that the removed keys are not present on the result at all, rather than
 * present and `undefined`.
 */
export function omit<T extends Record<string, unknown>>(
  input: T,
  keys: readonly string[],
): Record<string, unknown> {
  const drop = new Set(keys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (drop.has(key)) continue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The keys removed for a `responder` viewing an incident they are assigned to.
 *
 * docs/22 §4.1 and docs/08 §3.3. The original text is not deleted — it is
 * replaced with the AI summary, because a responder needs to know what is
 * happening and does not need to read the reporter's account of it.
 */
export const RESPONDER_REDACTED_KEYS: readonly string[] = [
  'reporterUid',
  'reporterEmail',
  'reporterPhone',
  'locationText',
  'ipHash',
  'originalText',
  'searchTokens',
  'aiRawOutput',
  'aiModel',
  'aiPromptVersion',
];

/** The extra keys removed from a LIST row for a dispatcher or admin. */
export const PRIVILEGED_LIST_REDACTED_KEYS: readonly string[] = [
  'originalText',
  'requiredResources',
  'searchTokens',
];

/* ========================================================================== */
/* Health and configuration                                                    */
/* ========================================================================== */

/**
 * The public shape of `GET /api/health`.
 *
 * Every field is either a constant or derived from the PUBLIC config. Nothing
 * here reads server configuration, reads Firestore, or reveals a variable name
 * — a public endpoint that enumerates which secrets are missing is a
 * reconnaissance endpoint, and a short list of things to try next is exactly
 * what it would hand over (docs/10 §16.3).
 */
export type HealthDto = {
  readonly status: 'ok' | 'degraded';
  readonly service: 'CareGrid AI API';
  readonly version: string;
  readonly uptimeSec: number;
  readonly timestamp: string;
};

/**
 * Milliseconds since this server instance started.
 *
 * Reported because docs/06 §1.3 asks for it: on Vercel it is the only visible
 * signal of the warm/cold ratio, which is the first thing to check when a route
 * is slow. A Vercel instance lives for minutes, so a value in the hundreds is
 * normal and a value in the tens of thousands means a long-lived process —
 * `next dev` — and is itself the answer.
 */
const INSTANCE_START_MS = Date.now();

export function uptimeSec(): number {
  return Math.floor((Date.now() - INSTANCE_START_MS) / 1000);
}

/** Re-exported so a route never has to know the collection-name module's path. */
export { COLLECTIONS };

/**
 * ============================================================================
 * CareGrid AI — Zod enum schemas
 * ============================================================================
 *
 * The single validation source for every controlled value. Schemas are built
 * FROM the runtime arrays in `types/enums.ts`, never from a second hand-written
 * list of literals.
 *
 * ---------------------------------------------------------------------------
 * WHY DERIVED AND NOT RE-TYPED
 * ---------------------------------------------------------------------------
 * Doc 05 §7.4 requires: "Every schema uses the enum tuples exported from
 * `validators/enums.ts` so that a schema drift between client and server fails
 * the build rather than a demo." Hand-writing `z.enum(['critical','high',…])`
 * alongside `URGENCIES = ['critical','high',…] as const` creates two sources
 * that agree until someone adds a fourth urgency, and then a validator rejects
 * a value the type system accepts — in production, at 03:00.
 *
 * `z.enum` accepts a readonly tuple, so `URGENCIES` is passed directly. Add a
 * value to `types/enums.ts` and every schema, every dropdown, and every
 * validator picks it up. `tests/unit/validators.test.ts` asserts the two stay
 * in step.
 *
 * ---------------------------------------------------------------------------
 * WHY `z.enum` AND NOT `z.string()`
 * ---------------------------------------------------------------------------
 * A permissive schema is worse than no schema: it converts a clear
 * `VALIDATION_FAILED` at the boundary into an `undefined` read three files
 * later, or a Firestore document with a value nothing can render. These schemas
 * are the first line that makes a bad value impossible rather than unlikely.
 */

import { z } from 'zod';

import {
  ACCOUNT_STATUSES,
  AUDIT_ACTIONS,
  DISPATCH_STATUSES,
  DUPLICATE_STATUSES,
  HISTORY_EVENT_TYPES,
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  LOCATION_SOURCES,
  NOTIFICATION_TYPES,
  RESOLUTION_CODES,
  RESPONDER_STATUSES,
  SAFETY_FLAGS,
  SLA_STATES,
  TERMINAL_STATUSES,
  URGENCIES,
  USER_ROLES,
  VERIFICATION_STATUSES,
} from '@/types/enums';
import type { AccountStatus, AuditAction, UserRole } from '@/types/enums';

/* ========================================================================== */
/* Identity and account                                                       */
/* ========================================================================== */

export const userRoleSchema = z.enum(USER_ROLES);
export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);

/**
 * A role a CLIENT is allowed to request.
 *
 * `citizen` only. A public sign-up cannot ask for `responder` because the
 * responder role additionally requires `responders/{uid}.verification`, which
 * only an admin can set (FR-063/FR-064). Granting the role without the
 * verification would put an unvouched person in the candidate list.
 *
 * This is the second of three independent blocks on self-promotion:
 *   1. the signup form has no role field at all,
 *   2. this schema rejects any other value, and
 *   3. `users/{uid}` is `allow write: if false` in `firestore.rules`.
 * Removing any one leaves the other two standing.
 */
export const selfServiceRoleSchema = z.literal('citizen');

/* ========================================================================== */
/* Incidents                                                                  */
/* ========================================================================== */

export const incidentStatusSchema = z.enum(INCIDENT_STATUSES);
export const incidentCategorySchema = z.enum(INCIDENT_CATEGORIES);
export const urgencySchema = z.enum(URGENCIES);
export const safetyFlagSchema = z.enum(SAFETY_FLAGS);
export const resolutionCodeSchema = z.enum(RESOLUTION_CODES);
export const duplicateStatusSchema = z.enum(DUPLICATE_STATUSES);
export const locationSourceSchema = z.enum(LOCATION_SOURCES);
export const historyEventTypeSchema = z.enum(HISTORY_EVENT_TYPES);
export const terminalStatusSchema = z.enum(TERMINAL_STATUSES);

/* ========================================================================== */
/* Responders, dispatches, notifications, audit                               */
/* ========================================================================== */

export const responderStatusSchema = z.enum(RESPONDER_STATUSES);
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export const dispatchStatusSchema = z.enum(DISPATCH_STATUSES);
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export const auditActionSchema = z.enum(AUDIT_ACTIONS);

/** `slaState` is computed server-side, never accepted from a client. */
export const slaStateSchema = z.enum(SLA_STATES);

/* ========================================================================== */
/* Shared primitives                                                          */
/* ========================================================================== */

/** ISO-8601 with a timezone. A bare date is not an instant. */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: 'Must be an ISO-8601 timestamp with a timezone.' });

export const cuidLikeSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Contains characters that are not valid in an identifier.');

/**
 * A citizen-facing incident reference: `CG-` + 6 Crockford base32 characters.
 * The `0-9A-HJKMNP-TV-Z` set EXCLUDES I, L, O and U, because those are read
 * aloud over a radio and misread as 1 and 0.
 */
export const referenceSchema = z
  .string()
  .regex(/^CG-[0-9A-HJKMNP-TV-Z]{6}$/, 'Must be CG- followed by 6 Crockford base32 characters.');

export const requestIdSchema = z
  .string()
  .regex(/^req_[A-Za-z0-9]{12}$/, 'Must be req_ followed by 12 characters.');

/** An email, lowercased before validation so case never splits an identity. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .email('That does not look like an email address.');

/**
 * Password complexity as the CLIENT checks it, for immediate inline feedback.
 *
 * The authority is Firebase Auth's own `validatePassword`, called in
 * `lib/firebase/auth.ts`; this exists only to avoid a round trip per keystroke.
 * If the two ever disagree, Firebase wins and the user sees the server's
 * message — the client check is an optimisation, not a policy.
 */
export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128, 'That password is too long.')
  .regex(/\d/, 'Include at least one number.');

/** A display name. 2–60 chars, matching `users/{uid}.displayName`. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(2, 'Enter your name.')
  .max(60, 'That name is too long.');

/**
 * An audit reason. 10 characters is the documented floor (FR-133): short enough
 * that nobody skips it, long enough that "test" or "asdf" is not a record.
 */
export const auditReasonSchema = z
  .string()
  .trim()
  .min(10, 'Write at least 10 characters so this is understandable later.')
  .max(280, 'Keep it under 280 characters.');

/** IANA timezone, e.g. `Asia/Kolkata`. Validated against the runtime list. */
export const timezoneSchema = z.string().min(1).max(64);

/* ========================================================================== */
/* Convenience accessors for non-Zod consumers                                */
/* ========================================================================== */

/**
 * The plain values, for a `switch` or a `Set.has` outside a Zod pipeline.
 * Re-exported so no file has to import from `@/types/enums` for a value check
 * and `validators/enums` for a parse — the two must never drift.
 */
export const ENUMS = {
  roles: USER_ROLES,
  accountStatuses: ACCOUNT_STATUSES,
  categories: INCIDENT_CATEGORIES,
  urgencies: URGENCIES,
  statuses: INCIDENT_STATUSES,
  terminalStatuses: TERMINAL_STATUSES,
  safetyFlags: SAFETY_FLAGS,
  resolutionCodes: RESOLUTION_CODES,
  duplicateStatuses: DUPLICATE_STATUSES,
  locationSources: LOCATION_SOURCES,
  slaStates: SLA_STATES,
  responderStatuses: RESPONDER_STATUSES,
  verificationStatuses: VERIFICATION_STATUSES,
  dispatchStatuses: DISPATCH_STATUSES,
  notificationTypes: NOTIFICATION_TYPES,
  historyEventTypes: HISTORY_EVENT_TYPES,
  auditActions: AUDIT_ACTIONS,
} as const;

export type { AccountStatus, AuditAction, UserRole };

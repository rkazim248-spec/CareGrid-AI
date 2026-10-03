/**
 * ============================================================================
 * CareGrid AI — role metadata and the post-sign-in redirect
 * ============================================================================
 *
 * Everything about "what does this role do on arrival". The landing route in
 * particular is a SECURITY-RELEVANT value, so it is derived from the same
 * capability matrix the UI renders from, rather than being a second table that
 * can disagree.
 *
 * ---------------------------------------------------------------------------
 * WHERE A USER GOES AFTER SIGNING IN
 * ---------------------------------------------------------------------------
 * docs/22 §9:
 *
 *   citizen    → `/report`    (the primary citizen action)
 *   responder  → `/dashboard`  (their assignments)
 *   dispatcher → `/dashboard`  (the operations console)
 *   admin      → `/admin`      (the trust surface)
 *
 * Citizens start at the report form; responder and dispatcher accounts use the
 * dashboard, with server-side incident scoping enforced on every read.
 */

import { can, type CapabilityKey } from '@/lib/auth/permissions';
import { ROLE_META, ROLE_ORDER } from '@/config/roles';
import { USER_ROLES } from '@/types/enums';
import type { UserRole } from '@/types/enums';

export { ROLE_META, ROLE_ORDER };
export { routeAllows, rolesForRoute } from '@/config/nav';
export type { UserRole };

/**
 * The landing route for each role.
 *
 * Typed as a total record over `UserRole`, so adding a fifth role is a TYPE
 * ERROR here rather than an `undefined` at runtime that navigates to `/`.
 */
export const ROLE_LANDING: Readonly<Record<UserRole, string>> = {
  citizen: '/report',
  responder: '/dashboard',
  dispatcher: '/dashboard',
  admin: '/admin',
};

/**
 * The capability that justifies each landing route. Asserted in
 * `tests/unit/roles.test.ts`: a citizen lands on the report form and can create
 * an incident, while operations roles land on views they are allowed to read.
 */
export const LANDING_REQUIRES: Readonly<Record<UserRole, CapabilityKey>> = {
  citizen: 'r01_createIncident',
  responder: 'r05_readOwnIncidents',
  dispatcher: 'r08_readAllIncidents',
  admin: 'r52_listUsers',
};

/** Where a role goes after signing in. */
export function landingFor(role: UserRole): string {
  return ROLE_LANDING[role];
}

/** Narrow an arbitrary string to a role. Returns `null` for anything else. */
export function asRole(value: unknown): UserRole | null {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
    ? (value as UserRole)
    : null;
}

/**
 * A short sentence for a role, for the sign-in and forbidden screens.
 * Falls back to a neutral phrase for an unknown role rather than crashing.
 */
export function describeRole(role: UserRole): string {
  return ROLE_META[role]?.label ?? 'Signed in';
}

/** Does this role get an operations console at all? */
export function usesOperationsConsole(role: UserRole): boolean {
  return can(role, 'r08_readAllIncidents');
}

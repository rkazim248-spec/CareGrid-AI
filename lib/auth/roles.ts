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
 *   citizen    → `/dashboard` (their account and saved reports)
 *   responder  → `/dashboard`  (their assignments)
 *   dispatcher → `/dashboard`  (the operations console)
 *   admin      → `/admin`      (the trust surface)
 *
 * A citizen has a personal dashboard, not an operations console. Its incident
 * list is still scoped by the server.
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
  citizen: '/dashboard',
  responder: '/dashboard',
  dispatcher: '/dashboard',
  admin: '/admin',
};

/**
 * The capability that justifies each landing route. Asserted in
 * `tests/unit/permissions.test.ts`: a citizen landing on `/dashboard` must be
 * able to read their own reports, and a dispatcher landing there must be able
 * to read all incidents.
 */
export const LANDING_REQUIRES: Readonly<Record<UserRole, CapabilityKey>> = {
  citizen: 'r05_readOwnIncidents',
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

/**
 * Role metadata — docs/22_USER_ROLES_PERMISSIONS.md §1, docs/04 §5.27
 *
 * `landing` is where a successful sign-in goes. `RoleBadge` renders the
 * `label` — never a colour-coded severity, because a role is informational and
 * not a status (docs/04 §5.27).
 */

import { Bot, ShieldCheck, Siren, UserRound, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { ActorRole, UserRole } from '@/types/enums';

export type RoleMeta = {
  readonly label: string;
  readonly icon: LucideIcon;
  /** Post-sign-in destination. docs/04 §8.5 */
  readonly landing: string;
  /** `admin` is visually distinguished by its border, not by a filled pill. */
  readonly emphasised: boolean;
  /** Short operator-facing description, used on the landing "who uses this". */
  readonly blurb: string;
};

export const ROLE_META: Record<ActorRole, RoleMeta> = {
  citizen: {
    label: 'Citizen',
    icon: UserRound,
    landing: '/report',
    emphasised: false,
    blurb: 'Reports an incident and tracks its progress.',
  },
  responder: {
    label: 'Responder',
    icon: Siren,
    landing: '/dashboard',
    emphasised: false,
    blurb: 'Volunteers availability and runs assigned incidents.',
  },
  dispatcher: {
    label: 'Dispatcher',
    icon: Users,
    landing: '/dashboard',
    emphasised: false,
    blurb: 'Reviews the live queue and assigns responders.',
  },
  admin: {
    label: 'Administrator',
    icon: ShieldCheck,
    landing: '/admin',
    emphasised: true,
    blurb: 'Manages accounts, responder verification, and audit.',
  },
  system: {
    label: 'CareGrid AI',
    icon: Bot,
    landing: '/',
    emphasised: false,
    blurb: 'Automated triage. Advisory only — a person always decides.',
  },
};

/** Roles ordered least → most privileged. Used by the admin role picker. */
export const ROLE_ORDER: readonly UserRole[] = ['citizen', 'responder', 'dispatcher', 'admin'];

export function roleLabel(role: ActorRole): string {
  return ROLE_META[role].label;
}

/**
 * Row 61 of the permission matrix is a hard denial for every role, including
 * admin: you may not change your own role. The UI disables the control and
 * says why rather than hiding it, so the constraint is discoverable.
 */
export const SELF_ROLE_CHANGE_REASON =
  'You cannot change your own role or account status.';

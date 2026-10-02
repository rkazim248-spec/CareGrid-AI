/**
 * Per-role navigation tables — docs/04_UI_UX_DESIGN_SPECIFICATION.md §8.5
 *
 * THE single source for the sidebar, the mobile bottom nav, the mobile nav
 * sheet, and the command palette's route list. Nav is never written twice.
 *
 * `minimumRole` gates a route group. The client hides what a role cannot use
 * (affordance); the API re-checks everything (docs/22 §6 layer 2). The client
 * is never an authorization boundary.
 */

import {
  Archive,
  BarChart3,
  Bell,
  ClipboardList,
  Gauge,
  Map,
  Power,
  Route,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Siren,
  SlidersHorizontal,
  UserCheck,
  UserRound,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { UserRole } from '@/types/enums';

type RoutePath = '/dashboard' | '/incidents' | '/map' | '/responders' | '/dispatches' | '/analytics' | '/notifications' | '/profile' | '/settings' | '/report' | '/track' | '/admin' | '/admin/users' | '/admin/incidents' | '/admin/responders' | '/admin/audit-logs' | '/admin/settings';

export type NavItem = {
  /**
   * A CLOSED union of the routes this app actually has, not `string`.
   *
   * `next.config.ts` sets `typedRoutes: true`, which makes Next type `<Link>`,
   * so a plain `string` fails there. Typing the href as a closed union fixes
   * that AND gives something better: a typo in a nav href is a type error at
   * build time rather than a 404 a user discovers. Every route added later
   * must be added here, which is the correct forcing function.
   */
  readonly href: RoutePath;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Roles that may see this item. Absent means all four. */
  readonly roles?: readonly UserRole[];
  /** An unread/pending count chip, when the route has one. */
  readonly badge?: 'notifications' | 'pendingVerifications';
  /** Skip the mobile bottom bar even if the role could use it. */
  readonly hideInBottomNav?: boolean;
};

export type NavGroup = {
  readonly id: string;
  /** Section label above the group. */
  readonly label: string;
  readonly items: readonly NavItem[];
};

/* -------------------------------------------------------------------------- */
/* Shared items                                                               */
/* -------------------------------------------------------------------------- */

const NOTIFICATIONS: NavItem = { href: '/notifications', label: 'Notifications', icon: Bell, badge: 'notifications' };
const PROFILE: NavItem = { href: '/profile', label: 'Profile', icon: UserRound };
const SETTINGS: NavItem = { href: '/settings', label: 'Settings', icon: Settings };
const REPORT: NavItem = { href: '/report', label: 'Report an incident', icon: Siren };
const MAP: NavItem = { href: '/map', label: 'Map', icon: Map, roles: ['responder', 'dispatcher', 'admin'] };
const AUDIT: NavItem = { href: '/admin/audit-logs', label: 'Audit log', icon: ScrollText, roles: ['dispatcher', 'admin'] };

/* -------------------------------------------------------------------------- */
/* Per-role tables                                                            */
/* -------------------------------------------------------------------------- */

export const NAV_BY_ROLE: Record<UserRole, readonly NavGroup[]> = {
  citizen: [
    {
      id: 'report',
      label: 'Report',
      items: [
        { href: '/dashboard', label: 'Dashboard', icon: ClipboardList },
        REPORT,
        { href: '/track', label: 'Track a report', icon: Search },
        { href: '/incidents', label: 'My reports', icon: ClipboardList },
      ],
    },
    {
      id: 'you',
      label: 'You',
      items: [NOTIFICATIONS, PROFILE, SETTINGS],
    },
  ],

  responder: [
    {
      id: 'work',
      label: 'Work',
      items: [
        { href: '/dashboard', label: 'Dashboard', icon: ClipboardList },
        { href: '/dispatches', label: 'My assignments', icon: Route },
        MAP,
        { href: '/responders', label: 'Availability', icon: Power },
        REPORT,
      ],
    },
    {
      id: 'you',
      label: 'You',
      items: [NOTIFICATIONS, PROFILE, SETTINGS],
    },
  ],

  dispatcher: [
    {
      id: 'operate',
      label: 'Operate',
      items: [
        { href: '/dashboard', label: 'Dashboard', icon: Gauge },
        { href: '/incidents', label: 'Incidents', icon: ClipboardList },
        MAP,
        { href: '/dispatches', label: 'Dispatches', icon: Route },
        { href: '/responders', label: 'Responders', icon: Users },
      ],
    },
    {
      id: 'review',
      label: 'Review',
      items: [
        { href: '/analytics', label: 'Analytics', icon: BarChart3 },
        AUDIT,
      ],
    },
    {
      id: 'you',
      label: 'You',
      items: [NOTIFICATIONS, PROFILE, SETTINGS],
    },
  ],

  admin: [
    {
      id: 'operate',
      label: 'Operate',
      items: [
        { href: '/dashboard', label: 'Dashboard', icon: Gauge },
        { href: '/incidents', label: 'Incidents', icon: ClipboardList },
        MAP,
        { href: '/dispatches', label: 'Dispatches', icon: Route },
        { href: '/responders', label: 'Responders', icon: Users },
      ],
    },
    {
      id: 'review',
      label: 'Review',
      items: [
        { href: '/analytics', label: 'Analytics', icon: BarChart3 },
        AUDIT,
      ],
    },
    {
      id: 'admin',
      label: 'Admin',
      items: [
        { href: '/admin', label: 'Admin overview', icon: ShieldCheck },
        { href: '/admin/users', label: 'Users', icon: Users },
        { href: '/admin/incidents', label: 'Incident archive', icon: Archive },
        {
          href: '/admin/responders',
          label: 'Responder verification',
          icon: UserCheck,
          badge: 'pendingVerifications',
        },
        AUDIT,
        { href: '/admin/settings', label: 'Platform settings', icon: SlidersHorizontal },
      ],
    },
    {
      id: 'you',
      label: 'You',
      items: [NOTIFICATIONS, PROFILE, SETTINGS],
    },
  ],
};

/**
 * Mobile bottom nav — docs/04 §8.3.
 *
 * Five items, responder-flavoured. Deliberately NOT the sidebar: a bottom bar
 * is a thumb-reach affordance and five is the most that stays comfortable.
 */
export const BOTTOM_NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Work', icon: ClipboardList },
  REPORT,
  MAP,
  { href: '/notifications', label: 'Alerts', icon: Bell, badge: 'notifications' },
  PROFILE,
];

/** Routes a role may not open. Drives the 403 state, never a redirect. */
export function routeAllows(href: string, role: UserRole): boolean {  if (href.startsWith('/admin')) {
    if (href === '/admin/audit-logs') return role === 'admin' || role === 'dispatcher';
    return role === 'admin';
  }
  if (href === '/analytics') return role === 'dispatcher' || role === 'admin';
  if (href === '/map') return role !== 'citizen';
  if (href === '/responders') return role !== 'citizen';
  if (href === '/dispatches') return role !== 'citizen';
  return true;
}

/** Human list of the roles a route is for, used in the 403 body copy. */
export function rolesForRoute(href: string): readonly UserRole[] {
  if (href === '/admin/audit-logs') return ['dispatcher', 'admin'];
  if (href.startsWith('/admin')) return ['admin'];
  if (href === '/analytics') return ['dispatcher', 'admin'];
  if (['/map', '/responders', '/dispatches'].includes(href)) {
    return ['responder', 'dispatcher', 'admin'];
  }
  return ['citizen', 'responder', 'dispatcher', 'admin'];
}

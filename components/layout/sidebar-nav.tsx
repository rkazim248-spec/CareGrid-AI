'use client';


import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { NAV_BY_ROLE } from '@/config/nav';
import type { NavItem } from '@/config/nav';
import { RoleBadge } from '@/components/domain/role-badge';
import { DEMO_DISCLAIMER } from '@/lib/constants';
import { DemoDataBadge } from '@/components/feedback/live-region';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * SidebarNav — docs/04 §8.1
 *
 * Reads the per-role table from `config/nav.ts` and NOTHING else. The nav is
 * never written twice (a hard-won lesson from every app that has a sidebar and
 * a bottom bar that drift apart).
 *
 * The active item is signalled three ways: a 3px left rule, an elevated fill,
 * and `aria-current="page"`. Any one alone would fail for someone.
 */
export function SidebarNav({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {

  const { role, user, isAllowed } = useResolvedSession();
  const pathname = usePathname();

  // No session yet (only reachable if this component is mounted outside
  // `<RequireSession>`, which the provider warns about in development). Render
  // nothing rather than a fabricated identity — the gate is what should be
  // showing here.
  if (role === null) return null;

  const groups = NAV_BY_ROLE[role];
  const displayName = user?.displayName ?? '';


  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
        {groups.map((group, index) => {
          const visible = group.items.filter((item) => isAllowed(item.href));
          if (visible.length === 0) return null;
          return (
            <nav key={group.id} aria-label={group.label} className="flex flex-col gap-1">
              {index > 0 ? (
                <div className="mb-2 border-t border-subtle pt-3">
                  <h2 className="uppercase-label px-2 text-muted">{group.label}</h2>
                </div>
              ) : null}
              {visible.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={isActive(pathname, item.href)}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ))}
            </nav>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 border-t border-subtle px-3 py-3">
        {collapsed ? null : (
          <>
            <RoleBadge role={role} size="md" />
            <p className="truncate text-xs text-secondary" title={user?.email ?? ''}>
              {displayName}
            </p>
            <DemoDataBadge />
            <p className="text-2xs leading-snug text-muted">{DEMO_DISCLAIMER}</p>
          </>
        )}
      </div>
    </div>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard' || href === '/admin') return pathname === href;
  // `/` must not match every route, and a prefix match must not make
  // `/incidents` active while viewing `/incidents/CG-7QK4M2`... which it
  // SHOULD be, actually — the section is where you are.
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        'flex min-h-11 items-center gap-3 rounded-control px-2.5 text-sm',
        'transition-colors duration-[--motion-duration-instant]',
        'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
        active
          ? 'border-l-[3px] border-l-selected bg-elevated font-semibold text-primary'
          : 'border-l-[3px] border-l-transparent text-secondary hover:bg-elevated hover:text-primary',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="size-icon-sm shrink-0" aria-hidden="true" />
      {collapsed ? <span className="sr-only">{item.label}</span> : <span>{item.label}</span>}
    </Link>
  );
}

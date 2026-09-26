'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, Menu, Search, ShieldCheck, UserRound } from 'lucide-react';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui/icon-button';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarNav } from '@/components/layout/sidebar-nav';
import { LiveIndicator } from '@/components/layout/live-indicator';
import { useResolvedSession } from '@/components/providers/session-provider';
import { NAV_BY_ROLE } from '@/config/nav';
import { MOCK_NOTIFICATIONS } from '@/lib/mock-data';
import { DEMO_DISCLAIMER } from '@/lib/constants';
import { DemoDataBadge } from '@/components/feedback/live-region';

/**
 * TopBar — docs/04 §8.2
 *
 * 56px, sticky, `bg-app` with a bottom hairline.
 *
 * At >= 1024px: breadcrumb slot · search · LiveIndicator · notifications · avatar.
 * Below 1024px it reduces to: hamburger · page title · LiveIndicator ·
 * notifications · avatar. The hamburger opens a real Sheet — a decorative
 * hamburger that does nothing is the single most common fake control in a
 * scaffolded app, and it is explicitly forbidden here.
 */
export function TopBar({
  unreadCount = MOCK_NOTIFICATIONS.filter((n) => !n.read).length,
}: {
  unreadCount?: number;
}) {
  const [navOpen, setNavOpen] = React.useState(false);
  const { role, user, signOut } = useResolvedSession();
  const pathname = usePathname();

  // Only reachable when this is mounted outside `<RequireSession>`, which the
  // provider warns about in development. `titleForPath` and the nav table both
  // need a role, so there is nothing meaningful to render without one.
  if (role === null) return null;

  const pageTitle = titleForPath(pathname, role);
  const canSearch = role === 'dispatcher' || role === 'admin';
  const displayName = user?.displayName ?? 'Signed in';
  // Initials, or a single glyph. Never an empty circle that looks like a
  // loading state.
  const initials =
    displayName === 'Signed in'
      ? '?'
      : displayName
          .split(' ')
          .slice(0, 2)
          .map((part) => part[0]?.toUpperCase() ?? '')
          .join('');

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b border-subtle bg-app px-3 lg:px-4">
      {/* Mobile: the nav trigger. */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetTrigger asChild>
          <IconButton label="Open the main menu" icon={Menu} className="lg:hidden" />
        </SheetTrigger>
        <SheetContent side="left" className="w-[300px] p-0" hideClose>
          <SheetHeader className="pr-4">
            <SheetTitle className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-control bg-accent text-on-solid">
                <ShieldCheck className="size-4" aria-hidden="true" />
              </span>
              CareGrid AI
            </SheetTitle>
            <p className="text-xs text-secondary">
              {NAV_BY_ROLE[role].length} sections · signed in as {displayName}
            </p>
          </SheetHeader>
          <SheetBody className="p-0">
            <SidebarNav onNavigate={() => setNavOpen(false)} />
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Mobile: the current page. A <p>, not an <h1> — the page owns the
          single <h1>, and two of them below `lg` would break the document
          outline that docs/04 §13 requires. */}
      <p className="min-w-0 flex-1 truncate text-base font-semibold text-primary lg:hidden">
        {pageTitle}
      </p>

      {canSearch ? (
        <Link
          href="/incidents"
          className={cn(
            'hidden min-w-0 max-w-80 flex-1 items-center gap-2 rounded-control border border-control bg-elevated px-3 py-1.5 text-sm text-muted lg:flex',
            'transition-colors hover:border-strong',
          )}
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">Search incidents</span>
          <kbd className="ml-auto rounded border border-default px-1.5 py-0.5 font-mono text-2xs text-muted">
            /
          </kbd>
        </Link>
      ) : null}

      <div className="ml-auto flex items-center gap-1 lg:gap-2">
        <LiveIndicator />

        <IconButton
          label="Notifications"
          icon={Bell}
          href="/notifications"
          asChild
          badge={unreadCount}
        />

        <Link
          href="/profile"
          className="flex items-center gap-2 rounded-control px-1.5 py-1 transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus"
        >
          <span className="flex size-8 items-center justify-center rounded-pill border border-default bg-elevated text-xs font-semibold text-secondary">
            {initials}
          </span>
          <span className="sr-only lg:not-sr-only lg:text-sm lg:text-secondary">
            {displayName}
          </span>
        </Link>

        <button
          type="button"
          onClick={signOut}
          className="hidden rounded-control px-2 py-1 text-sm text-secondary transition-colors hover:bg-elevated hover:text-primary focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus lg:inline-flex"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

/** Short page title for the mobile top bar. */
function titleForPath(pathname: string, role: string): string {
  if (pathname === '/dashboard') return role === 'responder' ? 'My work' : 'Dashboard';
  if (pathname.startsWith('/report')) return 'Report an incident';
  if (pathname.startsWith('/track')) return 'Track a report';
  if (pathname.startsWith('/incidents')) return 'Incidents';
  if (pathname.startsWith('/map')) return 'Map';
  if (pathname.startsWith('/responders')) return 'Responders';
  if (pathname.startsWith('/dispatches')) return 'Dispatches';
  if (pathname.startsWith('/analytics')) return 'Analytics';
  if (pathname.startsWith('/notifications')) return 'Notifications';
  if (pathname.startsWith('/profile')) return 'Profile';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/admin')) return 'Administration';
  return 'CareGrid AI';
}

/**
 * ConnectivityBanner — docs/04 §9.4, §9.5
 *
 * One of the only two PERSISTENT banners in the product (the other is a
 * critical incident alert), because "did my action send?" is the question an
 * offline responder is actually asking.
 */
export function ConnectivityBanner() {
  const [online, setOnline] = React.useState(true);
  const [reconnecting, setReconnecting] = React.useState(false);

  React.useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) setReconnecting(false);
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (online && !reconnecting) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-2 border-b px-4 py-2 text-sm',
        online ? 'border-accent bg-accent-muted text-accent-fg-muted' : 'border-warning bg-warning-muted text-warning-fg-muted',
      )}
    >
      {online ? null : null}
      <span className="font-medium">{online ? 'Reconnecting' : 'You are offline'}</span>
      <span className="hidden sm:inline">
        {online
          ? 'Live updates are paused. This is the last data we received.'
          : 'Actions you take now are kept on this device and sent when the connection returns.'}
      </span>
    </div>
  );
}

export { DEMO_DISCLAIMER, DemoDataBadge, UserRound };

'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

import { Sidebar } from '@/components/layout/sidebar';
import { TopBar, ConnectivityBanner } from '@/components/layout/top-bar';
import { BottomNav } from '@/components/layout/bottom-nav';
import { useResolvedSession } from '@/components/providers/session-provider';
import { ForbiddenState } from '@/components/feedback/forbidden-state';
import type { UserRole } from '@/types/enums';

/**
 * AppShell — docs/04 §8, §12
 *
 * The desktop layout is TopBar over a Sidebar + content split. Mobile is a
 * single column with a TopBar, a working hamburger Sheet, and a bottom nav.
 *
 * `requiredRoles` renders `ForbiddenState` IN PLACE when the role is not
 * permitted. It never redirects: a redirect loop on a role-gated route is worse
 * than an honest refusal, and the address bar should stay truthful
 * (docs/04 §13.22).
 */
export function AppShell({
  children,
  requiredRoles,
}: {
  children: React.ReactNode;
  requiredRoles?: readonly UserRole[];
}) {
  const pathname = usePathname();
  const { role, signOut } = useResolvedSession();

  // Only reachable outside `<RequireSession>`, which the provider warns about in
  // development. `requiredRoles.includes(null)` would be a lie — it would report
  // "permitted" for a route nobody has been authorised for.
  if (role === null) return null;

  const permitted = !requiredRoles || requiredRoles.includes(role);

  return (
    <div className="flex min-h-dvh flex-col bg-app">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-on-solid"
      >
        Skip to main content
      </a>

      <TopBar />

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ConnectivityBanner />
        <main
          id="main-content"
          tabIndex={-1}
          className="min-w-0 flex-1 pb-20 outline-none md:pb-8"
        >
          {permitted ? (
            <div key={pathname} className="mx-auto w-full max-w-[1600px] px-4 py-6 lg:px-8">
              {children}
            </div>
          ) : (
            <ForbiddenState
              role={role}
              allowedRoles={requiredRoles ?? [role]}
              onGoHome={() => {
                window.location.assign('/');
              }}
              onSignOut={signOut}
            />
          )}
        </main>
      </div>

      <BottomNav />
    </div>
  );
}

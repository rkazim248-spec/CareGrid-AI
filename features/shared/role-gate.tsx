'use client';

import * as React from 'react';

import { ForbiddenState } from '@/components/feedback';
import { useRouteAccess, useResolvedSession } from '@/components/providers/session-provider';

/**
 * RoleGate — the per-route 403 boundary for an app tree whose LAYOUT already
 * renders `AppShell`.
 *
 * `AppShell` takes `requiredRoles` and renders `ForbiddenState` in place, which
 * is the pattern docs/04 §13.22 asks for. Wrapping a page in a SECOND `AppShell`
 * to pass that list would emit a second `<main>` landmark, so when the shell is
 * already applied by the route group's layout the gate has to live here instead.
 * The behaviour is identical: no redirect, no loop, the URL stays truthful, and
 * the refusal says which roles the page is for.
 *
 * `href` is the ROUTE, not a permission name, because `useRouteAccess` resolves
 * it through the same `routeAllows` / `rolesForRoute` tables the sidebar uses.
 * One source of truth for "who may open what" (docs/04 §13.22, FR-117).
 */
export function RoleGate({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const { allowed, allowedRoles } = useRouteAccess(href);
  const { role, signOut } = useResolvedSession();

  if (allowed) return <>{children}</>;

  // Only reachable outside `RequireSession`. `ForbiddenState` must name the
  // caller's role, and there is none to name.
  if (role === null) return <>{children}</>;

  return (
    <ForbiddenState
      role={role}
      allowedRoles={allowedRoles}
      onGoHome={() => {
        window.location.assign('/');
      }}
      onSignOut={signOut}
    />
  );
}

'use client';


import * as React from 'react';

import type { UserRole } from '@/types';
import { DispatcherDashboard } from '@/features/dashboard/dispatcher-dashboard';
import { ResponderDashboard } from '@/features/dashboard/responder-dashboard';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * DashboardView — the single `/dashboard` route with two variants, chosen by
 * ROLE and not by viewport (docs/04 §12.2, §12.3).
 *
 * A dispatcher and a responder share this route because the shell already
 * refuses a citizen (FR-067), and giving them separate URLs would mean two
 * entries in the sidebar, two breadcrumb roots, and two things to remember. The
 * switch happens here so the layout above it never has to know which one it is
 * hosting.
 *
 * `admin` gets the dispatcher console: an administrator is a superuser of the
 * dispatcher role, and a separate read-only variant is not a Phase 1 cost worth
 * paying.
 */
export function DashboardView() {

  const { role, user } = useResolvedSession();

  // Only reachable outside `RequireSession`, which the provider warns about in
  // development. The dashboard variant is decided by the role, so there is nothing
  // to choose without one.
  if (role === null) return null;

  if (isResponderRole(role)) {
    return <ResponderDashboard userUid={user?.uid ?? ''} />;
  }

  return <DispatcherDashboard role={role} />;
}

function isResponderRole(role: UserRole): boolean {
  return role === 'responder';
}

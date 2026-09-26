import type { Metadata } from 'next';

import { mockUserForRole } from '@/lib/mock-data';
import { DashboardView } from '@/features/dashboard/dashboard-view';
import { RoleGate } from '@/features/shared/role-gate';

/**
 * `/dashboard` — the live work surface (docs/04 §13.7).
 *
 * A server component on purpose: metadata is resolved here and only the
 * role-dependent view is a client component. The 403 for a citizen is rendered
 * IN PLACE by `RoleGate` (the `(app)` group layout already provides `AppShell`),
 * never by a redirect (docs/04 §13.22).
 *
 * The allowed set is `responder | dispatcher | admin` — a citizen has no console
 * here (FR-067).
 */
export const metadata: Metadata = {
  title: 'Dashboard',
  description:
    'Live incident queue, response targets, and your active assignments. Demo data only.',
};

export default function Page() {
  // Read once, for a screen-reader orientation line only. The real gate is
  // `RoleGate`, and from Phase 2 this becomes the signed-in session user.
  const dispatcher = mockUserForRole('dispatcher');

  return (
    <RoleGate href="/dashboard">
      <p className="sr-only">
        Demo account behind this shell: {dispatcher.displayName}, a dispatcher. Switch the preview
        role in the top bar to see the responder view.
      </p>
      <DashboardView />
    </RoleGate>
  );
}

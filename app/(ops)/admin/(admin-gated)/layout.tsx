import type { ReactNode } from 'react';

import { AppShell } from '@/components/layout';
import { RequireSession } from '@/components/auth/require-session';

/**
 * `(admin-gated)` — routes even a dispatcher may not open.
 *
 * A separate group from `(ops)` so `/admin/audit-logs` (dispatcher, read-only)
 * and `/admin` (admin only) can have different gates WITHOUT a redirect between
 * them. One layout, one gate, one rendering of `ForbiddenState` in place.
 */
export default function AdminGatedLayout({ children }: { children: ReactNode }) {
  return (
    <RequireSession requiredRoles={['admin']}>
      <AppShell>{children}</AppShell>
    </RequireSession>
  );
}

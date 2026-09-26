import type { ReactNode } from 'react';

import { AppShell } from '@/components/layout';
import { RequireSession } from '@/components/auth/require-session';

/**
 * (ops) layout — routes at `/admin/**`.
 *
 * ---------------------------------------------------------------------------
 * TWO GATES, NOT ONE, AND THE ORDER MATTERS
 * ---------------------------------------------------------------------------
 * `requiredRoles={['dispatcher', 'admin']}` here, because `/admin/audit-logs`,
 * `/admin/incidents`, and `/admin/settings` are readable by a dispatcher.
 * `(admin-gated)` then narrows to `['admin']` for `/admin` itself.
 *
 * Both render `ForbiddenState` IN PLACE. Neither redirects: a redirect from a
 * forbidden URL to a forbidden URL is exactly the loop docs/05 §13.22 forbids,
 * and it would leave the address bar lying about where the person is.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO MIDDLEWARE
 * ---------------------------------------------------------------------------
 * docs/05 §9.1 sketches an Edge middleware that reads a session cookie.
 * docs/10 §12.1 and §12.3 state this product uses NO session cookies — every API
 * call carries `Authorization: Bearer <Firebase ID token>`. So there is nothing
 * at the Edge to read, and the Firestore Admin SDK (the only way to read the
 * authoritative role) does not run on the Edge runtime.
 *
 * Rather than invent a cookie to satisfy the sketch, this build does what
 * docs/05 §9.2 prescribes: the client gate is a convenience, and the
 * authoritative checks are `requireUser()` in every route handler plus
 * `firestore.rules`. A middleware that redirected on an unverifiable cookie
 * would be a security control that looks like one — worse than none, because it
 * would be trusted.
 *
 * A layout file may only export `default`, `metadata`, and the framework's
 * config hooks; anything else here is a build error, so the admin pieces live
 * in their own modules.
 */
export default function OpsLayout({ children }: { children: ReactNode }) {
  return (
    <RequireSession requiredRoles={['dispatcher', 'admin']}>
      <AppShell>{children}</AppShell>
    </RequireSession>
  );
}

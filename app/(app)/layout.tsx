import { AppShell } from '@/components/layout';
import { RequireSession } from '@/components/auth/require-session';

/**
 * `(app)` route group — the authenticated chrome.
 *
 * ---------------------------------------------------------------------------
 * `RequireSession` WRAPS `AppShell`, not the other way round
 * ---------------------------------------------------------------------------
 * A signed-out visitor must not see the shell for even one frame: the sidebar
 * would render a dispatcher's navigation, the top bar a dispatcher name, and the
 * bottom bar an operations surface. So the gate is outside, and the shell only
 * mounts once a session is resolved.
 *
 * While the session resolves the gate renders a skeleton shaped like the shell,
 * so the page does not jump when it arrives (docs/04 §9.1).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 * It is a redirect convenience. It reads the browser's own session, so anyone
 * can bypass it by editing client state — and all they get is buttons the API
 * rejects with `403`. The boundaries are `requireUser()` in every route handler
 * and `firestore.rules`. See `lib/server/auth-guard.ts` for why there is no
 * middleware (docs/05 §9.2: no session cookie exists to read at the Edge).
 *
 * ---------------------------------------------------------------------------
 * NO `requiredRoles` HERE
 * ---------------------------------------------------------------------------
 * `/report`, `/incidents`, `/profile`, `/settings`, and `/notifications` are open
 * to all four roles (docs/04 §13.2, §13.8, §13.14, §13.15, §13.16). Role-gated
 * routes declare their own list: `(ops)` for operations, `RoleGate` for the
 * route-level overrides (`/analytics`, `/map`, `/responders`).
 */
export default function AppRouteLayout({ children }: { children: React.ReactNode }) {
  return <RequireSession>{<AppShell>{children}</AppShell>}</RequireSession>;
}

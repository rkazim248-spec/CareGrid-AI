import { RequireSession } from '@/components/auth/require-session';

/**
 * `(auth)` route group shell — docs/04 §13.3.
 *
 * `/track` is reachable without the app chrome: a person following a reference
 * link from a text message should not land in a dispatcher console. So this
 * group gets the wordmark, the sign-in link, one `<main>`, and the demo
 * disclaimer — nothing else. The chrome lives in `TrackView` itself, which
 * knows whether a session exists.
 *
 * ---------------------------------------------------------------------------
 * THE SESSION IS REQUIRED HERE TOO
 * ---------------------------------------------------------------------------
 * `/track` reads a report, and a report belongs to a person. docs/05 §9.3 lists
 * `(auth)` as "session required, no role assertion": any of the four roles may
 * track a report, but a signed-out visitor is redirected to
 * `/login?next=/track?ref=…` so they arrive back where they meant to go.
 */
export default function AuthRouteLayout({ children }: { children: React.ReactNode }) {
  return <RequireSession>{children}</RequireSession>;
}

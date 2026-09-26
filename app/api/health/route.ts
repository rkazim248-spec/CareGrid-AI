/**
 * GET /api/health
 *
 * Public liveness. No token, no database read, no secrets (docs/08 §9.3).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not read Firestore, and it does not report whether the Admin SDK is
 * configured. A health endpoint that reports configuration state to anonymous
 * callers is a reconnaissance endpoint: it tells an attacker exactly which
 * pieces of the deployment are missing, which is a short list of things to try
 * next (docs/10 §16.3, control 7).
 *
 * `status` is therefore derived ONLY from whether the PUBLIC config is present —
 * which the browser already knows — plus nothing else. The richer picture lives
 * at `GET /api/admin/system/health`, which is admin-gated, and which does
 * report variable NAMES and never values.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LANDING PAGE STILL USES IT
 * ---------------------------------------------------------------------------
 * docs/04 §13.1 has the landing page show a system-status line from this
 * endpoint. That is only honest if the line means something. `ok` here means
 * "the public configuration resolved", which is a real, checkable condition, and
 * the copy on the page says "configuration" rather than "operational" so it is
 * not read as a service-level claim.
 *
 * ---------------------------------------------------------------------------
 * WHY `uptimeSec` IS HERE
 * ---------------------------------------------------------------------------
 * docs/06 §1.3 asks for it, and on Vercel it is the only visible signal of the
 * warm/cold ratio — which is the first thing to check when a route is slow. A
 * Vercel instance lives for minutes, so a value in the hundreds is normal; a
 * value in the tens of thousands means a long-lived process, i.e. `next dev`,
 * and is itself the answer.
 *
 * It is NOT a secret and NOT a fingerprint: it is a duration since process
 * start, and it reveals nothing about the deployment's configuration.
 */

import { withRequest } from '@/lib/server/route';
import { isFirebaseConfigured } from '@/lib/env.client';
import { uptimeSec, type HealthDto } from '@/lib/server/serialize';
import { API_SERVICE_NAME, API_VERSION } from '@/lib/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRequest(
  {
    auth: 'none',
    // The one route that answers when the deployment is unconfigured. A liveness
    // endpoint that 503s because a secret is missing is a false negative on the
    // one endpoint that must always work — and it would page an operator for the
    // exact condition it exists to describe.
    allowUnconfigured: true,
    // docs/10 §17.3: the only IP-limited unauthenticated route, 60/min.
    rateLimit: 'health.read',
  },
  async () => {
    const payload: HealthDto = {
      // Nothing in this route needs the Admin SDK, and it deliberately reports
      // nothing about server configuration.
      status: isFirebaseConfigured() ? 'ok' : 'degraded',
      service: API_SERVICE_NAME,
      version: API_VERSION,
      uptimeSec: uptimeSec(),
      timestamp: new Date().toISOString(),
    };

    // `public, max-age=5` rather than the API's blanket `no-store`: a liveness
    // probe hits this on an interval, and an uncached poll from every CDN edge
    // is wasted work. FIVE seconds, so a restart is visible within a poll
    // interval and a stale `ok` cannot outlive a real outage by long.
    return { data: payload, headers: { 'Cache-Control': 'public, max-age=5' } };
  },
);

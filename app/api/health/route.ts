/**
 * GET /api/health
 *
 * Public liveness. No token, no database read, no secrets (docs/08 §12.3).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not read Firestore, and it does not report whether the Admin SDK is
 * configured. A health endpoint that reports configuration state to anonymous
 * callers is a reconnaissance endpoint: it tells an attacker exactly which
 * pieces of the deployment are missing, which is a short list of things to try
 * next.
 *
 * `status` is therefore a constant derived from whether the PUBLIC config is
 * present — which the browser already knows — plus nothing else. A richer
 * `adminSystemHealth()` endpoint exists in the docs for operators and is
 * admin-gated; this is the public one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LANDING PAGE STILL USES IT
 * ---------------------------------------------------------------------------
 * docs/04 §13.1 has the landing page show a system-status line from this
 * endpoint. That is only honest if the line means something. `ok` here means
 * "the public configuration resolved", which is a real, checkable condition, and
 * the copy on the page says "configuration" rather than "operational" so it is
 * not read as a service-level claim.
 */

import { withRequest } from '@/lib/server/route';
import { isFirebaseConfigured } from '@/lib/env.client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bumped by hand on release; the client shows it in the footer. */
const VERSION = '0.1.0-phase2';

export const GET = withRequest(
  {
    auth: 'none',
    // The one route that answers when the deployment is unconfigured. A liveness
    // endpoint that 503s because a secret is missing is a false negative on the
    // one endpoint that must always work — and it would page an operator for the
    // exact condition it exists to describe.
    allowUnconfigured: true,
  },
  async () => ({
    data: {
      // Nothing in this route needs the Admin SDK, and it deliberately reports
      // nothing about server configuration: a health endpoint that enumerates
      // which pieces of the deployment are missing is a reconnaissance endpoint.
      // The public config is the only thing a browser could already know.
      status: isFirebaseConfigured() ? ('ok' as const) : ('degraded' as const),
      version: VERSION,
    },
  }),
);

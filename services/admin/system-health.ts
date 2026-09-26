/**
 * ============================================================================
 * CareGrid AI — the operator health service
 * ============================================================================
 *
 * What `GET /api/admin/system/health` returns: whether each integration is
 * configured, and whether the deployment has any configuration fault that must
 * be fixed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ADMIN-GATED AND `GET /api/health` IS NOT
 * ---------------------------------------------------------------------------
 * Two different questions, and conflating them is a vulnerability.
 *
 *   - `GET /api/health` is PUBLIC. It answers "is the process up", and reports
 *     nothing a browser could not already see. Enumerating which secrets are
 *     missing from a public endpoint is a reconnaissance endpoint: it hands an
 *     attacker a short list of things to try next (docs/30.3 §A6.2).
 *   - This is ADMIN-GATED. It answers "is this deployment correctly configured",
 *     and there is exactly one audience for that.
 *
 * ---------------------------------------------------------------------------
 * WHY ONLY VARIABLE NAMES APPEAR, NEVER VALUES
 * ---------------------------------------------------------------------------
 * docs/10 §16.3, control 7: the admin health endpoint reports configured secret
 * NAMES only. A health page that echoes a value is how a database URL ends up in
 * a screenshot pasted into an issue, and a Firestore private key is 2 KB of
 * base64 that reads as harmless. Every field below is a boolean, a name, or a
 * sentence.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not ping Firestore, Gemini, Maps, or Twilio. docs/06 §1.1 budgets each
 * sub-check at 1.5 s, and a health check that blocks on four third-party
 * services is a health check that reports the third parties' outages as ours.
 * Phase 3 reports CONFIGURATION, which is instantaneous and is the question an
 * operator actually asks when a route returns 503. Phase 9 adds the live pings
 * with the documented 30 s cache.
 */

import 'server-only';

import { API_SERVICE_NAME, API_VERSION } from '@/lib/constants';
import {
  isAdminConfigured,
  integrationStatus,
  rateLimitConfig,
  serverEnvProblems,
} from '@/lib/env.server';
import { getPublicMapsConfig } from '@/lib/env.client';
import { uptimeSec } from '@/lib/server/serialize';
import { geminiSettings, providerStatus as geminiProviderStatus } from '@/services/integrations/gemini';
import {
  mapsSettings,
  providerStatus as mapsProviderStatus,
} from '@/services/integrations/google-maps';
import {
  availableChannels,
  providerStatus as twilioProviderStatus,
  twilioSettings,
} from '@/services/integrations/twilio';
import type { ProviderStatus } from '@/lib/integrations/contracts';

export type SystemHealth = {
  /** `ok` when nothing is wrong; `degraded` when a phase-4+ feature is dark. */
  readonly status: 'ok' | 'degraded';
  readonly service: 'CareGrid AI API';
  readonly version: string;
  readonly timestamp: string;
  readonly uptimeSec: number;
  readonly providers: readonly ProviderStatus[];
  /**
   * Configuration faults that MUST be fixed. An empty array is the only healthy
   * answer; a non-empty one is a list of sentences naming the variable and why.
   */
  readonly problems: readonly string[];
  /** Non-secret tunables, so an operator can see what the build is using. */
  readonly settings: {
    readonly gemini: ReturnType<typeof geminiSettings>;
    readonly googleMaps: ReturnType<typeof mapsSettings>;
    readonly twilio: ReturnType<typeof twilioSettings>;
    readonly rateLimit: { readonly store: string; readonly trustProxy: boolean };
    readonly notificationChannels: readonly string[];
    readonly publicMapsConfigured: boolean;
  };
};

/**
 * Build the payload.
 *
 * `status` is `ok` when there are no `problems` — configuration faults that
 * change behaviour. A dark Gemini key is NOT a problem: it is the expected
 * state of Phase 3, it is reported in `providers[]`, and calling it a problem
 * would train an operator to ignore the field.
 */
export function systemHealth(): SystemHealth {
  const providers: ProviderStatus[] = [
    {
      provider: 'firebase-admin',
      configured: isAdminConfigured(),
      requiredVars: ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'],
      problem: integrationStatus().firebaseAdmin.problem,
    },
    geminiProviderStatus(),
    mapsProviderStatus(),
    twilioProviderStatus(),
  ];

  const problems = serverEnvProblems();
  const rateLimit = rateLimitConfig();

  return {
    status: problems.length === 0 ? 'ok' : 'degraded',
    service: API_SERVICE_NAME,
    version: API_VERSION,
    timestamp: new Date().toISOString(),
    uptimeSec: uptimeSec(),
    providers,
    problems,
    settings: {
      gemini: geminiSettings(),
      googleMaps: mapsSettings(),
      twilio: twilioSettings(),
      rateLimit: { store: rateLimit.store, trustProxy: rateLimit.trustProxy },
      notificationChannels: availableChannels(),
      publicMapsConfigured: getPublicMapsConfig().browserKey !== null,
    },
  };
}

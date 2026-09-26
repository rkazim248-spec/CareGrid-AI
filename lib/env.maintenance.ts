/**
 * ============================================================================
 * CareGrid AI — maintenance mode accessor
 * ============================================================================
 *
 * Split out of `lib/env.server.ts` because that module is `server-only` and the
 * test needs to read the flag without booting the Admin SDK.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAINTENANCE MODE IS FOR
 * ---------------------------------------------------------------------------
 * It disables the endpoints that make the platform costly while it is being
 * demonstrated: the Gemini calls, the notification fan-out, and the scheduled
 * analytics recompute. docs/10 §18 and docs/08 §10 describe it.
 *
 * It is NOT a kill switch for authentication. A person must always be able to
 * sign in and read their own reports, even while maintenance is on — a kill
 * switch that locks people out of their own emergency reports during a
 * scheduled demo is worse than the cost it saves.
 *
 * ---------------------------------------------------------------------------
 * WHY `ENABLE_MAINTENANCE_JOBS` AND NOT A CONFUSED NAME
 * ---------------------------------------------------------------------------
 * It gates the CRON paths, not the whole app. The name says jobs because that is
 * what it turns on; renaming it to `MAINTENANCE_MODE` would invite someone to
 * gate authentication on it, which is the mistake this comment exists to prevent.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * `true` when the scheduled jobs are enabled.
 *
 * Reads `process.env` directly rather than going through `getServerEnv()`, so it
 * works in a client bundle, a test, and a build-time evaluation. The value is a
 * boolean, so there is nothing secret here and nothing to leak.
 */
export function isMaintenance(): boolean {
  return TRUE_VALUES.has((process.env.ENABLE_MAINTENANCE_JOBS ?? '').trim().toLowerCase());
}

/**
 * A caller-facing reason when a maintenance-gated route is refused, or `null`
 * when the route is not gated.
 *
 * The sentence names the missing secret, because an operator reading a 422 needs
 * to know what to set. It is shown to ADMINISTRATORS only — the route that calls
 * this is admin-gated, so there is no information disclosure.
 */
export function maintenanceProblem(): string | null {
  if (!isMaintenance()) return null;
  if ((process.env.CRON_SECRET ?? '').trim() === '') {
    return 'Maintenance jobs are disabled: set CRON_SECRET and enable them in the deployment.';
  }
  return null;
}

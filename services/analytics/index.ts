/**
 * The analytics surface.
 *
 * `docs/14` splits the system into operational metrics (§2, read on request) and
 * risk analytics (§6, precomputed). Both aggregators live here so a route imports
 * one module rather than reaching into `aggregate.ts` directly.
 *
 * `server-only` is asserted by security check "No client-reachable file imports a
 * server module": everything reachable from here touches the Admin SDK.
 */

import 'server-only';

export {
  DEFAULT_RANGE_DAYS,
  RANGE_PRESETS,
  resolvePresetDates,
  type RangePreset,
  MIN_INCIDENTS_PER_ZONE,
  assembleAnalytics,
  buildAnalytics,
  buildRiskZones,
  toResponse,
  type AnalyticsFilters,
  type AnalyticsResponse,
} from './aggregate';
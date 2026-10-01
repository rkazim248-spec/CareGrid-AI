import { z } from 'zod';

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import {
  RANGE_PRESETS,
  buildAnalytics,
  resolvePresetDates,
  type AnalyticsFilters,
  type RangePreset,
} from '@/services/analytics';
import { MAX_RANGE_DAYS, RISK_ZONES_ENABLED } from '@/config/analytics';
import { INCIDENT_CATEGORIES, INCIDENT_STATUSES, URGENCIES } from '@/types/enums';

/**
 * The query schema.
 *
 * Every axis is OPTIONAL and defaults to null, meaning "not filtered" rather than
 * "matches nothing". `brief §6` requires date, category, priority, status and area;
 * `area` is applied as a geohash prefix so it is an INDEXED range rather than a
 * client-side filter over returned coordinates.
 *
 * `noUncheckedIndexedAccess` makes a bare `params[0]` `string | undefined`, so every
 * read below is guarded — an empty query string must be "no filter", never a crash.
 */
const analyticsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  preset: z.enum(RANGE_PRESETS).optional(),
  category: z.enum(INCIDENT_CATEGORIES).optional(),
  urgency: z.enum(URGENCIES).optional(),
  status: z.enum(INCIDENT_STATUSES).optional(),
  /** `docs/14 §2.5` filters on a geohash CELL, never a raw coordinate pair. */
  cell: z.string().regex(/^[0-9b-hjkmnp-z]{4,6}$/).optional(),
});

/** Resolve `brief §2`'s named ranges against a supplied clock. */

/**
 * `docs/14 §6.1`: risk zones are behind `ENABLE_RISK_ZONES`, default `false` (P1).
 *
 * Read from `config/analytics.ts` rather than from the environment here, because
 * that module is the documented single source and security check C63 asserts the
 * value. Reading `process.env` in a route would create a second place the flag is
 * decided, and the two could disagree.
 */
function riskZonesServed(): boolean {
  return RISK_ZONES_ENABLED;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRequest(
  {
    query: analyticsQuerySchema,
    auth: 'required',
    /**
     * `docs/10 §17.1`. Analytics is an EXPENSIVE read — it scans up to
     * `LIVE_SCAN_CAP` documents and aggregates them — so it is bounded like the
     * dispatch reads rather than left open. 60/min is far above the rate at which a
     * dashboard re-requests and well below the rate at which the scan becomes a way
     * to burn Firestore reads.
     */
    rateLimit: 'analytics.read',
  },
  async (ctx) => {
    const { query, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    /**
     * `docs/14 §10`: `GET /api/analytics` is dispatcher/admin, else 403.
     * `r50_recomputeAnalytics` is admin-only and is a DIFFERENT operation — this
     * route only reads.
     */
    requireCapability(user, 'r48_readOperationalAnalytics', { requestId: ctx.requestId });

    const now = new Date();
    const preset: RangePreset = query?.preset ?? '30d';
    const dates = query?.from !== undefined && query?.to !== undefined
      ? { from: query.from, to: query.to }
      : resolvePresetDates(preset, now);

    const filters: AnalyticsFilters = {
      from: dates.from,
      to: dates.to,
      category: query?.category ?? null,
      urgency: query?.urgency ?? null,
      status: query?.status ?? null,
    };

    const spanDays =
      (Date.parse(`${filters.to}T23:59:59Z`) - Date.parse(`${filters.from}T00:00:00Z`)) / 86_400_000;
    if (Number.isFinite(spanDays) && spanDays > MAX_RANGE_DAYS) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: `Choose a range of ${MAX_RANGE_DAYS} days or fewer.`,
      });
    }

    const { analytics, riskZones, zonesOmittedForLowCount } = await buildAnalytics(filters, now);

    /**
     * `docs/14 §6.1`: the flag gates whether zones are SERVED, not whether they are
     * computed — the computation is tested independently so it stays correct while
     * the feature stays off.
     */
    if (!riskZonesServed()) {
      return {
        data: {
          ...analytics,
          riskZones: [],
          riskZonesWithheld: riskZones.length,
          zonesOmittedForLowCount,
        },
      };
    }

    return {
      data: { ...analytics, riskZones, riskZonesWithheld: 0, zonesOmittedForLowCount },
    };
  },
);
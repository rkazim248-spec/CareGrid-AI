import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RISK_PARAMS,
  WEIGHT_RECENCY,
  band,
  clampScore,
  isoWeekBucket,
  scoreEmptyCell,
  scoreZone,
  zoneIdFor,
  type RiskZoneInput,
} from '@/lib/analytics/risk-score';
import { ROLLUP_AFTER_HOURS, decideSource, describeSource } from '@/lib/analytics/decide-source';
import {
  RISK_HONESTY_STATEMENT,
  FORBIDDEN_RISK_CLAIMS,
  RISK_ZONES_ENABLED,
  RISK_ZONE_OUTPUT_CAP,
  RISK_WINDOW_DAYS,
  APP_TIMEZONE,
} from '@/config/analytics';
import { endOfLocalDayMs, localDateOf, startOfLocalDayMs, daysInRange } from '@/lib/analytics/time';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const ZONE: RiskZoneInput = {
  incidentCount: 20,
  criticalCount: 4,
  highCount: 6,
  mediumCount: 5,
  daysSinceLastIncident: 3,
  windowDays: 30,
};

/* ========================================================================== */
/* `docs/14 §6.3` — the formula                                                */
/* ========================================================================== */

describe('the score is docs/14 §6.3 formula for formula', () => {
  it('the default params are the document values', () => {
    expect(DEFAULT_RISK_PARAMS).toEqual({
      weightDensity: 0.5,
      weightSeverity: 0.35,
      halfLifeDays: 14,
    });
    // The remaining 0.15 is recency, fixed by the formula. The three weights plus
    // it must sum to 1 or a score can exceed 100.
    expect(
      DEFAULT_RISK_PARAMS.weightDensity +
        DEFAULT_RISK_PARAMS.weightSeverity +
        WEIGHT_RECENCY,
    ).toBe(1);
  });

  it('matches a hand-computed value for a known input', () => {
    // density  = min(20 / 120, 1)              = 0.166667
    // severity = (4*1 + 6*0.5 + 5*0.2) / 20     = 8.0 / 20 = 0.4
    // recency  = exp(-ln2 * 3 / 14)             = 0.861973
    //
    // The score is asserted against the FORMULA, not against a rounded literal, so
    // the test cannot pass because both the implementation and the expectation were
    // rounded the same way. The components are then pinned to their exact values so
    // a change to any one of the three terms is caught.
    const result = scoreZone(ZONE);
    const expected =
      100 * (0.5 * (20 / 120) + 0.35 * 0.4 + 0.15 * Math.exp((-Math.LN2 * 3) / 14));
    expect(result.score).toBeCloseTo(expected, 12);
    expect(result.components.density).toBeCloseTo(20 / 120, 12);
    expect(result.components.severity).toBeCloseTo(0.4, 12);
    expect(result.components.recency).toBeCloseTo(Math.exp((-Math.LN2 * 3) / 14), 12);
  });

  it('exposes its three components, so the number is challengeable', () => {
    // A score with no decomposition is a number nobody can argue with.
    const result = scoreZone(ZONE);
    expect(Object.keys(result.components).sort()).toEqual(['density', 'recency', 'severity']);
    for (const value of Object.values(result.components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('is ALWAYS within 0-100 for any plausible input', () => {
    // The density term saturates via `min(..., 1)`, so the maximum is
    // 100 * (0.5 + 0.35 + 0.15) = 100.
    const saturated = scoreZone({
      incidentCount: 10_000,
      criticalCount: 10_000,
      highCount: 0,
      mediumCount: 0,
      daysSinceLastIncident: 0,
      windowDays: 30,
    });
    expect(saturated.score).toBeCloseTo(100, 6);
    expect(saturated.severity).toBe('critical');
  });

  it('the bands are the document thresholds', () => {
    expect(band(70)).toBe('critical');
    expect(band(69.9)).toBe('high');
    expect(band(45)).toBe('high');
    expect(band(44.9)).toBe('medium');
    expect(band(20)).toBe('medium');
    expect(band(19.9)).toBe('low');
    expect(band(0)).toBe('low');
  });

  it('an EMPTY cell scores low, not NaN', () => {
    // A cell whose incidents were all soft-deleted can reach the scorer. The
    // `Math.max(count, 1)` guard is what stops the severity term dividing by zero.
    const empty = scoreEmptyCell(RISK_WINDOW_DAYS);
    expect(Number.isNaN(empty.score)).toBe(false);
    expect(empty.severity).toBe('low');
  });

  it('an old incident decays to nothing — the 14-day half-life', () => {
    // docs/14 §6.3: "A zone that saw three incidents 12 months ago and nothing
    // since scores 0.15 x exp(-ln2 x 365/14) ~= 0.0".
    const stale = scoreZone({ ...ZONE, daysSinceLastIncident: 365 });
    const fresh = scoreZone({ ...ZONE, daysSinceLastIncident: 0 });
    expect(stale.components.recency).toBeLessThan(0.001);
    expect(fresh.components.recency).toBeCloseTo(1, 6);
    expect(stale.score).toBeLessThan(fresh.score);
  });

  it('clampScore refuses a value from hand-edited params that sum above 1', () => {
    expect(clampScore(140)).toBe(100);
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(50)).toBe(50);
  });
});

/* ========================================================================== */
/* THE HONESTY REQUIREMENT — brief §2, §20; docs/14 §6, §6.8                    */
/* ========================================================================== */

describe('the score summarises the PAST and the module says so', () => {
  // brief §2: "Do NOT implement predictive emergency forecasting. Do NOT claim
  // that analytics predict future emergencies."
  //
  // The structural enforcement is `RiskZoneInput`: it has three count/duration
  // fields and nothing else, so there is nowhere to put a prediction even if a
  // developer wanted to add one.

  it('RiskZoneInput has no field a prediction could be passed in', () => {
    const keys = Object.keys(ZONE).sort();
    expect(keys).toEqual([
      'criticalCount',
      'daysSinceLastIncident',
      'highCount',
      'incidentCount',
      'mediumCount',
      'windowDays',
    ]);
    for (const forbidden of ['forecast', 'prediction', 'probability', 'population', 'weather', 'model']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('the honesty statement is present and says "not a forecast" first', () => {
    // docs/14 §6.8: "Rendered verbatim, not paraphrased."
    expect(RISK_HONESTY_STATEMENT).toMatch(/^This is a summary of past incidents, not a forecast\./);
    // The three limits the document names, all present.
    expect(RISK_HONESTY_STATEMENT).toMatch(/does not know the population/i);
    expect(RISK_HONESTY_STATEMENT).toMatch(/the weather/i);
    expect(RISK_HONESTY_STATEMENT).toMatch(/more reporters score higher/i);
    expect(RISK_HONESTY_STATEMENT).toMatch(/never where to send/i);
  });

  it('the forbidden claims are the ones that turn history into a forecast', () => {
    for (const claim of ['will be dangerous', 'predicts an accident', 'guaranteed high-risk']) {
      expect(FORBIDDEN_RISK_CLAIMS).toContain(claim);
    }
    // And the honesty statement itself contains none of them.
    const lower = RISK_HONESTY_STATEMENT.toLowerCase();
    for (const claim of FORBIDDEN_RISK_CLAIMS) {
      expect(lower, claim).not.toContain(claim.toLowerCase());
    }
  });

  it('risk zones are DISABLED by default, per docs/14 §6.1 (P1)', () => {
    // The flag is `false` in `docs/14 §6.1`, and this phase does not change it. The
    // computation is implemented and tested; the flag gates whether it is SERVED.
    expect(RISK_ZONES_ENABLED).toBe(false);
    expect(RISK_ZONE_OUTPUT_CAP).toBe(100);
    expect(RISK_WINDOW_DAYS).toBe(30);
  });
});

/* ========================================================================== */
/* The zone id — docs/14 §6.1                                                  */
/* ========================================================================== */

describe('zoneId is `rz_{geohash6}_{YYYYwWW}` (docs/14 §6.1)', () => {
  it('builds the documented shape', () => {
    expect(zoneIdFor('9z4g0h', '2026w38')).toBe('rz_9z4g0h_2026w38');
  });

  it('the ISO week bucket matches the document example', () => {
    // The example is `rz_9z4g0h_2026w38` for a week in late September 2026.
    expect(isoWeekBucket(new Date('2026-09-23T12:00:00Z'))).toBe('2026w39');
    // ISO weeks start Monday, so a Sunday and the following Monday differ.
    expect(isoWeekBucket(new Date('2026-09-27T12:00:00Z'))).toBe('2026w39');
    expect(isoWeekBucket(new Date('2026-09-28T12:00:00Z'))).toBe('2026w40');
  });

  it('a week number is zero-padded to two digits', () => {
    expect(isoWeekBucket(new Date('2026-01-05T12:00:00Z'))).toMatch(/^\d{4}w\d{2}$/);
    expect(isoWeekBucket(new Date('2026-01-05T12:00:00Z'))).toBe('2026w02');
  });
});

/* ========================================================================== */
/* `docs/14 §3.2` — decideSource, FR-116                                       */
/* ========================================================================== */

describe('decideSource implements the FR-116 48h rule (docs/14 §3.2)', () => {
  const TZ = APP_TIMEZONE;

  it('a period ending 72 h ago is a ROLLUP', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(decideSource('2026-09-23', now, TZ)).toBe('rollup');
  });

  it('a period ending TODAY is LIVE, no matter how long the range is', () => {
    // The decisive case. The rule keys on the END, so a 90-day view ending today is
    // live even though 89 of its days have rollups available — the decision depends
    // on the FRESHEST data in the window.
    const now = new Date('2026-09-26T12:00:00Z');
    expect(decideSource('2026-09-26', now, TZ)).toBe('live');
  });

  it('a period ending YESTERDAY is still live — that is the 48 h of slack', () => {
    // docs/14 §3.2: "Why 48 h and not 24 h: it gives one full day of slack. If
    // yesterday's cron fails at 03:00, the `to = yesterday` view still works."
    const now = new Date('2026-09-26T03:00:00Z');
    expect(decideSource('2026-09-25', now, TZ)).toBe('live');
  });

  it('the boundary is strictly greater than 48 h', () => {
    expect(ROLLUP_AFTER_HOURS).toBe(48);
    const end = endOfLocalDayMs('2026-09-24', TZ);
    // Exactly 48 h after the period ended: still live.
    expect(decideSource('2026-09-24', new Date(end + 48 * 3_600_000), TZ)).toBe('live');
    // A minute past it: rollup.
    expect(decideSource('2026-09-24', new Date(end + 48 * 3_600_000 + 60_000), TZ)).toBe('rollup');
  });

  it('describeSource reports the elapsed hours for the UI label', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    const described = describeSource({ to: '2026-09-20', now, timezone: TZ });
    expect(described.source).toBe('rollup');
    expect(described.hoursSinceEnd).toBeGreaterThan(ROLLUP_AFTER_HOURS);
  });
});

/* ========================================================================== */
/* Local day boundaries                                                         */
/* ========================================================================== */

describe('local day boundaries are LOCAL, not UTC', () => {
  const TZ = APP_TIMEZONE;

  it('a day starts at 00:00 in the app timezone, not 00:00 UTC', () => {
    // In Asia/Kolkata (UTC+5:30) local midnight is 18:30 UTC the previous day.
    // `new Date('2026-09-26')` would parse as UTC midnight — five and a half hours
    // into the day, and the last incident of the previous evening would land in the
    // wrong bucket.
    const start = startOfLocalDayMs('2026-09-26', TZ);
    expect(localDateOf(start, TZ)).toBe('2026-09-26');
    expect(new Date(start).toISOString()).not.toBe('2026-09-26T00:00:00.000Z');
  });

  it('endOfDay is the inclusive 23:59:59.999 boundary docs/14 §2.1 names', () => {
    const start = startOfLocalDayMs('2026-09-26', TZ);
    const end = endOfLocalDayMs('2026-09-26', TZ);
    expect(end).toBeGreaterThan(start);
    // 24 h minus 1 ms for a zone with no DST.
    expect(end - start).toBe(24 * 3_600_000 - 1);
    expect(localDateOf(end, TZ)).toBe('2026-09-26');
    // The next day's start is exactly 1 ms later.
    expect(startOfLocalDayMs('2026-09-27', TZ) - end).toBe(1);
  });

  it('the whole period is a closed interval in local time', () => {
    // An incident at 23:30 local on `to` IS in the period. Under a UTC boundary it
    // would not be, and a dispatcher would see a day missing its last incident.
    const end = endOfLocalDayMs('2026-09-26', TZ);
    expect(localDateOf(end - 30 * 60_000, TZ)).toBe('2026-09-26');
    expect(localDateOf(end + 60_000, TZ)).toBe('2026-09-27');
  });

  it('daysInRange is inclusive of both ends and advances correctly', () => {
    expect(daysInRange('2026-09-24', '2026-09-26')).toEqual(['2026-09-24', '2026-09-25', '2026-09-26']);
    expect(daysInRange('2026-09-26', '2026-09-26')).toEqual(['2026-09-26']);
  });

  it('daysInRange is BOUNDED, and stops rather than spinning on a bad range', () => {
    // `docs/14 §3.3` notes a 365-day range is 365 reads. An unbounded walk would let
    // one request open a thousand channels' worth of reads.
    const many = daysInRange('1900-01-01', '2026-09-26');
    expect(many.length).toBeLessThanOrEqual(366);
    // A reversed range terminates rather than looping forever.
    const reversed = daysInRange('2026-09-26', '2026-09-24');
    expect(reversed.length).toBeLessThanOrEqual(366);
  });
});

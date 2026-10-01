import { describe, expect, it } from 'vitest';

import { boundsForZones, zonesToGeoJson } from '@/features/analytics/risk-map';
import { FORBIDDEN_RISK_CLAIMS, RISK_HONESTY_STATEMENT } from '@/config/analytics';
import { MIN_INCIDENTS_PER_ZONE, buildRiskZones } from '@/services/analytics/aggregate';
import type { MetricIncident } from '@/lib/analytics/metrics';
import type { RiskZone } from '@/types';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const DAY = 86_400_000;
const NOW = new Date('2026-09-26T12:00:00Z');

function zone(over: Partial<RiskZone> = {}): RiskZone {
  return {
    zoneId: 'rz_9z4g0h_2026w39',
    centre: { lat: 24.86, lng: 67.0 },
    radiusM: 500,
    score: 62.5,
    severity: 'high',
    incidentCount: 7,
    criticalCount: 2,
    dominantCategory: 'medical',
    computedAt: NOW.toISOString(),
    ...over,
  };
}

/* ========================================================================== */
/* The GeoJSON projection                                                      */
/* ========================================================================== */

describe('the map projects ZONES, never individual reported positions', () => {
  it('coordinates are [lng, lat] — GeoJSON order, not the app\'s lat-first order', () => {
    // Get this backwards and every marker lands in the wrong hemisphere. GeoJSON is
    // [longitude, latitude]; the rest of the app is lat-first.
    const [feature] = zonesToGeoJson([zone()]).features;
    expect(feature?.geometry.coordinates).toEqual([67.0, 24.86]);
  });

  it('carries the incident count so the map and the table cannot drift', () => {
    const [feature] = zonesToGeoJson([zone({ incidentCount: 11 })]).features;
    expect(feature?.properties.incidentCount).toBe(11);
    // And the score, which is what the heat weighting reads.
    expect(feature?.properties.score).toBe(62.5);
  });

  it('normalises the weight to 0..1, clamping out-of-range scores', () => {
    expect(zonesToGeoJson([zone({ score: 0 })]).features[0]?.properties.weight).toBe(0);
    expect(zonesToGeoJson([zone({ score: 100 })]).features[0]?.properties.weight).toBe(1);
    // A score above 100 would over-drive `heatmap-weight` and saturate the ramp, so
    // the projection clamps rather than trusting the value.
    expect(zonesToGeoJson([zone({ score: 140 })]).features[0]?.properties.weight).toBe(1);
    expect(zonesToGeoJson([zone({ score: -5 })]).features[0]?.properties.weight).toBe(0);
  });

  it('an EMPTY zone list produces a valid empty FeatureCollection', () => {
    const doc = zonesToGeoJson([]);
    expect(doc.type).toBe('FeatureCollection');
    expect(doc.features).toEqual([]);
  });

  it('carries NO field that could identify a reporter', () => {
    // brief §8: analytics must not expose personal information. The projection's
    // property set is the whole surface the map can see, so asserting it is closed is
    // what makes the privacy claim structural rather than aspirational.
    const [feature] = zonesToGeoJson([zone()]).features;
    const keys = Object.keys(feature?.properties ?? {}).sort();
    expect(keys).toEqual(['incidentCount', 'score', 'severity', 'weight', 'zoneId']);
    const serialised = JSON.stringify(feature ?? {});
    for (const forbidden of ['reporterUid', 'displayName', 'phone', 'address', 'reporterCount']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });
});

/* ========================================================================== */
/* Viewport                                                                    */
/* ========================================================================== */

describe('the viewport is computed from the data, not hardcoded', () => {
  it('centres on the midpoint of the zones', () => {
    const { center } = boundsForZones([
      zone({ centre: { lat: 10, lng: 20 } }),
      zone({ centre: { lat: 30, lng: 40 } }),
    ]);
    expect(center).toEqual([30, 20]);
  });

  it('caps the zoom so a tight cluster does not compute a broken viewport', () => {
    // A single zone, or two adjacent ones, would give a near-infinite zoom from a
    // zero-height bounds box.
    expect(boundsForZones([zone()]).zoom).toBeLessThanOrEqual(11);
    expect(boundsForZones([zone(), zone({ centre: { lat: 24.861, lng: 67.001 } })]).zoom).toBeLessThanOrEqual(11);
  });

  it('handles an EMPTY list without producing NaN', () => {
    const { center, zoom } = boundsForZones([]);
    expect(Number.isFinite(center[0])).toBe(true);
    expect(Number.isFinite(center[1])).toBe(true);
    expect(Number.isFinite(zoom)).toBe(true);
  });
});

/* ========================================================================== */
/* brief §20 / docs/14 §6.8 — the honesty constraints on the RENDERED surface   */
/* ========================================================================== */

describe('the heatmap describes the PAST and never a prediction', () => {
  // The claim under test is not "the maths is right" — it is that a reader cannot
  // come away believing the map forecasts anything.
  it('the honesty statement is the docs/14 §6.8 text, opened and closed', () => {
    expect(RISK_HONESTY_STATEMENT).toMatch(/^This is a summary of past incidents, not a forecast\./);
    expect(RISK_HONESTY_STATEMENT).toMatch(/never where to send/i);
  });

  it('the aggregate DOES expose a weight named density, and that is the risk', () => {
    // The word "density" is accurate — it is historical concentration, not predicted
    // intensity. The forbidden list deliberately does NOT contain it, because banning
    // an accurate word would push the copy toward vaguer, less honest phrasing.
    expect(FORBIDDEN_RISK_CLAIMS).not.toContain('density');
    expect(FORBIDDEN_RISK_CLAIMS).toContain('will be dangerous');
    expect(FORBIDDEN_RISK_CLAIMS).toContain('predicts an accident');
  });
});

/* ========================================================================== */
/* End to end: zones -> map projection                                          */
/* ========================================================================== */

describe('a built zone set projects onto the map without losing anything', () => {
  const incidents: MetricIncident[] = Array.from({ length: 9 }, (_v, i) => ({
    id: 'i' + i,
    status: 'resolved',
    urgency: i < 3 ? 'critical' : 'medium',
    category: 'medical',
    createdAtMs: NOW.getTime() - DAY * (i + 1),
    deletedAtMs: null,
    verifiedAtMs: null,
    dispatchedAtMs: null,
    respondedAtMs: null,
    resolvedAtMs: NOW.getTime() - DAY * i,
    slaTargetMin: null,
    reportCount: 1,
    linkedReportCount: 0,
    triageSource: 'ai',
    aiConfidence: 0.8,
    peopleAffected: null,
    geoHash6: '9z4g0h',
  }));

  it('nine incidents in one cell -> exactly one zone -> exactly one map feature', () => {
    const zones = buildRiskZones(incidents, { now: NOW });
    expect(zones).toHaveLength(1);
    const features = zonesToGeoJson(zones).features;
    expect(features).toHaveLength(1);
    // The count survives the projection, so the circle layer can be sized by it.
    expect(features[0]?.properties.incidentCount).toBe(9);
  });

  it('a cell below the minimum produces NO feature — an empty map, not a fake one', () => {
    // brief §3: never label an area from a single incident. The same threshold must
    // hold all the way through to what is drawn.
    const thin = buildRiskZones(incidents.slice(0, MIN_INCIDENTS_PER_ZONE - 1), { now: NOW });
    expect(thin).toHaveLength(0);
    expect(zonesToGeoJson(thin).features).toHaveLength(0);
  });
});
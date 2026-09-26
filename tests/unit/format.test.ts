import { describe, expect, it } from 'vitest';

import {
  formatAge,
  formatBytes,
  formatConfidence,
  formatCount,
  formatDistance,
  formatDuration,
  formatSlaRemaining,
  haversineM,
} from '@/lib/format';

/**
 * Formatter tests. These strings are read by someone deciding whether to drive
 * to an incident, so a wrong unit or a wrong rounding is a safety issue rather
 * than a cosmetic one.
 */
describe('formatDistance', () => {
  it('uses metres below a kilometre and one decimal above', () => {
    expect(formatDistance(640)).toBe('640 m');
    expect(formatDistance(999)).toBe('999 m');
    expect(formatDistance(1000)).toBe('1.0 km');
    expect(formatDistance(2100)).toBe('2.1 km');
  });

  it('renders an em dash for unknown rather than a zero', () => {
    expect(formatDistance(null)).toBe('—');
    expect(formatDistance(undefined)).toBe('—');
    expect(formatDistance(Number.NaN)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('scales the unit with the magnitude', () => {
    expect(formatDuration(47)).toBe('47 s');
    expect(formatDuration(180)).toBe('3 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(4320)).toBe('1 h 12 m');
  });
});

describe('formatSlaRemaining', () => {
  it('reports on_track while time remains', () => {
    expect(formatSlaRemaining(5, 1)).toEqual({ state: 'on_track', text: 'On track · 4 min left' });
  });

  it('reports at_risk inside the last 20% of the target', () => {
    const result = formatSlaRemaining(5, 4);
    expect(result.state).toBe('at_risk');
    expect(result.text).toContain('At risk');
  });

  it('reports breached with a positive overage, never a negative remaining', () => {
    const result = formatSlaRemaining(5, 23);
    expect(result.state).toBe('breached');
    expect(result.text).toBe('Target passed · 18 min over');
  });
});

describe('formatBytes', () => {
  it('uses decimal units to match the upload limits', () => {
    expect(formatBytes(184320)).toBe('184 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.2 MB');
  });
});

describe('formatCount and formatConfidence', () => {
  it('groups counts for an operations console', () => {
    // The `en-IN` grouping in use, verified against the runtime: a four-digit
    // count groups, a three-digit one does not, which is what keeps a KPI tile
    // from shifting width as it counts up.
    expect(formatCount(148)).toBe('148');
    expect(formatCount(1284)).toBe('1,284');
    expect(formatCount(10000)).toBe('10,000');
  });

  it('never renders confidence as a percentage', () => {
    // 83% would invite a reader to treat 0.83 as a probability of truth.
    expect(formatConfidence(0.83)).toBe('0.83');
  });
});

describe('formatAge', () => {
  it('collapses to a scannable phrase', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(4)).toBe('4 min');
    expect(formatAge(90)).toBe('1 h 30 min');
    expect(formatAge(1440)).toBe('1 d');
    expect(formatAge(1500)).toBe('1 d 1 h');
  });
});

describe('haversineM', () => {
  it('is zero for identical points', () => {
    expect(haversineM({ lat: 17.4478, lng: 78.4874 }, { lat: 17.4478, lng: 78.4874 })).toBe(0);
  });

  it('matches the demo dataset pair at ~660 m', () => {
    // The metro gate → market pair from docs/29_DEMO_SCENARIO.md. Verified
    // independently: dLat 0.0024° ≈ 267 m, dLng 0.0057° ≈ 602 m at cos(17.4°).
    const a = { lat: 17.4478, lng: 78.4874 };
    const b = { lat: 17.4502, lng: 78.4931 };
    const metres = haversineM(a, b);
    expect(metres).toBeGreaterThan(640);
    expect(metres).toBeLessThan(680);
  });

  it('straddles the 500 m duplicate boundary correctly (docs/07 §9.1)', () => {
    // 0.0040° of latitude ≈ 445 m (inside); 0.0050° ≈ 557 m (outside).
    const origin = { lat: 17.4478, lng: 78.4874 };
    const inside = haversineM(origin, { lat: 17.4438, lng: 78.4874 });
    const outside = haversineM(origin, { lat: 17.4428, lng: 78.4874 });
    expect(inside).toBeLessThan(500);
    expect(outside).toBeGreaterThan(500);
  });
});

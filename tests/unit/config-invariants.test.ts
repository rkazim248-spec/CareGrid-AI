import { describe, expect, it } from 'vitest';

import { CATEGORY_META, SLA_MINUTES, STATUS_META, URGENCY_META, RESOURCE_CATALOGUE } from '@/config';
import {
  ACTIVE_STATUSES,
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  TERMINAL_STATUSES,
  URGENCIES,
  USER_ROLES,
} from '@/types/enums';

/**
 * The Phase 1 acceptance criteria that are mechanically checkable
 * (docs/30_DEVELOPMENT_PHASE_PLAN.md §4.5):
 *
 *  - config/categories.ts has exactly 11 values
 *  - config/statuses.ts has exactly 11 with a terminal flag
 *  - config/urgencies.ts has exactly 4 with SLA minutes {5,15,60,240}
 *
 * These fail if someone adds a value to a union without adding its metadata,
 * which is the only way the badge components silently render `undefined`.
 */
describe('category table', () => {
  it('has exactly the 11 controlled values (FR-025)', () => {
    expect(INCIDENT_CATEGORIES).toHaveLength(11);
    expect(Object.keys(CATEGORY_META).sort()).toEqual([...INCIDENT_CATEGORIES].sort());
  });

  it('gives every category a label, an icon, and a similarity group', () => {
    for (const category of INCIDENT_CATEGORIES) {
      const meta = CATEGORY_META[category];
      expect(meta.label, `${category} label`).toBeTruthy();
      expect(meta.icon, `${category} icon`).toBeTruthy();
      expect(meta.group, `${category} group`).toBeTruthy();
    }
  });

  it('keeps medical and traffic_accident in different groups (docs/07 §4.2)', () => {
    // Two incidents 20 m apart in these categories must NOT auto-suggest a
    // duplicate; the group is what makes that a data decision.
    expect(CATEGORY_META.medical.group).not.toBe(CATEGORY_META.traffic_accident.group);
  });
});

describe('status table', () => {
  it('has exactly the 11 controlled values (FR-050)', () => {
    expect(INCIDENT_STATUSES).toHaveLength(11);
    expect(Object.keys(STATUS_META).sort()).toEqual([...INCIDENT_STATUSES].sort());
  });

  it('marks exactly 4 statuses terminal', () => {
    const terminal = INCIDENT_STATUSES.filter((s) => STATUS_META[s].terminal);
    expect(terminal).toHaveLength(4);
    expect([...terminal].sort()).toEqual([...TERMINAL_STATUSES].sort());
  });

  it('defines the 7-element active set and no overlap with terminal (docs/07 §12.1)', () => {
    expect(ACTIVE_STATUSES).toHaveLength(7);
    for (const status of ACTIVE_STATUSES) {
      expect(STATUS_META[status].terminal, `${status} must not be terminal`).toBe(false);
    }
  });

  it('includes `resolved` in the active set, not only the queue set', () => {
    // A resolved-but-not-closed incident still has an open audit obligation.
    expect(ACTIVE_STATUSES).toContain('resolved');
  });

  it('gives every status a citizen-facing "what happens next" sentence', () => {
    for (const status of INCIDENT_STATUSES) {
      expect(STATUS_META[status].citizenNext.length, `${status} copy`).toBeGreaterThan(10);
    }
  });

  it('gives only closed/cancelled/false_alarm/merged a next action of closed', () => {
    expect(STATUS_META.closed.nextActions).toHaveLength(0);
    expect(STATUS_META.merged.nextActions).toHaveLength(0);
    expect(STATUS_META.resolved.nextActions).toEqual(['closed']);
  });
});

describe('urgency table', () => {
  it('has exactly the 4 levels (FR-026)', () => {
    expect(URGENCIES).toHaveLength(4);
    expect(Object.keys(URGENCY_META).sort()).toEqual([...URGENCIES].sort());
  });

  it('uses the documented SLA targets {critical:5, high:15, medium:60, low:240}', () => {
    expect(SLA_MINUTES).toEqual({ critical: 5, high: 15, medium: 60, low: 240 });
  });

  it('keeps SLA_MINUTES and URGENCY_META in agreement', () => {
    for (const urgency of URGENCIES) {
      expect(URGENCY_META[urgency].slaMinutes).toBe(SLA_MINUTES[urgency]);
    }
  });

  it('gives every urgency a distinct marker shape (a non-colour channel)', () => {
    const shapes = URGENCIES.map((u) => URGENCY_META[u].shape);
    expect(new Set(shapes).size).toBe(4);
  });

  it('sorts critical first (FR-071 queue order)', () => {
    const ranks = URGENCIES.map((u) => URGENCY_META[u].rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('role table', () => {
  it('has exactly the 4 roles (docs/22 §1)', () => {
    expect(USER_ROLES).toHaveLength(4);
    expect([...USER_ROLES]).toEqual(['citizen', 'responder', 'dispatcher', 'admin']);
  });
});

describe('resource catalogue', () => {
  it('has unique ids and at least the 12 seeded entries (docs/07 §11.1)', () => {
    const ids = RESOURCE_CATALOGUE.map((r) => r.resourceId);
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

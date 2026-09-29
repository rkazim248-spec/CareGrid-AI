import { describe, expect, it } from 'vitest';

import {
  DEMO_CENTER,
  DUPLICATE_RING_TOKENS,
  URGENCY_TOKENS,
  accessibleMarkerLabel,
  buildMarkerSpec,
  shapeForKind,
  shapeForUrgency,
  shouldDrawDuplicateRing,
  textLabelForUrgency,
  zOrderFor,
  type MapUrgency,
} from '@/features/map/marker-spec';

/* ========================================================================== */

describe('urgency is SHAPE, not just colour (brief §11, NFR-017)', () => {
  it('each urgency has a DISTINCT shape', () => {
    // docs/04 §11.1. Roughly 1 in 12 men has a red-green colour vision deficiency,
    // and a marker is ~24 px where two similar oranges are indistinguishable even
    // with perfect vision. The shape is the non-colour channel, so two urgencies
    // sharing one would fail the requirement entirely.
    const shapes = (['critical', 'high', 'medium', 'low', 'unknown'] as const).map(shapeForUrgency);
    expect(new Set(shapes).size).toBe(5);
  });

  it('uses the documented shapes', () => {
    expect(shapeForUrgency('critical')).toBe('triangle');
    expect(shapeForUrgency('high')).toBe('diamond');
    expect(shapeForUrgency('medium')).toBe('circle');
    expect(shapeForUrgency('low')).toBe('square');
    expect(shapeForUrgency('unknown')).toBe('hatched-square');
  });

  it('`null` urgency is the unknown shape, not a fallback to low', () => {
    // "we do not know how urgent this is" and "this is low priority" are different
    // facts, and a citizen must be able to tell them apart.
    expect(shapeForUrgency(null)).toBe('hatched-square');
    expect(shapeForUrgency(null)).not.toBe(shapeForUrgency('low'));
  });

  it('every urgency has a distinct text label too — a THIRD channel', () => {
    const labels = (['critical', 'high', 'medium', 'low', 'unknown'] as const).map(
      textLabelForUrgency,
    );
    expect(new Set(labels).size).toBe(5);
    expect(labels).toContain('CRITICAL');
  });

  it('the text label is a WORD, never a colour name', () => {
    // "red" fails in greyscale and in a screenshot; "CRITICAL" does not.
    for (const urgency of ['critical', 'high', 'medium', 'low', 'unknown'] as const) {
      const label = textLabelForUrgency(urgency);
      expect(label).not.toMatch(/red|orange|yellow|blue|grey|gray|green/i);
    }
  });

  it('every urgency has a distinct design token', () => {
    expect(new Set(Object.values(URGENCY_TOKENS)).size).toBe(5);
  });

  it('the tokens are TAILWIND CLASSES, not hard-coded hex', () => {
    // A hex here would be a second palette that drifts from the design system's
    // tokens in both light and dark mode.
    for (const token of Object.values(URGENCY_TOKENS)) {
      expect(token).not.toMatch(/#[0-9a-f]{3,6}/i);
      expect(token).toMatch(/^(bg|text)-/);
    }
  });
});

/* ========================================================================== */

describe('marker kind overrides urgency shape where it must', () => {
  it('a responder is an octagon', () => {
    // docs/04: responders get their own shape so they are distinguishable from an
    // incident at a glance, and they are the only marker with a heading.
    expect(shapeForKind('responder', 'critical')).toBe('octagon');
    expect(shapeForKind('responder', null)).toBe('octagon');
  });

  it('LOCATION UNKNOWN is a hatched square, the SAME as unknown urgency', () => {
    // docs/12 §2.2. Both mean "we do not know" and the map must not invent a
    // distinction between them.
    expect(shapeForKind('unknownLocation', 'critical')).toBe('hatched-square');
    expect(shapeForKind('unknownLocation', 'critical')).toBe(shapeForUrgency('unknown'));
  });

  it('a risk zone is a square regardless of urgency', () => {
    expect(shapeForKind('riskZone', 'critical')).toBe('square');
  });

  it('an incident with no kind special-case falls through to its urgency', () => {
    expect(shapeForKind('incident', 'high')).toBe('diamond');
  });
});

/* ========================================================================== */

describe('z-order puts the most operationally important thing on top', () => {
  it('a SELECTED marker is above everything, even beside a critical', () => {
    // docs/12 §8.1. The user just clicked it; a marker they clicked must not be
    // occluded by something they did not.
    const selectedLow = zOrderFor({ kind: 'incident', urgency: 'low', selected: true });
    const unselectedCritical = zOrderFor({ kind: 'incident', urgency: 'critical', selected: false });
    expect(selectedLow).toBeGreaterThan(unselectedCritical);
  });

  it('a responder is above every incident', () => {
    // The one moving object a dispatcher tracks.
    const responder = zOrderFor({ kind: 'responder', urgency: null, selected: false });
    for (const urgency of ['critical', 'high', 'medium', 'low', 'unknown'] as const) {
      expect(responder, urgency).toBeGreaterThan(
        zOrderFor({ kind: 'incident', urgency, selected: false }),
      );
    }
  });

  it('critical is above high, which is above medium, which is above low', () => {
    const order: MapUrgency[] = ['low', 'medium', 'high', 'critical'];
    for (let i = 1; i < order.length; i += 1) {
      expect(
        zOrderFor({ kind: 'incident', urgency: order[i] as MapUrgency, selected: false }),
        `${order[i]} above ${order[i - 1]}`,
      ).toBeGreaterThan(zOrderFor({ kind: 'incident', urgency: order[i - 1] as MapUrgency, selected: false }));
    }
  });

  it('unknown urgency sorts BELOW low, because unknown is less actionable', () => {
    expect(zOrderFor({ kind: 'incident', urgency: 'unknown', selected: false })).toBeLessThan(
      zOrderFor({ kind: 'incident', urgency: 'low', selected: false }),
    );
  });
});

/* ========================================================================== */

describe('the accessible name carries the non-visual information (NFR-017)', () => {
  const base = {
    id: 'inc_1',
    kind: 'incident' as const,
    urgency: 'high' as const,
    status: 'triaged' as const,
    accuracyGrade: 'high' as const,
    source: 'gps' as const,
    selected: false,
  };

  it('says the urgency in words, because a shape is invisible to a screen reader', () => {
    expect(accessibleMarkerLabel(base)).toContain('HIGH urgency');
    expect(accessibleMarkerLabel({ ...base, urgency: 'critical' })).toContain('CRITICAL urgency');
  });

  it('says the status in words, readably', () => {
    // "en route" not "en_route" — this string is read aloud.
    const label = accessibleMarkerLabel({ ...base, status: 'en_route' });
    expect(label).toContain('status en route');
    expect(label).not.toContain('en_route');
  });

  it('states low accuracy, rather than leaving it to the ring', () => {
    // docs/12 §2.2 requires the fact to be stated.
    expect(accessibleMarkerLabel({ ...base, accuracyGrade: 'low' })).toContain(
      'location is approximate',
    );
  });

  it('says LOCATION UNKNOWN explicitly for a null geo', () => {
    const label = accessibleMarkerLabel({ ...base, source: 'none' });
    expect(label).toContain('location unknown');
  });

  it('announces the selected state, because state change must be announced', () => {
    expect(accessibleMarkerLabel({ ...base, selected: true })).toContain('selected');
  });

  it('includes the place name, without which forty markers are indistinguishable', () => {
    expect(accessibleMarkerLabel({ ...base, placeName: 'Main Market' })).toContain(
      'near Main Market',
    );
  });

  it('omits an empty or whitespace place name rather than saying "near ."', () => {
    expect(accessibleMarkerLabel({ ...base, placeName: '   ' })).not.toContain('near');
    expect(accessibleMarkerLabel({ ...base, placeName: '' })).not.toContain('near');
  });

  // docs/12 §11.2: a citizen is never shown precise coordinates.
  it('NEVER contains coordinates', () => {
    const label = accessibleMarkerLabel({ ...base, placeName: 'Karachi' });
    expect(label).not.toMatch(/\d+\.\d+/);
    expect(label).not.toMatch(/17\.44|67\.0/);
  });

  it('ends with a period, because it is a sentence', () => {
    expect(accessibleMarkerLabel(base).endsWith('.')).toBe(true);
  });

  it('a responder marker says responder, not incident', () => {
    const label = accessibleMarkerLabel({ ...base, kind: 'responder', urgency: null });
    expect(label).toContain('Responder');
    expect(label).not.toContain('urgency');
  });

  it('a risk zone does not claim an urgency', () => {
    const label = accessibleMarkerLabel({ ...base, kind: 'riskZone', urgency: 'critical' });
    expect(label).toContain('Risk area');
    expect(label).not.toContain('CRITICAL urgency');
  });

  it('never returns an empty label', () => {
    // A marker with no accessible name is a dot on a map to a screen reader.
    for (const urgency of ['critical', 'high', 'medium', 'low', 'unknown', null] as const) {
      for (const kind of ['incident', 'responder', 'unknownLocation', 'riskZone'] as const) {
        const label = accessibleMarkerLabel({ ...base, urgency, kind });
        expect(label.length, `${kind}/${urgency}`).toBeGreaterThan(0);
      }
    }
  });
});

/* ========================================================================== */

describe('buildMarkerSpec is the single construction site (docs/12 §7.3)', () => {
  it('derives every field consistently from the input', () => {
    const spec = buildMarkerSpec({
      id: 'inc_1',
      kind: 'incident',
      urgency: 'critical',
      status: 'new',
      accuracyGrade: 'high',
      source: 'gps',
      selected: false,
    });
    expect(spec.id).toBe('inc_1');
    expect(spec.urgency).toBe('critical');
    expect(spec.textLabel).toBe('CRITICAL');
    expect(spec.label).toContain('CRITICAL urgency');
    expect(spec.zIndex).toBe(zOrderFor({ kind: 'incident', urgency: 'critical', selected: false }));
  });

  it('a selected spec is built the same way as an unselected one', () => {
    const unselected = buildMarkerSpec({
      id: 'a', kind: 'incident', urgency: 'low', status: 'new',
      accuracyGrade: 'high', source: 'gps', selected: false,
    });
    const selected = buildMarkerSpec({
      id: 'a', kind: 'incident', urgency: 'low', status: 'new',
      accuracyGrade: 'high', source: 'gps', selected: true,
    });
    // Only zIndex and the label may differ. A spec that changed shape or text on
    // selection would mean selection was rendering as urgency.
    expect(selected.zIndex).toBeGreaterThan(unselected.zIndex);
    expect(selected.textLabel).toBe(unselected.textLabel);
  });

  it('always carries a label and a textLabel', () => {
    const spec = buildMarkerSpec({
      id: 'x', kind: 'incident', urgency: null, status: null,
      accuracyGrade: null, source: null, selected: false,
    });
    expect(spec.label.length).toBeGreaterThan(0);
    expect(spec.textLabel.length).toBeGreaterThan(0);
    expect(spec.textLabel).toBe('UNKNOWN');
  });
});

/* ========================================================================== */

describe('the FR-084 duplicate ring', () => {
  it('uses the documented treatment: the accent token, 1px, 12% fill, a circle', () => {
    // docs/04. One of only TWO places in the design system a dashed border is used.
    //
    // The colour is a CSS TOKEN, not a hex: the ESLint `no-restricted-syntax` rule
    // bans hex literals so the palette lives in the design system's custom
    // properties. A map component with its own hex is a second palette.
    expect(DUPLICATE_RING_TOKENS.strokeToken).toBe('var(--color-accent)');
    expect(DUPLICATE_RING_TOKENS.strokeWeight).toBe(1);
    expect(DUPLICATE_RING_TOKENS.fillOpacity).toBe(0.12);
    expect(DUPLICATE_RING_TOKENS.type).toBe('circle');
  });

  it('is drawn for responders and above, and for a citizen viewing their OWN incident', () => {
    expect(shouldDrawDuplicateRing('dispatcher', false)).toBe(true);
    expect(shouldDrawDuplicateRing('admin', false)).toBe(true);
    expect(shouldDrawDuplicateRing('responder', false)).toBe(true);
    expect(shouldDrawDuplicateRing('citizen', true)).toBe(true);
  });

  // docs/12 §11: the ring reveals that other reports exist in an area.
  it('is NOT drawn for a citizen looking at someone else report', () => {
    expect(shouldDrawDuplicateRing('citizen', false)).toBe(false);
  });
});

/* ========================================================================== */

describe('the demo centre is ONE constant', () => {
  it('matches docs/12 §10.2, so a map and a fixture cannot disagree about "here"', () => {
    expect(DEMO_CENTER).toEqual({ lat: 17.44, lng: 67.0 });
  });
});

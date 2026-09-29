/**
 * ============================================================================
 * CareGrid AI — the marker visual language
 * ============================================================================
 *
 * `docs/12 §7.3` and §8. **PURE.** No Google Maps, no DOM, no React.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS DATA AND NOT JSX
 * ---------------------------------------------------------------------------
 * `docs/12 §7.3` fixes the shape: one `MarkerSpec` object drives BOTH
 * `AdvancedMarkerElement` and the legacy `Marker` fallback, "so the map looks
 * identical without a Map ID".
 *
 * That is only true if the spec is a pure function of the incident's data. The
 * moment a marker component starts deciding its own colour, the two rendering
 * paths diverge and the fallback becomes a second visual language — which is
 * exactly what `docs/12 §7.3` rules out. So the decision lives here, is unit-tested,
 * and both renderers consume it.
 *
 * ---------------------------------------------------------------------------
 * COLOUR IS NEVER THE ONLY SIGNAL (brief §11, NFR-017)
 * ---------------------------------------------------------------------------
 * Every spec carries a `shape`, a `label` and a `textLabel`. Urgency is expressed
 * as **colour + shape together**, because:
 *
 *  - roughly 1 in 12 men has a red-green colour vision deficiency, and an emergency
 *    map is exactly where that matters;
 *  - a marker is often ~24 px, where two similar oranges are indistinguishable even
 *    with perfect vision;
 *  - a screen reader reads `label`, and it must say the urgency in words.
 *
 * `docs/04 §11.1` fixes the shapes: critical is a **triangle**, high a **diamond**,
 * medium a **circle**, low a **small square**, unknown a **hatched square**. The
 * shapes are not decorative — they are the non-colour channel.
 */

import type { AccuracyGrade, LocationSource } from '@/types';
import type { LatLng } from '@/lib/geo/distance';

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

/** `docs/12 §7.3`'s `MarkerSpec.kind`. */
export type MarkerKind = 'incident' | 'responder' | 'unknownLocation' | 'riskZone' | 'selectionHalo';

/** `docs/04 §11.1`'s five shapes. This IS the non-colour urgency channel. */
export type MarkerShape = 'triangle' | 'diamond' | 'circle' | 'square' | 'hatched-square' | 'octagon';

/** The urgency values this map renders. `Urgency` plus the `null` case. */
export type MapUrgency = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

/** `docs/12 §7.3`, verbatim in shape. */
export type MarkerSpec = {
  readonly id: string;
  readonly kind: MarkerKind;
  readonly urgency: MapUrgency | null;
  readonly status: string | null;
  readonly accuracyGrade: AccuracyGrade | null;
  /** Solid vs dashed. GEO-4, `docs/12 §4.3`. */
  readonly source: LocationSource | null;
  readonly accuracyM: number | null;
  readonly selected: boolean;
  readonly zIndex: number;
  /**
   * The accessible name.
   *
   * **Never rendered inside the marker** (`docs/04`: no text in SVG markers) and
   * never null. A marker with no accessible name is a dot on a map to a screen
   * reader, and this is the field that prevents that.
   */
  readonly label: string;
  /** The visible, non-colour cue. e.g. "CRITICAL". */
  readonly textLabel: string;
};

/* ========================================================================== */
/* Shape and colour                                                            */
/* ========================================================================== */

/**
 * The shape for an urgency. `docs/04 §11.1`.
 *
 * `unknown` is a distinct shape rather than a fallback to `low`, because "we do not
 * know how urgent this is" and "this is low priority" are different facts and a
 * citizen looking at a map should be able to tell them apart.
 */
export function shapeForUrgency(urgency: MapUrgency | null): MarkerShape {
  switch (urgency) {
    case 'critical':
      return 'triangle';
    case 'high':
      return 'diamond';
    case 'medium':
      return 'circle';
    case 'low':
      return 'square';
    case 'unknown':
    case null:
      return 'hatched-square';
    default:
      return 'hatched-square';
  }
}

/**
 * The shape for a marker kind that has no urgency.
 *
 * `LOCATION UNKNOWN` is a **hatched square** (`docs/12 §2.2`), deliberately the same
 * shape as an unknown-urgency marker: both mean "we do not know", and the map should
 * not invent a distinction.
 */
export function shapeForKind(kind: MarkerKind, urgency: MapUrgency | null): MarkerShape {
  if (kind === 'responder') return 'octagon';
  if (kind === 'unknownLocation') return 'hatched-square';
  if (kind === 'selectionHalo') return 'circle';
  if (kind === 'riskZone') return 'square';
  return shapeForUrgency(urgency);
}

/**
 * The short text label beside the marker.
 *
 * **Uppercase and a real word, never a colour name.** "CRITICAL" is legible at a
 * glance and in a screenshot; "red" is neither, and it would be the only part of the
 * marker that fails in greyscale.
 */
export function textLabelForUrgency(urgency: MapUrgency | null): string {
  switch (urgency) {
    case 'critical':
      return 'CRITICAL';
    case 'high':
      return 'HIGH';
    case 'medium':
      return 'MEDIUM';
    case 'low':
      return 'LOW';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Tailwind class fragments for each urgency.
 *
 * **Kept as class NAMES, not colours.** The design system owns the palette
 * (`docs/04 §11.1`), and a hard-coded hex here would be a second palette that
 * drifts from the tokens in both light and dark mode.
 *
 * `docs/04 §11.1` — critical `#C81E1E`-ish, high `#E8590C`-ish, medium `#B8860B`-ish,
 * low `#2B6CB0`-ish — the exact values live in the CSS custom properties.
 */
export const URGENCY_TOKENS: Readonly<Record<MapUrgency, string>> = {
  critical: 'bg-danger text-danger-fg',
  high: 'bg-warning text-warning-fg',
  medium: 'bg-caution text-caution-fg',
  low: 'bg-info text-info-fg',
  unknown: 'bg-muted text-muted-foreground',
};

/* ========================================================================== */
/* z-order — docs/12 §8.1                                                      */
/* ========================================================================== */

/**
 * The z-order bands. `docs/12 §8.1`.
 *
 * **Selected markers sit above everything**, including a selected `low` next to an
 * unselected `critical` — because the user just clicked it, and a marker they
 * clicked must not be occluded. Critical markers sit above the rest so the most
 * urgent thing on a busy map is not hidden behind a `low`.
 *
 * A responder is above every incident: it is the one moving object a dispatcher
 * needs to track, and it is the only marker with a heading.
 */
export function zOrderFor(spec: {
  readonly kind: MarkerKind;
  readonly urgency: MapUrgency | null;
  readonly selected: boolean;
}): number {
  if (spec.selected) return 1000;
  if (spec.kind === 'responder') return 900;
  switch (spec.urgency) {
    case 'critical':
      return 800;
    case 'high':
      return 700;
    case 'medium':
      return 600;
    case 'low':
      return 500;
    default:
      return 400;
  }
}

/* ========================================================================== */
/* The accessible name                                                         */
/* ========================================================================== */

/** `docs/12 §7.3`: the label is what a screen reader reads for the marker. */
export type MarkerLabelInput = {
  readonly kind: MarkerKind;
  readonly urgency: MapUrgency | null;
  readonly status: string | null;
  readonly accuracyGrade: AccuracyGrade | null;
  readonly source: LocationSource | null;
  /** A coarse place name. `docs/12 §11.3` forbids a precise one here. */
  readonly placeName?: string | null;
  readonly selected: boolean;
};

/**
 * The accessible name for a marker.
 *
 * Every part of it is load-bearing:
 *
 * | Part | Why |
 * | --- | --- |
 * | urgency in words | NFR-017. A shape is invisible to a screen reader. |
 * | status in words | The same report at "en route" and "resolved" is a different situation, and the marker colour may not differ. |
 * | the accuracy or LOCATION UNKNOWN phrase | `docs/12 §2.2` requires this to be a stated fact, not a visual subtlety. |
 * | the place name | Without it, a screen-reader user has no idea which of forty markers is the one they care about. |
 * | "selected" | State change must be announced. |
 *
 * **It never contains coordinates.** `docs/12 §11.2`: a citizen is never shown
 * precise coordinates, and a marker's accessible name is read aloud in public.
 */
export function accessibleMarkerLabel(input: MarkerLabelInput): string {
  const parts: string[] = [];

  if (input.kind === 'responder') {
    parts.push('Responder');
  } else if (input.kind === 'unknownLocation') {
    parts.push('Incident with unknown location');
  } else if (input.kind === 'riskZone') {
    parts.push('Risk area');
  } else {
    parts.push('Incident');
  }

  if (input.urgency !== null && input.kind !== 'riskZone') {
    parts.push(`${textLabelForUrgency(input.urgency)} urgency`);
  }

  if (input.status !== null) {
    parts.push(`status ${input.status.replace(/_/g, ' ')}`);
  }

  // The accuracy phrase, or the explicit unknown. docs/12 §2.2.
  if (input.source === 'none' || input.kind === 'unknownLocation') {
    parts.push('location unknown');
  } else if (input.accuracyGrade === 'low') {
    parts.push('location is approximate');
  } else if (input.accuracyGrade === 'unknown') {
    parts.push('location accuracy unknown');
  }

  const place = input.placeName;
  if (typeof place === 'string' && place.trim().length > 0) {
    parts.push(`near ${place.trim()}`);
  }

  if (input.selected) {
    parts.push('selected');
  }

  return `${parts.join(', ')}.`;
}

/* ========================================================================== */
/* The spec builder                                                            */
/* ========================================================================== */

/** Everything a caller supplies to build a spec. */
export type BuildMarkerSpecInput = MarkerLabelInput & {
  readonly id: string;
};

/**
 * Build a `MarkerSpec`. `docs/12 §7.3`.
 *
 * The single construction site, so the two rendering paths cannot disagree and a
 * dispatcher looking at a legacy-`Marker` map sees the same information as one
 * looking at an `AdvancedMarkerElement` map.
 */
export function buildMarkerSpec(input: BuildMarkerSpecInput): MarkerSpec {
  const kind: MarkerKind = input.kind;
  return {
    id: input.id,
    kind,
    urgency: input.urgency,
    status: input.status,
    accuracyGrade: input.accuracyGrade,
    source: input.source,
    accuracyM: null,
    selected: input.selected,
    zIndex: zOrderFor({ kind, urgency: input.urgency, selected: input.selected }),
    label: accessibleMarkerLabel(input),
    textLabel: kind === 'riskZone' ? 'AREA' : textLabelForUrgency(input.urgency),
  };
}

/* ========================================================================== */
/* The FR-084 duplicate ring                                                   */
/* ========================================================================== */

/**
 * The FR-084 duplicate ring's treatment. `docs/04`.
 *
 * **The colour is referenced by token, never written here.** `docs/04` gives the
 * value as `--color-accent` / `#2AB3C9` with a 1 px dash and 12% fill, and this file
 * is not where a hex belongs: the ESLint `no-restricted-syntax` rule bans hex
 * literals precisely so the palette lives in the design system's CSS custom
 * properties and cannot drift. A map component with its own hex is a second
 * palette.
 *
 * The ring is one of only **two** places in the whole design system a dashed border
 * is used (the other is the `LOCATION UNKNOWN` marker), so it cannot be confused
 * with either.
 *
 * `strokeToken` is the CSS custom property to read; `fillOpacity` and
 * `strokeWeight` are the only values here, because they are numbers rather than
 * colours and have no token equivalent.
 */
export const DUPLICATE_RING_TOKENS = {
  /** `--color-accent`, `docs/04`. Read this from CSS; do not inline a hex. */
  strokeToken: 'var(--color-accent)',
  strokeWeight: 1,
  fillOpacity: 0.12,
  /** A circle, not a rectangle: the radius is a distance. */
  type: 'circle' as const,
};

/**
 * Whether the ring should be drawn at all.
 *
 * **Not for a citizen.** `docs/12 §11` restricts the duplicate view to responders
 * and above, because it reveals that other reports exist in an area — which is
 * operational information. A citizen looking at their own incident sees their
 * matches individually, in words, and only when they have been shown.
 */
export function shouldDrawDuplicateRing(role: string, isOwnIncident: boolean): boolean {
  if (isOwnIncident) return true;
  return role === 'dispatcher' || role === 'admin' || role === 'responder';
}

/* ========================================================================== */
/* The MVP demo coordinates                                                    */
/* ========================================================================== */

/**
 * The demo centre. `docs/12 §10.2` uses 17.44 N for the cell arithmetic.
 *
 * One constant so a map, a test fixture and a seeded incident cannot disagree about
 * where "here" is — and so changing it for a real deployment is one edit.
 */
export const DEMO_CENTER: LatLng = { lat: 17.44, lng: 67.0 };

/** The demo zoom. Street-adjacent, not city-wide. */
export const DEMO_ZOOM = 14;

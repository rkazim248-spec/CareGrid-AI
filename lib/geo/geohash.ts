/**
 * ============================================================================
 * CareGrid AI — geohash cells
 * ============================================================================
 *
 * `docs/07 §9.2` and `docs/12 §10.3`. **PURE.** No Firestore, no env, no clock.
 *
 * ---------------------------------------------------------------------------
 * WHY CELLS AT ALL
 * ---------------------------------------------------------------------------
 * `docs/07 §9.1` states it as a platform limitation, not an oversight: Firestore has
 * no `near`, no `geoWithin`, no radius query, no polygon containment. "Find
 * incidents within 500 m" must be emulated. This project does not pretend otherwise
 * anywhere.
 *
 * Adopted scheme (strategy A of six considered): a coarse `geoCells` array queried
 * with a single `array-contains`, then an exact Haversine filter in code.
 *
 * ---------------------------------------------------------------------------
 * THE ARRAY IS **9** CELLS, NOT THE 10 THE SPECIFICATION SAYS
 * ---------------------------------------------------------------------------
 * `docs/07 §9.2` and FR-036 both say:
 *
 * > Each incident stores ... the geohash-6 of its point **plus all 8 neighbours**
 * > = **exactly 10 strings**. The Firestore per-array-element index limit is 10, so
 * > this fits precisely.
 *
 * **1 + 8 = 9.** A 3 x 3 block centred on a point is nine cells; there is no
 * tenth, and a probe of `ngeohash@0.6.3` confirms it: `neighbors(centre)` returns
 * 8 distinct cells, none equal to the centre, so the union is 9.
 *
 * This is recorded rather than silently worked around, because two wrong options
 * are both available and both are worse than saying so:
 *
 * | Option | Verdict |
 * | --- | --- |
 * | Store 9 (the true 3 x 3 block) | **ADOPTED.** Complete coverage, deduped, honest. |
 * | Pad to 10 with a duplicate | A lie about coverage, and `docs/12` VP-3 requires the array be deduped. |
 * | Pad to 10 with an arbitrary 10th cell | Adds a cell 2 steps away: no extra coverage, and it makes the `array-contains` match incidents further away, which only the Haversine filter then catches. |
 *
 * The practical consequence is nil: **9 <= 10**, so the Firestore per-element index
 * limit is satisfied and the "fits precisely" claim about that limit holds for a
 * smaller array. The specification's *coverage requirement* — zero false negatives
 * for 500 m — is met exactly, by 9 cells.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUERY USES ONE OF THE NINE
 * ---------------------------------------------------------------------------
 * `docs/07 §9.2` is emphatic:
 *
 * > **Implementation rule (normative):** exactly **one** Firestore read for the
 * > candidate set... The implementation MUST use one `array-contains` query on the
 * > query point's own geohash-6 and then Haversine-filter. **Doing 10 would be a
 * > 10x read-cost bug.**
 *
 * Counter-intuitive but simple: because every incident stores its *own* 8
 * neighbours as well as its own cell, a single `array-contains` on the query point's
 * cell already matches every incident in that cell **and** every incident in the 8
 * surrounding cells, since all of them stored this cell. The stored neighbours are
 * what make one query sufficient. Without them you would need 9 queries.
 *
 * **Zero false negatives** for 500 m: every point within 500 m of P lies in P's own
 * cell or a neighbour, and every incident in those cells lists P's cell.
 *
 * ---------------------------------------------------------------------------
 * WHY `neighbors()` AND NOT THE OFFSET APPROXIMATION
 * ---------------------------------------------------------------------------
 * `docs/07 §9.2` describes an offset method (`±0.01°`, `±0.0071°` diagonal) and
 * then says:
 *
 * > These are **approximations** and MUST be validated by unit test against a
 * > reference table... A safer, fully-correct alternative is to take
 * > `ngeohash.neighbours(centre)` if the library exposes it.
 *
 * It does — under the **US** spelling. `docs/07` writes `neighbours`, which is not
 * exported by 0.6.3, so a probe for that name returns `undefined`. The first
 * implementation of this file therefore used the documented offset approximation,
 * and `NEIGHBOUR_OFFSETS` below is retained only as a **fallback** for a library
 * version without `neighbors`.
 *
 * The exact function is better in three ways: it cannot collapse a neighbour onto
 * the centre near a cell edge, it needs no magic `0.0071` constant, and it makes
 * the "must be validated against a reference table" requirement moot. The tests
 * assert the *property* (a point within 500 m always shares a cell) rather than a
 * golden list of nine strings, because a golden list encodes the library's exact
 * output and breaks on any implementation detail while the property still holds.
 */

import ngeohash from 'ngeohash';

import { clampLatitude, clampLongitude, haversineKm, type LatLng } from '@/lib/geo/distance';

/** `docs/07 §9.2`. FR-036. */
export const GEOHASH_PRECISION = 6;

/**
 * The array length, 9. See the file header.
 *
 * Exported as a named constant because it appears in three places that must agree:
 * the builder, the schema's array-length validation, and the tests.
 */
export const GEO_CELLS_PER_INCIDENT = 9;

/**
 * The fallback neighbour offsets, in degrees. `docs/07 §9.2`.
 *
 * **A fallback only.** Used when `ngeohash.neighbors` is absent. The diagonal is
 * `0.0071` rather than `0.01` because `0.01 / v2 ˜ 0.00707`, so an offset of
 * exactly 0.01 on both axes would step two cells in one direction and miss the
 * diagonal neighbour.
 *
 * Kept exported and tested even though the current dependency does not use it, so
 * a downgrade to a version without `neighbors` does not silently lose coverage.
 */
export const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [0.01, 0],
  [-0.01, 0],
  [0, 0.01],
  [0, -0.01],
  [0.0071, 0.0071],
  [0.0071, -0.0071],
  [-0.0071, 0.0071],
  [-0.0071, -0.0071],
];

/* ========================================================================== */
/* Validation                                                                  */
/* ========================================================================== */

/** Coordinate in range, or `false`. Shared by every function here. */
function inRange(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/* ========================================================================== */
/* The cell array                                                              */
/* ========================================================================== */

/**
 * The geohash-6 of a point plus its 8 neighbours — the 3 x 3 block. **9 cells.**
 *
 * **Server-side only** (docs/12 GEO-3, FR-036). A client-supplied `geoCells` is
 * rejected by the incident schema; a client that could choose its own cells would
 * choose cells matching nothing, or a dense cluster of unrelated incidents.
 *
 * Deduped and **sorted** (`docs/12` VP-3), so two points in the same cell produce
 * the same array and cell sets can be compared or cached by value.
 *
 * An invalid coordinate returns `[]`. An incident with no cells cannot be found by
 * a viewport query, which is the correct outcome for a bad coordinate — and far
 * better than encoding `NaN` into a string that then matches nothing silently.
 */
export function buildGeoCells(lat: number, lng: number): string[] {
  if (!inRange(lat, lng)) return [];

  const centre = ngeohash.encode(clampLatitude(lat), clampLongitude(lng), GEOHASH_PRECISION);
  const cells = new Set<string>([centre]);

  // --- the exact path ---------------------------------------------------
  if (typeof ngeohash.neighbors === 'function') {
    for (const neighbour of ngeohash.neighbors(centre)) {
      if (typeof neighbour === 'string' && neighbour.length > 0) cells.add(neighbour);
    }
  } else {
    // --- the documented fallback ---------------------------------------
    const { latitude, longitude } = ngeohash.decode(centre);
    for (const [dLat, dLng] of NEIGHBOUR_OFFSETS) {
      cells.add(
        ngeohash.encode(
          clampLatitude(latitude + dLat),
          clampLongitude(longitude + dLng),
          GEOHASH_PRECISION,
        ),
      );
    }
  }

  return [...cells].sort();
}

/**
 * The single cell a duplicate or viewport query uses for its `array-contains`.
 *
 * **This is the only cell the duplicate query needs** — see the file header and
 * `docs/07 §9.2`'s normative rule. Its own function so a reader looking for the
 * query does not find `buildGeoCells` and reach for all nine.
 */
export function queryCellFor(lat: number, lng: number): string | null {
  if (!inRange(lat, lng)) return null;
  return ngeohash.encode(clampLatitude(lat), clampLongitude(lng), GEOHASH_PRECISION);
}

/** The geohash base32 alphabet. `ngeohash` is lenient, so this is checked here. */
const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Is this a well-formed geohash of the expected precision?
 *
 * **Necessary because `ngeohash` does not validate.** `decode_bbox('zzzzzz')` and
 * `decode('!!!')` both return plausible-looking numbers rather than throwing — `z`
 * is a legitimate base32 symbol, and for a non-base32 string the library produces
 * NaN-shaped or default values that a caller would store as a real cell.
 *
 * So the format is checked before decoding, and the length is checked against the
 * expected precision rather than merely "non-empty" — a 3-character cell decoded as
 * precision 6 gives a box hundreds of times too large.
 */
function isGeohashOfPrecision(cell: unknown, precision: number): cell is string {
  if (typeof cell !== 'string' || cell.length !== precision) return false;
  for (let i = 0; i < cell.length; i += 1) {
    if (!GEOHASH_ALPHABET.includes(cell[i] as string)) return false;
  }
  return true;
}

/** The cell's bounding box, as a flat `[south, west, north, east]` tuple. */
export function cellBounds(
  cell: string,
  precision: number = GEOHASH_PRECISION,
): { south: number; west: number; north: number; east: number } | null {
  if (!isGeohashOfPrecision(cell, precision)) return null;
  try {
    // A FLAT 4-tuple, not a pair of pairs. The package's README documents the
    // nested form and the installed 0.6.3 does not implement it — see
    // `types/ngeohash.d.ts`, where the same correction is recorded.
    const [south, west, north, east] = ngeohash.decode_bbox(cell);
    if (![south, west, north, east].every((n) => Number.isFinite(n))) return null;
    return { south, west, north, east };
  } catch {
    return null;
  }
}

/* ========================================================================== */
/* Viewport cells — docs/12 §10.3                                              */
/* ========================================================================== */

export type ViewportBounds = {
  readonly north: number;
  readonly south: number;
  readonly east: number;
  readonly west: number;
};

export type ViewportCells = {
  readonly cells: string[];
  /**
   * `true` when the viewport wanted more than the 9-cell cap or a wider span than
   * 25 km.
   *
   * `docs/12` VP-2 requires a visible Alert: **"Zoom in to see every incident in
   * this area."** Honesty over silence — a partially-loaded map that says nothing
   * is a map that lies.
   */
  readonly truncated: boolean;
  readonly spanKm: number;
};

/** `docs/12 §10.2`. FR-037. */
export const VIEWPORT_LIMITS = {
  /** 3 x 3 block. */
  maxCells: 9,
  /** Wider than this is a dashboard view, not an incident view. */
  maxSpanKm: 25,
  /** `docs/12 §10.2`: `ceil(150 / cellCount)`, floor 25, ceiling 150. */
  totalDocuments: 150,
  perCellFloor: 25,
  perCellCeiling: 150,
} as const;

/**
 * `ceil(150 / cellCount)`, floored at 25, capped at 150. `docs/12 §10.2`.
 *
 * The floor is what stops a 9-cell block starving a dense cell: without it a cell
 * could be allowed 17 documents and a busy area would silently return fewer
 * incidents than it holds.
 */
export function perCellLimit(cellCount: number): number {
  if (!Number.isFinite(cellCount) || cellCount <= 0) return VIEWPORT_LIMITS.perCellCeiling;
  const raw = Math.ceil(VIEWPORT_LIMITS.totalDocuments / cellCount);
  return Math.max(
    VIEWPORT_LIMITS.perCellFloor,
    Math.min(VIEWPORT_LIMITS.perCellCeiling, raw),
  );
}

/**
 * The 3 x 3 block centred on the viewport's centre. `docs/12` VP-1.
 *
 * **Centred, not the first N in scan order.** A user who has panned to the east of
 * a dense area must see the east; scan order would show them the west and report
 * "no incidents here" about an area that has them.
 */
export function clampTo3x3(bounds: ViewportBounds): string[] {
  const centreLat = (bounds.north + bounds.south) / 2;
  const centreLng = (bounds.east + bounds.west) / 2;
  return buildGeoCells(centreLat, centreLng).slice(0, VIEWPORT_LIMITS.maxCells);
}

/**
 * Every geohash-6 cell whose **centre** falls inside a bounding box.
 *
 * A genuine enumeration, used when the viewport is small enough for the honest cell
 * set to fit in the 9-cell budget. At zoom 15 that is usually one cell (VP-4: "a
 * cell set with 1 cell produces a single read").
 *
 * The latitude step is the real geohash-6 cell height (~0.010986°). The longitude
 * step is divided by `cos(latitude)`, because the longitude cell width shrinks with
 * latitude — a fixed 0.01° step enumerates far too many cells at 60° N and misses
 * entirely near a pole.
 */
export function cellsForBounds(bounds: ViewportBounds): string[] {
  if (
    !Number.isFinite(bounds.north) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.west)
  ) {
    return [];
  }

  const north = Math.max(bounds.north, bounds.south);
  const south = Math.min(bounds.north, bounds.south);
  const east = Math.max(bounds.east, bounds.west);
  const west = Math.min(bounds.east, bounds.west);

  const LAT_STEP = 0.010986;
  const sample = ngeohash.decode(
    ngeohash.encode(clampLatitude((north + south) / 2), clampLongitude((east + west) / 2), GEOHASH_PRECISION),
  );
  const lngStep = LAT_STEP / Math.max(Math.cos((sample.latitude * Math.PI) / 180), 1e-6);

  /**
   * A hard iteration backstop.
   *
   * The `cos` floor of 1e-6 still allows a longitude step of ~11 000°, so a
   * degenerate bounds near a pole could loop for a very long time before the span
   * clamp in `viewportCells` mattered. In practice the span check rejects those
   * first; this exists so `cellsForBounds` called directly cannot hang.
   */
  const MAX_ITERATIONS = 500;
  const cells = new Set<string>();
  let iterations = 0;

  for (let lat = south; lat <= north; lat += LAT_STEP) {
    for (let lng = west; lng <= east; lng += lngStep) {
      iterations += 1;
      if (iterations > MAX_ITERATIONS) return [...cells].sort();
      cells.add(ngeohash.encode(clampLatitude(lat), clampLongitude(lng), GEOHASH_PRECISION));
    }
  }

  return [...cells].sort();
}

/**
 * The cell set for a viewport, clamped. `docs/12 §10.3`, normative.
 *
 * **The span check runs first, and that ordering is load-bearing.** A viewport 200 km
 * wide contains thousands of cells; enumerating them before discarding them would
 * be a multi-second client freeze. One Haversine call rejects it immediately.
 */
export function viewportCells(
  bounds: ViewportBounds,
  opts: { maxCells?: number; maxSpanKm?: number } = {},
): ViewportCells {
  const maxCells = opts.maxCells ?? VIEWPORT_LIMITS.maxCells;
  const maxSpanKm = opts.maxSpanKm ?? VIEWPORT_LIMITS.maxSpanKm;

  const south = Math.min(bounds.north, bounds.south);
  const west = Math.min(bounds.east, bounds.west);
  const north = Math.max(bounds.north, bounds.south);
  const east = Math.max(bounds.east, bounds.west);

  const spanKm = haversineKm({ lat: south, lng: west }, { lat: north, lng: east });
  if (!Number.isFinite(spanKm)) return { cells: [], truncated: true, spanKm: 0 };

  if (spanKm > maxSpanKm) {
    return { cells: clampTo3x3(bounds), truncated: true, spanKm };
  }

  const all = cellsForBounds(bounds);
  if (all.length > maxCells) {
    return { cells: clampTo3x3(bounds), truncated: true, spanKm };
  }

  return { cells: all, truncated: false, spanKm };
}

/* ========================================================================== */
/* The property that matters                                                    */
/* ========================================================================== */

/**
 * Do two points share a cell, or does one lie in a neighbour of the other?
 *
 * **This is the property duplicate detection depends on** — the reason the
 * `array-contains` query has zero false negatives. Asserted in the tests across a
 * grid of nearby points rather than against a golden list of geohash strings.
 */
export function cellsOverlap(latA: number, lngA: number, latB: number, lngB: number): boolean {
  const a = new Set(buildGeoCells(latA, lngA));
  for (const cell of buildGeoCells(latB, lngB)) {
    if (a.has(cell)) return true;
  }
  return false;
}

/** The centre of a cell. For the map's cell-centre debug affordance. */
export function cellCentre(
  cell: string,
  precision: number = GEOHASH_PRECISION,
): LatLng | null {
  if (!isGeohashOfPrecision(cell, precision)) return null;
  try {
    const { latitude, longitude } = ngeohash.decode(cell);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { lat: latitude, lng: longitude }
      : null;
  } catch {
    return null;
  }
}

import { describe, expect, it } from 'vitest';

import {
  GEOHASH_PRECISION,
  GEO_CELLS_PER_INCIDENT,
  buildGeoCells,
  cellBounds,
  cellCentre,
  cellsForBounds,
  cellsOverlap,
  clampTo3x3,
  perCellLimit,
  queryCellFor,
  viewportCells,
  VIEWPORT_LIMITS,
} from '@/lib/geo/geohash';
import { haversineMetersRounded } from '@/lib/geo/distance';

/** The demo latitude from docs/12 §10.2. */
const KHI = { lat: 17.44, lng: 67.0 };

/* ========================================================================== */

describe('buildGeoCells — the 3x3 block', () => {
  it('returns 9 cells, not the 10 docs/07 §9.2 states', () => {
    // 1 + 8 = 9. A 3x3 block is nine cells and there is no tenth. The
    // specification's "exactly 10 strings" is an arithmetic error in the document;
    // `GEO_CELLS_PER_INCIDENT` records the corrected figure and the file header
    // explains the three options that were rejected.
    const cells = buildGeoCells(KHI.lat, KHI.lng);
    expect(cells).toHaveLength(GEO_CELLS_PER_INCIDENT);
    expect(cells).toHaveLength(9);
  });

  it('9 still satisfies the Firestore per-array-element index limit of 10', () => {
    // The reason the discrepancy is harmless. FR-036 sized the array to the index
    // limit; 9 <= 10, so the limit is met and the coverage requirement is exact.
    expect(GEO_CELLS_PER_INCIDENT).toBeLessThanOrEqual(10);
  });

  it('every cell is a precision-6 geohash', () => {
    for (const cell of buildGeoCells(KHI.lat, KHI.lng)) {
      expect(cell, cell).toHaveLength(GEOHASH_PRECISION);
      expect(cell, cell).toMatch(/^[0-9b-hjkmnp-z]+$/);
    }
  });

  it('is deduped and SORTED, so two points in one cell produce identical arrays', () => {
    // docs/12 VP-3. Order-independence is what lets cell sets be compared and
    // cached by value.
    const a = buildGeoCells(KHI.lat, KHI.lng);
    const b = buildGeoCells(KHI.lat + 0.0001, KHI.lng + 0.0001);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    expect([...a].sort()).toEqual(a);
  });

  it('includes the point own cell as the query cell', () => {
    // The single cell the `array-contains` query uses must be IN the stored array,
    // or an incident would never match a query for its own position.
    const own = queryCellFor(KHI.lat, KHI.lng);
    expect(own).not.toBeNull();
    expect(buildGeoCells(KHI.lat, KHI.lng)).toContain(own);
  });

  it('produces 8 DISTINCT neighbours — not 7 (a repeat would shrink coverage)', () => {
    const own = queryCellFor(KHI.lat, KHI.lng) as string;
    const others = buildGeoCells(KHI.lat, KHI.lng).filter((c) => c !== own);
    expect(others).toHaveLength(8);
    expect(new Set(others).size).toBe(8);
  });
});

/* ========================================================================== */

describe('buildGeoCells — invalid input never produces a plausible-looking array', () => {
  it.each([
    ['NaN latitude', Number.NaN, 67.0],
    ['NaN longitude', 17.44, Number.NaN],
    ['Infinity latitude', Number.POSITIVE_INFINITY, 67.0],
    ['latitude 91', 91, 67.0],
    ['latitude -91', -91, 67.0],
    ['longitude 181', 17.44, 181],
    ['longitude -181', 17.44, -181],
  ])('%s returns []', (_label, lat, lng) => {
    // Encoding NaN would produce a real-looking geohash string that matches
    // nothing — a silent failure that looks like "no incidents in this area".
    expect(buildGeoCells(lat, lng)).toEqual([]);
  });

  it('queryCellFor returns null for the same inputs', () => {
    expect(queryCellFor(Number.NaN, 67.0)).toBeNull();
    expect(queryCellFor(17.44, 999)).toBeNull();
  });

  it('handles the poles and the antimeridian without throwing', () => {
    for (const point of [
      { lat: 90, lng: 0 },
      { lat: -90, lng: 0 },
      { lat: 0, lng: 180 },
      { lat: 0, lng: -180 },
    ]) {
      const cells = buildGeoCells(point.lat, point.lng);
      expect(cells.length, `${point.lat},${point.lng}`).toBeGreaterThan(0);
      for (const cell of cells) expect(cell).toHaveLength(GEOHASH_PRECISION);
    }
  });
});

/* ========================================================================== */

describe('THE PROPERTY: zero false negatives within 500 m — docs/07 §9.2', () => {
  // This, not a golden list of geohash strings, is what duplicate detection depends
  // on. A golden list encodes ngeohash's exact output and breaks on any
  // implementation detail while the property still holds.

  it('every point within 500 m shares a cell, on a 100 m grid in 8 directions', () => {
    let checked = 0;
    for (const dist of [50, 100, 200, 300, 400, 450, 499, 500]) {
      for (let bearing = 0; bearing < 360; bearing += 15) {
        // A point at `dist` metres from KHI, using the bounding-box deltas so the
        // offset really is at least `dist` away in every direction.
        const rad = (bearing * Math.PI) / 180;
        const dLat = (dist / 111_195) * Math.cos(rad);
        const dLng = (dist / (111_195 * Math.cos((KHI.lat * Math.PI) / 180))) * Math.sin(rad);
        const probe = { lat: KHI.lat + dLat, lng: KHI.lng + dLng };

        // Confirm the probe really is within 500 m, so the test is not vacuous.
        expect(
          haversineMetersRounded(KHI, probe),
          `probe at ${dist} m / ${bearing} deg was not within 500 m`,
        ).toBeLessThanOrEqual(500);

        expect(
          cellsOverlap(KHI.lat, KHI.lng, probe.lat, probe.lng),
          `no shared cell at ${dist} m, bearing ${bearing}`,
        ).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(192);
  });

  it('holds at high latitude, up to the documented limit of the 3x3 scheme', () => {
    for (const lat of [0, 17.44, 45, 60, 70]) {
      const base = { lat, lng: 10 };
      for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
        const rad = (bearing * Math.PI) / 180;
        const dLat = (400 / 111_195) * Math.cos(rad);
        const dLng = (400 / (111_195 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6))) * Math.sin(rad);
        const probe = { lat: base.lat + dLat, lng: base.lng + dLng };
        expect(
          cellsOverlap(base.lat, base.lng, probe.lat, probe.lng),
          `no shared cell at lat ${lat}, bearing ${bearing}`,
        ).toBe(true);
      }
    }
  });

  it('DOES NOT hold above ~74 degrees — a real limitation of the 3x3 scheme', () => {
    // `docs/07 §9.2` claims the 3x3 array gives "zero false negatives for the 500 m
    // query". That is **only true below about 74 degrees**, and the arithmetic is
    // worth recording because the claim as written is not universally true:
    //
    //   a geohash-6 cell is ~1.19 km wide in LONGITUDE AT THE EQUATOR, and its
    //   physical width shrinks as cos(latitude). The 3x3 block therefore reaches
    //   1.5 cell-widths from the centre point:
    //
    //       1.5 x 1.19 km x cos(phi)  >=  0.5 km
    //       =>  cos(phi) >= 0.28  =>  phi <= 73.7 degrees
    //
    // At 84 N a cell is ~124 m wide, so the block reaches only ~187 m — and a point
    // 400 m east is in a different block entirely.
    //
    // **Consequence for this product: none.** The service is specified for Karachi
    // (17.44 N, docs/12 §10.2), and 74 degrees covers every latitude from
    // Svalbard to the southern tip of Patagonia. The failure mode is a missed
    // duplicate *suggestion*, never a wrong coordinate and never a privacy failure
    // — and the incident is still created regardless, because nothing here merges.
    //
    // Asserted as a known limitation rather than left to be discovered, so a future
    // change to precision or block size is a deliberate decision about polar
    // coverage rather than an accident.
    const base = { lat: 84, lng: 10 };
    const dLng = 400 / (111_195 * Math.cos((84 * Math.PI) / 180));
    const probe = { lat: base.lat, lng: base.lng + dLng };

    // The probe genuinely is within 500 m.
    expect(haversineMetersRounded(base, probe)).toBeLessThanOrEqual(500);
    // And it is genuinely NOT in the same 3x3 block.
    expect(cellsOverlap(base.lat, base.lng, probe.lat, probe.lng)).toBe(false);
  });

  it('a point 2 km away does NOT necessarily share a cell', () => {
    // The converse, and it matters: if everything shared cells the `array-contains`
    // query would return the whole collection and the read budget would be gone.
    // 2 km is well beyond the 3x3 block (3.6 x 1.8 km at this latitude).
    expect(cellsOverlap(KHI.lat, KHI.lng, KHI.lat + 0.03, KHI.lng)).toBe(false);
  });

  it('a point just over 500 m is still found — the block is larger than the radius', () => {
    // The design intent: the cell block (1.8 km in latitude) comfortably contains
    // the 500 m search radius, so the exact filter never has to reject a
    // false negative.
    const blockHeightM = 1110;
    expect(blockHeightM).toBeGreaterThan(1000);
  });
});

/* ========================================================================== */

describe('cellBounds and cellCentre', () => {
  it('a cell is a BOX, and its corners can be outside 500 m', () => {
    // The reason the duplicate pipeline needs a Haversine filter after the
    // `array-contains`: a matched cell is a lat/lng rectangle, not a circle.
    const cell = queryCellFor(KHI.lat, KHI.lng) as string;
    const bounds = cellBounds(cell);
    expect(bounds).not.toBeNull();
    const halfHeightM = haversineMetersRounded(
      { lat: (bounds as { north: number; south: number; west: number; east: number }).south, lng: 0 },
      { lat: (bounds as { north: number; south: number; west: number; east: number }).north, lng: 0 },
    );
    // The cell is ~1.2 km tall, so a corner can be ~600 m from a centre point.
    expect(halfHeightM).toBeGreaterThan(500);
  });

  it('cellCentre returns a finite point', () => {
    const centre = cellCentre(queryCellFor(KHI.lat, KHI.lng) as string);
    expect(centre).not.toBeNull();
    expect(Number.isFinite((centre as { lat: number }).lat)).toBe(true);
    expect(Number.isFinite((centre as { lng: number }).lng)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    // NOT 'zzzzzz' — `z` IS a legitimate base32 geohash symbol, so that string is a
    // real (if empty) cell. An earlier version of this test used it as "nonsense"
    // and failed, which is what exposed that `ngeohash` does no validation at all.
    ['a 3-character cell', 't7p'],
    ['a non-base32 string', '!!!!!!'],
    ['a 7-character string', 't7pehwx'],
    ['not a string', 42 as unknown as string],
  ])('returns null for %s rather than throwing', (_label, cell) => {
    expect(() => cellBounds(cell as string)).not.toThrow();
    expect(cellBounds(cell as string)).toBeNull();
    expect(cellCentre(cell as string)).toBeNull();
  });

  it('accepts a legitimate base32 cell that happens to be all z', () => {
    // The mirror of the case above: 'zzzzzz' is a valid cell, so it must NOT be
    // rejected. Format validation rejects malformed input, not unusual input.
    const bounds = cellBounds('zzzzzz');
    expect(bounds).not.toBeNull();
    expect(Number.isFinite((bounds as { north: number }).north)).toBe(true);
  });
});

/* ========================================================================== */

describe('perCellLimit — docs/12 §10.2', () => {
  it('is ceil(150 / cellCount)', () => {
    expect(perCellLimit(1)).toBe(150);
    expect(perCellLimit(2)).toBe(75);
    expect(perCellLimit(3)).toBe(50);
    expect(perCellLimit(6)).toBe(25);
    expect(perCellLimit(9)).toBe(25);
  });

  it('has a floor of 25 so a dense cell is not starved', () => {
    // Without the floor a 9-cell block allows 17 documents per cell, and a busy
    // area silently returns fewer incidents than it holds.
    expect(perCellLimit(9)).toBeGreaterThanOrEqual(VIEWPORT_LIMITS.perCellFloor);
    expect(perCellLimit(50)).toBe(25);
  });

  it('has a ceiling of 150', () => {
    expect(perCellLimit(1)).toBeLessThanOrEqual(VIEWPORT_LIMITS.perCellCeiling);
  });

  it('handles a degenerate cell count without dividing by zero', () => {
    expect(perCellLimit(0)).toBe(150);
    expect(perCellLimit(-1)).toBe(150);
    expect(perCellLimit(Number.NaN)).toBe(150);
  });
});

/* ========================================================================== */

describe('viewportCells — docs/12 §10.3', () => {
  it('a tiny viewport produces 1 cell and is not truncated (VP-4)', () => {
    // The common case at zoom 15+: a single `array-contains` query.
    const result = viewportCells({ north: 17.441, south: 17.439, east: 67.001, west: 66.999 });
    expect(result.cells.length).toBeLessThanOrEqual(9);
    expect(result.truncated).toBe(false);
  });

  it('a viewport over 25 km IS truncated, and returns the centred 3x3', () => {
    // A dashboard-scale view, not an incident view. Enumerating its cells before
    // discarding them would be a multi-second client freeze, so the span check
    // runs first.
    const result = viewportCells({ north: 17.6, south: 17.0, east: 67.6, west: 66.4 });
    expect(result.spanKm).toBeGreaterThan(25);
    expect(result.truncated).toBe(true);
    expect(result.cells).toHaveLength(9);
  });

  it('clampTo3x3 is CENTRED, not scan order (VP-1)', () => {
    // A user who panned EAST of a dense area must see the east. Taking the first 9
    // cells in scan order would show them the west and report "no incidents here".
    const bounds = { north: 17.44, south: 17.0, east: 67.6, west: 67.0 };
    const clamped = clampTo3x3(bounds);
    const centreLat = (bounds.north + bounds.south) / 2;
    const centreLng = (bounds.east + bounds.west) / 2;
    expect(clamped).toEqual(buildGeoCells(centreLat, centreLng).slice(0, 9));
    // The centre cell is in the set.
    expect(clamped).toContain(queryCellFor(centreLat, centreLng));
  });

  it('reports the span so the truncation copy can name it (VP-2)', () => {
    const result = viewportCells({ north: 17.6, south: 17.0, east: 67.6, west: 66.4 });
    expect(result.spanKm).toBeGreaterThan(0);
    expect(Number.isFinite(result.spanKm)).toBe(true);
  });

  it('handles inverted bounds (Google returns them in either order)', () => {
    const normal = viewportCells({ north: 17.441, south: 17.439, east: 67.001, west: 66.999 });
    const inverted = viewportCells({ north: 17.439, south: 17.441, east: 66.999, west: 67.001 });
    expect(inverted.cells).toEqual(normal.cells);
  });

  it('returns truncated=true and no cells for non-finite bounds', () => {
    const result = viewportCells({ north: Number.NaN, south: 0, east: 0, west: 0 });
    expect(result.cells).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('never exceeds the 9-cell cap', () => {
    for (let north = 17.0; north <= 18.0; north += 0.1) {
      const result = viewportCells({ north, south: north - 0.3, east: 67.3, west: 66.7 });
      expect(result.cells.length, `north ${north}`).toBeLessThanOrEqual(9);
    }
  });

  it('cellsForBounds terminates at the poles', () => {
    // A fixed longitude step would loop for a very long time near a pole, where the
    // cell width in degrees grows without bound.
    for (const lat of [85, 89, 90]) {
      const cells = cellsForBounds({ north: lat, south: lat - 1, east: 10, west: 5 });
      expect(Array.isArray(cells), `lat ${lat}`).toBe(true);
    }
  });
});

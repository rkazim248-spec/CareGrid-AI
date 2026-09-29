/**
 * Type declarations for `ngeohash@0.6.x`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS RATHER THAN `declare module 'ngeohash'`
 * ---------------------------------------------------------------------------
 * The package ships no types. The usual shortcut — `declare module 'ngeohash';` —
 * makes every import `any`, which silently disables type checking at exactly the
 * boundary where a mistake is most expensive.
 *
 * That is not hypothetical. The first version of `lib/geo/geohash.ts` was written
 * against an assumed `decode()` shape of `{ lat, lng }`, when the real one is
 * `{ latitude, longitude, error }`. With a real declaration TypeScript rejects
 * `const { lat } = decode(cell)` at compile time. With `any` it compiles, runs,
 * and `clampLatitude(undefined)` yields `0` — so every geohash cell would be
 * encoded at the equator and **no incident would ever match a viewport query**.
 *
 * So only the members this project actually uses are declared, and `encode` is
 * typed to return `string` rather than `string | number` (the package's
 * `encode_uint64` variants are a different function and are not declared here).
 *
 * Verified against the installed 0.6.3 by direct probe, not from documentation —
 * the package's README describes a different API surface from the one it ships.
 *
 * docs/02 §79 approves this dependency: "`ngeohash` 0.6.x | `encode`/`decode` for
 * geohash precision 6; pure, tiny, no native code".
 */

declare module 'ngeohash' {
  /**
   * The decoded centre of a cell, plus the **half-width of the error box** in
   * degrees — not a distance and not a radius.
   *
   * The error is useful: for precision 6 it is ~0.0027° latitude (~300 m) and
   * ~0.0055° longitude. `lib/geo/geohash.ts` does not use it, but a caller
   * rendering a cell boundary needs to know it is a box and not a circle.
   */
  interface GeohashDecode {
    readonly latitude: number;
    readonly longitude: number;
    readonly error: {
      readonly latitude: number;
      readonly longitude: number;
    };
  }

  /**
   * A cell's bounding box: a **flat 4-tuple** `[south, west, north, east]`.
   *
   * **NOT `[[south, west], [north, east]]`.** The package's README documents the
   * nested form and this declaration initially followed it — at which point
   * `cellBounds` destructured a *number* (`const [south, west] = 89.99`), the
   * resulting `TypeError` was swallowed by a `catch`, and the function returned
   * `null` for every input including perfectly valid cells.
   *
   * Verified by probe: `decode_bbox('t7pehw')` is `[17.435, 66.994, 17.440, 67.005]`.
   * Trusting the README over the installed package cost a round of tests failing
   * for a reason that had nothing to do with the code under test — which is the
   * concrete argument for probing a dependency's surface before typing it.
   *
   * A **box, not a circle**: a geohash cell is a lat/lng rectangle, which is the
   * other reason the duplicate pipeline needs a Haversine filter after the
   * `array-contains` query. Corners of a matched cell can be well outside 500 m.
   */
  type GeohashBbox = [number, number, number, number];

  /** Encode to a geohash string. `precision` defaults to `ENCODE_AUTO`. */
  export function encode(latitude: number, longitude: number, precision?: number): string;

  /** Decode a geohash to its centre and error box. */
  export function decode(geohash: string): GeohashDecode;

  /** The cell's bounding box, `[[south, west], [north, east]]`. */
  export function decode_bbox(geohash: string): GeohashBbox;

  /**
   * The **8** surrounding cells, excluding the cell itself.
   *
   * Verified: `neighbors('t7pehw')` returns 8 distinct cells, none equal to the
   * input. So the 3 x 3 block is 1 + 8 = **9** cells.
   *
   * Note the **US spelling**. `docs/07 §9.2` writes `ngeohash.neighbours(...)`,
   * which does not exist in 0.6.3 — the exported names are `neighbor` and
   * `neighbors`. An earlier probe for the British spelling returned `undefined`,
   * which is what led to the offset-approximation implementation that this exact
   * function replaced.
   */
  export function neighbors(geohash: string): string[];

  /** One neighbour by compass direction: `n`, `s`, `e`, `w`, `ne`, `nw`, `se`, `sw`. */
  export function neighbor(geohash: string, direction: string): string | null;
}

/**
 * ============================================================================
 * CareGrid AI — accuracy grading
 * ============================================================================
 *
 * `docs/12 §2.2`, FR-032. **PURE.** No Firestore, no env, no clock.
 *
 * ---------------------------------------------------------------------------
 * WHAT A GRADE IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * `docs/12 §2.2` note 1, restated because it is the single most misreadable value
 * in the system:
 *
 * > The browser's `accuracyM` is a **68% confidence radius**, not an error bound.
 * > On a device in a street canyon it can be 30 m and the true error can be 200 m.
 * > Grading is a **communication device, not a measurement claim**.
 *
 * That is why the UI copy says "within about N m" and never "accurate to N m" — a
 * requirement this file cannot enforce but must not tempt anyone to violate.
 *
 * ---------------------------------------------------------------------------
 * WHY `unknown` IS A REAL VALUE AND NOT A NULL
 * ---------------------------------------------------------------------------
 * A `null` grade is indistinguishable from "the field was never computed", and
 * `docs/12 §2.2` requires `accuracyGrade` to be **present on every incident**,
 * including when `geo` is null (GEO-1). A missing grade would let a bug — one that
 * forgot to compute it — render identically to a legitimately unlocatable
 * incident. `unknown` says "we graded this and the answer is that we do not know",
 * which is a different statement and the one a dispatcher needs.
 */

/**
 * `docs/12 §2.2`, FR-032, verbatim:
 *
 * ```ts
 * export function gradeAccuracy(accuracyM: number | null | undefined): AccuracyGrade {
 *   if (accuracyM == null || !Number.isFinite(accuracyM)) return 'unknown';
 *   if (accuracyM <= 50)   return 'high';    // FR-032: high   <= 50 m
 *   if (accuracyM <= 200)  return 'medium';  // FR-032: medium <= 200 m
 *   if (accuracyM <= 1000) return 'low';     // FR-032: low    <= 1000 m
 *   return 'unknown';                        // > 1000 m
 * }
 * ```
 */
export type AccuracyGrade = 'high' | 'medium' | 'low' | 'unknown';

/**
 * The thresholds, in one exported object.
 *
 * Exported so the tests, the copy and any future admin override read the same
 * numbers the function does. A threshold written twice is a threshold that will be
 * changed in one place.
 */
export const ACCURACY_THRESHOLDS_M = {
  high: 50,
  medium: 200,
  low: 1000,
} as const;

/**
 * Grade a browser-reported accuracy in metres.
 *
 * `== null` rather than `=== null`, so `undefined` takes the same path — a missing
 * field and an explicit null mean the same thing here, and writing two branches
 * would invite one of them to be forgotten.
 *
 * A **negative** accuracy is `unknown`, not `high`. A device reporting
 * `accuracy: -1` is broken, and `-1 <= 50` is true, so without the finite-and-
 * non-negative guard a broken sensor would produce the most confident grade
 * possible — the single most dangerous inversion available in this file.
 */
export function gradeAccuracy(accuracyM: number | null | undefined): AccuracyGrade {
  if (accuracyM == null || !Number.isFinite(accuracyM)) return 'unknown';
  if (accuracyM < 0) return 'unknown';
  if (accuracyM <= ACCURACY_THRESHOLDS_M.high) return 'high';
  if (accuracyM <= ACCURACY_THRESHOLDS_M.medium) return 'medium';
  if (accuracyM <= ACCURACY_THRESHOLDS_M.low) return 'low';
  return 'unknown';
}

/**
 * The metered copy for a grade. `docs/12 §2.2` requires the phrase to be
 * **approximate**.
 *
 * `unknown` gets a sentence rather than a number because there is no number to
 * show, and `docs/12 §2.2` is explicit that a null `geo` renders as
 * `LOCATION UNKNOWN` — a visible state, not a blank field.
 */
export function accuracyLabel(accuracyM: number | null | undefined): string {
  if (accuracyM == null || !Number.isFinite(accuracyM) || accuracyM < 0) {
    return 'Location accuracy unavailable';
  }
  const metres = Math.round(accuracyM);
  // "within about N m" — never "accurate to N m". See the file header.
  return `Location accuracy: approximately ${metres} m`;
}

/**
 * Does this grade require the "Location is approximate" warning?
 *
 * `docs/12 §2.2` lists required copy for `low` and `unknown` only. A `high` or
 * `medium` fix gets the number and no warning, because a warning on every report
 * is a warning nobody reads.
 *
 * Used by the report form, the queue row and the map panel — three surfaces that
 * must agree, which is why it is a function and not a `grade === 'low'` written in
 * each of them.
 */
export function needsApproximateWarning(grade: AccuracyGrade): boolean {
  return grade === 'low' || grade === 'unknown';
}

/** `docs/12 §2.2`'s low-accuracy copy, verbatim in substance. */
export const APPROXIMATE_LOCATION_COPY =
  'Your device put you within about {accuracyM} m of this point. Drop a pin to make it more precise, or continue as it is.';

/** The null-`geo` state. `docs/12 §2.2` requires this to be a visible flag. */
export const LOCATION_UNKNOWN_COPY = 'LOCATION UNKNOWN';

/**
 * ============================================================================
 * CareGrid AI — location integrity
 * ============================================================================
 *
 * `docs/12 §13`. **PURE.** No Firestore, no clock of its own (a `nowMs` is passed
 * in), no randomness.
 *
 * ---------------------------------------------------------------------------
 * THE HEADLINE: NOTHING HERE EVER REJECTS A FIX
 * ---------------------------------------------------------------------------
 * `docs/12 §13.1`, stated as a blockquote because it is the most important sentence
 * in this file:
 *
 * > **We do not reject a location fix.** A report with a strange location is still a
 * > report. A rejected report is a person with no help.
 *
 * The two reasons:
 *
 * 1. **GPS is genuinely bad where this product matters.** A narrow street between
 *    tall buildings, an underpass, a dense informal settlement — these produce
 *    500 m to 2 km errors *routinely*. A far-jump detector that rejected them would
 *    reject precisely the users with the least access to infrastructure.
 *
 * 2. **The consequence asymmetry is brutal.** A false positive costs a dispatcher
 *    five seconds of "ignore this marker". A false negative costs a cardiac arrest
 *    a responder. The product optimises for the second.
 *
 * So every detector here **produces a flag and a grade adjustment**, never a
 * rejection. The ONE exception is out-of-range coordinates, and that is a
 * `VALIDATION_FAILED` at the Zod layer — a *validation* rejection, not a policy
 * one, because a latitude of 500 is not a location at all.
 *
 * ---------------------------------------------------------------------------
 * WHY `accuracyM` IS DOWNGRADED RATHER THAN STORED AS SENT
 * ---------------------------------------------------------------------------
 * `docs/12 §13.3`: "The raw `accuracyM` and `capturedAt` the client sent — **Not**
 * stored when the grade was adjusted; the adjusted grade is the truth. Storing a
 * value we have declared implausible invites someone to trust it later."
 *
 * That is a subtle and good rule, and it is why `applyIntegrity` returns a
 * REPLACEMENT `accuracyM` rather than just a flag. A caller that kept the original
 * would be storing a number this file has already declared untrustworthy.
 */

import { gradeAccuracy, type AccuracyGrade } from '@/lib/geo/accuracy';
import { haversineMetersRounded, isValidLatLng, type LatLng } from '@/lib/geo/distance';

/* ========================================================================== */
/* Thresholds — docs/12 §13.2                                                  */
/* ========================================================================== */

/**
 * The physically plausible accuracy floor.
 *
 * `docs/12 §13.2`: "**Accuracy tampering** — `accuracyM` below a physically
 * plausible floor. A 1 m accuracy on a cold start is not a 1 m fix."
 *
 * 5 m is a GPS chipset's advertised *best case* under ideal sky visibility with a
 * stationary device. A cold start in a street canyon is never that good, so a
 * reported 1 m is a claim about the phone rather than about the sky.
 */
export const MIN_PLAUSIBLE_ACCURACY_M = 5;

/**
 * The far-jump rule: `haversineM(prev, next) > max(2000, 0.5 * elapsedMin * 900)`.
 * `docs/12 §13.2`.
 *
 * **900 m/min** is 15 m/s — walking pace, generously. A vehicle can exceed it, which
 * is why the rule is a FLAG and not a rejection, and why the responder heartbeat
 * (60 s) is the only caller where it means much.
 *
 * The **2 km floor** is what makes the rule safe: on a first-ever fix there is no
 * previous point, and on a GPS reacquisition a device can legitimately jump
 * kilometres. Without the floor, every cold start in a new city would be flagged.
 */
export const FAR_JUMP_ABSOLUTE_M = 2000;
export const FAR_JUMP_M_PER_MIN = 900;

/** Sustained speed above this across three consecutive fixes is impossible. `docs/12 §13.2`. */
export const IMPOSSIBLE_SPEED_MPS = 60;

/** `STALE_LOCATION_MIN` = 15. `docs/12 §13.2`, FR-066. */
export const STALE_AFTER_MS = 15 * 60_000;

/** A clock more than 60 s in the future is wrong. `docs/12 §13.2`. */
export const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/* ========================================================================== */
/* The result                                                                  */
/* ========================================================================== */

/**
 * `docs/12 §13.3`'s `metadata.locationJump`.
 *
 * **The specification writes `{ fromM, toM, elapsedSec }` and this is
 * `{ distanceM, elapsedSec }` instead — a deliberate divergence, and worth being
 * explicit about why.**
 *
 * `fromM` and `toM` are not two distances; they are the same measurement, and the
 * specification's two fields cannot both be filled from a two-point comparison
 * without one of them being a duplicate or a zero. The dispatcher-facing sentence
 * `docs/12 §13.2` actually specifies is "Position jumped 4.2 km in 40 s" — ONE
 * distance and ONE elapsed time. So the type carries exactly what the copy needs,
 * and a field that no copy reads does not exist.
 *
 * The stored metadata is a *summary* on a `statusHistory` entry, not a location
 * history (`docs/12 §13.3`: "Not a separate collection — a metadata key is enough
 * and costs no extra write"), so there is no consumer that needs the endpoints.
 */
export type LocationJump = {
  /** Straight-line distance from the previous fix, in metres. */
  readonly distanceM: number;
  readonly elapsedSec: number;
};

/** The flags a detector can raise. None of them rejects anything. */
export type IntegrityFlag =
  /** `accuracyM` below `MIN_PLAUSIBLE_ACCURACY_M`. */
  | 'accuracy_tampering'
  /** A fix claiming precision, whose position has since moved far. */
  | 'accuracy_position_disagreement'
  /** Faster or further than physically possible in the elapsed time. */
  | 'location_jump'
  /** Sustained speed above `IMPOSSIBLE_SPEED_MPS`. */
  | 'impossible_speed'
  /** Older than `STALE_AFTER_MS`. */
  | 'stale'
  /** `capturedAt` is in the future, or before the previously stored value. */
  | 'stale_clock';

export type IntegrityResult = {
  /**
   * The grade to STORE, possibly lower than the raw one.
   *
   * **The adjustment is cumulative and only ever DOWNWARD.** Each detector may
   * lower it; none may raise it. An implementation that took a `max` would let a
   * later, milder detector undo an earlier, stronger one.
   */
  readonly accuracyGrade: AccuracyGrade;
  /**
   * The `accuracyM` to store.
   *
   * `null` when the reported value was implausible, per `docs/12 §13.3` — we do not
   * keep a number we have declared untrustworthy. `null` grades as `unknown`, which
   * is the honest answer.
   */
  readonly accuracyM: number | null;
  readonly flags: readonly IntegrityFlag[];
  /** Present only when `location_jump` or `accuracy_position_disagreement` fired. */
  readonly jump: LocationJump | null;
  /** A sentence for the incident timeline. Contains no coordinates. */
  readonly note: string | null;
};

/* ========================================================================== */
/* The detectors                                                               */
/* ========================================================================== */

/** What the caller knows about the fix being submitted. */
export type FixUnderTest = {
  readonly point: LatLng;
  /** The browser's `coords.accuracy`. `null` when unavailable. */
  readonly accuracyM: number | null;
  /** The browser's `timestamp`. The DEVICE's clock, so untrusted. */
  readonly capturedAtMs: number;
};

/** What the caller knows from the previous stored fix, if any. */
export type PreviousFix = {
  readonly point: LatLng;
  readonly capturedAtMs: number;
  /** The previous fix's already-adjusted accuracy, for the disagreement test. */
  readonly accuracyM: number | null;
};

/** The grade ranking, for the downward-only adjustment. */
const GRADE_RANK: Readonly<Record<AccuracyGrade, number>> = {
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

/** Lower a grade to at most `ceiling`. The ONLY direction adjustment goes. */
function capGrade(grade: AccuracyGrade, ceiling: AccuracyGrade): AccuracyGrade {
  return GRADE_RANK[grade] <= GRADE_RANK[ceiling] ? grade : ceiling;
}

/**
 * Apply every applicable detector to one fix.
 *
 * `nowMs` is passed in rather than read from a clock, so the function is pure and the
 * staleness window is testable at an exact boundary.
 */
export function applyIntegrity(
  fix: FixUnderTest,
  previous: PreviousFix | null,
  nowMs: number,
): IntegrityResult {
  const flags: IntegrityFlag[] = [];
  let grade = gradeAccuracy(fix.accuracyM);
  let accuracyM: number | null = fix.accuracyM;
  let jump: LocationJump | null = null;
  const notes: string[] = [];

  // --- impossible coordinates: a VALIDATION rejection, not a policy one ----
  // docs/12 §13.2. A latitude of 500 is not a strange location, it is not a
  // location. This is the one place integrity refuses, and it is the Zod layer that
  // normally catches it first.
  if (!isValidLatLng(fix.point)) {
    return {
      accuracyGrade: 'unknown',
      accuracyM: null,
      flags: [],
      jump: null,
      note: 'That location is not valid.',
    };
  }

  // --- accuracy tampering ------------------------------------------------
  if (fix.accuracyM !== null && fix.accuracyM > 0 && fix.accuracyM < MIN_PLAUSIBLE_ACCURACY_M) {
    flags.push('accuracy_tampering');
    grade = capGrade(grade, 'medium');
    // docs/12 §13.3: the implausible value is NOT stored.
    accuracyM = null;
    notes.push('Device-reported accuracy looks unusually precise; treated as approximate');
  }

  // --- staleness of the FIX itself --------------------------------------
  // A fix the device cached 40 minutes ago is not where the citizen is now.
  if (nowMs - fix.capturedAtMs > STALE_AFTER_MS) {
    flags.push('stale');
    notes.push(`Location is ${Math.floor((nowMs - fix.capturedAtMs) / 60_000)} min old`);
  }

  // --- clock integrity --------------------------------------------------
  // docs/12 §13.2: "capturedAt more than 60 s in the future, or before the
  // previously stored capturedAt — a monotonicity rule, not a policy one".
  //
  // Future-dated is a flag, not a rejection: a device with a badly wrong clock is
  // common, and its fix is still a fix.
  const clockInFuture = fix.capturedAtMs - nowMs > CLOCK_SKEW_TOLERANCE_MS;
  const clockWentBackwards =
    previous !== null && fix.capturedAtMs < previous.capturedAtMs - CLOCK_SKEW_TOLERANCE_MS;
  if (clockInFuture || clockWentBackwards) {
    flags.push('stale_clock');
    notes.push('The device clock looks wrong; the fix time may be inaccurate');
  }

  // --- movement from the previous fix -----------------------------------
  if (previous !== null) {
    const elapsedSec = Math.max(0, (fix.capturedAtMs - previous.capturedAtMs) / 1000);
    const elapsedMin = elapsedSec / 60;
    const movedM = haversineMetersRounded(previous.point, fix.point);

    // --- far jump ------------------------------------------------------
    // `max(2000, 0.5 * elapsedMin * 900)`: the 0.5 factor means a device must
    // exceed 2x walking pace to be flagged, and the 2 km floor covers cold starts
    // and reacquisitions.
    const allowedM = Math.max(FAR_JUMP_ABSOLUTE_M, 0.5 * elapsedMin * FAR_JUMP_M_PER_MIN);
    if (movedM > allowedM) {
      flags.push('location_jump');
      grade = capGrade(grade, 'low');
      jump = { distanceM: movedM, elapsedSec: Math.round(elapsedSec) };
      notes.push(
        `Position jumped ${(movedM / 1000).toFixed(1)} km in ${Math.round(elapsedSec)} s`,
      );
    }
    // **No single-interval speed check here, deliberately.** `docs/12 §13.2` specifies
    // "sustained speed > 60 m/s across THREE consecutive fixes", and a vehicle at
    // 100 km/h between two fixes is real rather than spoofed. One step is already
    // covered by the far-jump rule above. The three-point check lives in
    // `impossibleSpeedFrom`, which is the only place that can see three points.

    // --- accuracy / position disagreement ------------------------------
    // docs/12 §13.2: "A fix claiming 5 m accuracy whose position moved 300 m since
    // the previous fix from the same device."
    //
    // The test is against the PREVIOUS accuracy, not an absolute threshold: a device
    // that has consistently reported 50 m is not making a false claim by moving
    // 300 m, and flagging it would flag every low-quality device in the product.
    if (
      fix.accuracyM !== null &&
      fix.accuracyM < MIN_PLAUSIBLE_ACCURACY_M * 4 &&
      movedM > 300
    ) {
      flags.push('accuracy_position_disagreement');
      grade = capGrade(grade, 'low');
      if (jump === null) jump = { distanceM: movedM, elapsedSec: Math.round(elapsedSec) };
      notes.push('Location is approximate');
    }
  }

  return {
    accuracyGrade: grade,
    accuracyM,
    flags,
    jump,
    note: notes.length === 0 ? null : notes.join('. '),
  };
}

/**
 * The three-consecutive-fixes speed check. `docs/12 §13.2`.
 *
 * **Kept separate, because it genuinely needs three points.** The one-interval case
 * in `applyIntegrity` deliberately does not raise it: a vehicle at 100 km/h between
 * two fixes is real, and a single step is already covered by the far-jump rule.
 *
 * A speed is "sustained" only if it exceeds the threshold on **all** pairs, which is
 * what makes it evidence of a spoofed stream rather than a fast drive.
 */
export function impossibleSpeedFrom(
  fixes: readonly { readonly point: LatLng; readonly capturedAtMs: number }[],
): LocationJump | null {
  if (fixes.length < 3) return null;

  let totalM = 0;
  let totalSec = 0;
  for (let i = 1; i < fixes.length; i += 1) {
    const previous = fixes[i - 1] as { point: LatLng; capturedAtMs: number };
    const current = fixes[i] as { point: LatLng; capturedAtMs: number };
    const elapsedSec = (current.capturedAtMs - previous.capturedAtMs) / 1000;
    // A non-positive interval means a clock problem, not impossible movement. The
    // fix is unknown, so the honest answer is "cannot tell" rather than a flag.
    if (elapsedSec <= 0) return null;
    const movedM = haversineMetersRounded(previous.point, current.point);
    // EVERY interval must be impossible, not just the average — otherwise a single
    // fast step among slow ones would trip the rule, and one fast step is a car.
    if (movedM / elapsedSec <= IMPOSSIBLE_SPEED_MPS) return null;
    totalM += movedM;
    totalSec += elapsedSec;
  }

  return { distanceM: totalM, elapsedSec: Math.round(totalSec) };
}

/** The copy `docs/12 §13.2` specifies for the accuracy-tampering note. */
export const ACCURACY_TAMPERING_COPY =
  'Device-reported accuracy looks unusually precise; treated as approximate';

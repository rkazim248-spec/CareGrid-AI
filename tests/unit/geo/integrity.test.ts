import { describe, expect, it } from 'vitest';

import {
  CLOCK_SKEW_TOLERANCE_MS,
  FAR_JUMP_ABSOLUTE_M,
  IMPOSSIBLE_SPEED_MPS,
  MIN_PLAUSIBLE_ACCURACY_M,
  STALE_AFTER_MS,
  applyIntegrity,
  impossibleSpeedFrom,
} from '@/lib/geo/integrity';

/* ========================================================================== */

const T0 = 1_760_000_000_000;
const KHI = { lat: 17.44, lng: 67.0 };

/** A point `metres` north of KHI, preserving longitude. */
function north(metres: number) {
  return { lat: KHI.lat + metres / 111_195, lng: KHI.lng };
}

function fix(over: { point?: { lat: number; lng: number }; accuracyM?: number | null; capturedAtMs?: number } = {}) {
  return {
    point: over.point ?? KHI,
    accuracyM: over.accuracyM === undefined ? 20 : over.accuracyM,
    capturedAtMs: over.capturedAtMs ?? T0,
  };
}

/* ========================================================================== */

describe('A CLEAN FIX IS LEFT EXACTLY AS IT IS', () => {
  it('a good GPS fix produces no flags and keeps its grade', () => {
    const result = applyIntegrity(fix({ accuracyM: 20 }), null, T0);
    expect(result.flags).toEqual([]);
    expect(result.accuracyGrade).toBe('high');
    // docs/12 §13.3: the value is preserved when nothing was wrong with it.
    expect(result.accuracyM).toBe(20);
    expect(result.note).toBeNull();
    expect(result.jump).toBeNull();
  });

  it('is deterministic for the same input', () => {
    const a = applyIntegrity(fix({ accuracyM: 35 }), null, T0);
    const b = applyIntegrity(fix({ accuracyM: 35 }), null, T0);
    expect(b).toEqual(a);
  });
});

/* ========================================================================== */

describe('NOTHING HERE EVER REJECTS A FIX — docs/12 §13.1', () => {
  // "We do not reject a location fix. A report with a strange location is still a
  // report. A rejected report is a person with no help."

  it.each([
    ['a 1 m accuracy claim', { accuracyM: 1 }],
    ['a 20 km jump', { point: north(20_000), capturedAtMs: T0 + 60_000 }],
    ['a fix 40 minutes old', { capturedAtMs: T0 - 40 * 60_000 }],
    ['a fix dated in the future', { capturedAtMs: T0 + 10 * 60_000 }],
  ])('%s produces a FLAG, never an exception', (_label, over) => {
    // Every one of these is a scenario where a naive implementation throws or
    // returns null, and the citizen loses their report.
    let result: ReturnType<typeof applyIntegrity> | null = null;
    expect(() => {
      result = applyIntegrity(fix(over as never), null, T0);
    }).not.toThrow();
    expect(result).not.toBeNull();
  });

  it('every flagging scenario still returns a usable grade', () => {
    // A caller cannot branch on "undefined grade" — there is always one.
    for (const over of [
      { accuracyM: 1 },
      { point: north(20_000), capturedAtMs: T0 + 60_000 },
      { capturedAtMs: T0 - 40 * 60_000 },
    ]) {
      const result = applyIntegrity(fix(over as never), null, T0);
      expect(['high', 'medium', 'low', 'unknown']).toContain(result.accuracyGrade);
    }
  });
});

/* ========================================================================== */

describe('the ONE rejection: impossible coordinates are a VALIDATION failure', () => {
  // docs/12 §13.2: "Rejected at the Zod layer: LOCATION_OUT_OF_RANGE (400). This is
  // a *validation* rejection, not a policy one."
  it('latitude 500 is not a location at all', () => {
    const result = applyIntegrity(fix({ point: { lat: 500, lng: 67 } }), null, T0);
    expect(result.accuracyGrade).toBe('unknown');
    expect(result.accuracyM).toBeNull();
    expect(result.note).toBe('That location is not valid.');
  });

  it('longitude 200 is refused', () => {
    expect(applyIntegrity(fix({ point: { lat: 17, lng: 200 } }), null, T0).note).toBe(
      'That location is not valid.',
    );
  });

  it('NaN is refused rather than stored', () => {
    expect(applyIntegrity(fix({ point: { lat: Number.NaN, lng: 67 } }), null, T0).note).toBe(
      'That location is not valid.',
    );
  });
});

/* ========================================================================== */

describe('accuracy tampering: a 1 m fix is a claim about the phone', () => {
  it('a 1 m accuracy is flagged and capped at medium', () => {
    // docs/12 §13.2: "A 1 m accuracy on a cold start is not a 1 m fix."
    const result = applyIntegrity(fix({ accuracyM: 1 }), null, T0);
    expect(result.flags).toContain('accuracy_tampering');
    expect(result.accuracyGrade).toBe('medium');
  });

  it('the implausible value is DISCARDED, not stored — docs/12 §13.3', () => {
    // "Not stored when the grade was adjusted; the adjusted grade is the truth.
    // Storing a value we have declared implausible invites someone to trust it
    // later."
    const result = applyIntegrity(fix({ accuracyM: 1 }), null, T0);
    expect(result.accuracyM).toBeNull();
  });

  it('a 4 m accuracy is still flagged; 5 m is the floor', () => {
    expect(applyIntegrity(fix({ accuracyM: 4 }), null, T0).flags).toContain('accuracy_tampering');
    expect(applyIntegrity(fix({ accuracyM: 5 }), null, T0).flags).not.toContain('accuracy_tampering');
    expect(MIN_PLAUSIBLE_ACCURACY_M).toBe(5);
  });

  it('a normal accuracy is untouched', () => {
    const result = applyIntegrity(fix({ accuracyM: 30 }), null, T0);
    expect(result.flags).not.toContain('accuracy_tampering');
    expect(result.accuracyM).toBe(30);
  });
});

/* ========================================================================== */

describe('the grade is only ever adjusted DOWNWARD', () => {
  it('a medium fix is not promoted to high by a passing detector', () => {
    const result = applyIntegrity(fix({ accuracyM: 150 }), null, T0);
    expect(result.accuracyGrade).toBe('medium');
  });

  it('two detectors both firing give the LOWER grade, not the last one', () => {
    // Accuracy tampering caps at medium; a far jump caps at low. `low` is lower, so
    // the result must be `low`. A `max()` implementation would return `medium` here
    // depending on order.
    const result = applyIntegrity(
      fix({ accuracyM: 2, point: north(9_000), capturedAtMs: T0 + 60_000 }),
      fix({ accuracyM: 10, capturedAtMs: T0 }),
      T0,
    );
    expect(result.flags).toContain('accuracy_tampering');
    expect(result.flags).toContain('location_jump');
    expect(result.accuracyGrade).toBe('low');
  });

  it('an unknown grade is never raised', () => {
    expect(applyIntegrity(fix({ accuracyM: null }), null, T0).accuracyGrade).toBe('unknown');
  });
});

/* ========================================================================== */

describe('the far-jump rule, at its documented thresholds', () => {
  it('2 km in one step is exactly at the floor and NOT flagged', () => {
    // The comparison is `>`, so 2000 m is allowed. docs/12 §13.2:
    // "max(2 000, 0.5 x elapsedMinutes x 900)".
    const result = applyIntegrity(
      fix({ point: north(2000), capturedAtMs: T0 + 1000 }),
      fix({ capturedAtMs: T0 }),
      T0 + 1000,
    );
    expect(result.flags).not.toContain('location_jump');
    expect(FAR_JUMP_ABSOLUTE_M).toBe(2000);
  });

  it('2.1 km in one step IS flagged', () => {
    const result = applyIntegrity(
      fix({ point: north(2100), capturedAtMs: T0 + 1000 }),
      fix({ capturedAtMs: T0 }),
      T0 + 1000,
    );
    expect(result.flags).toContain('location_jump');
    expect(result.accuracyGrade).toBe('low');
  });

  it('a GPS reacquisition after a long gap is NOT flagged', () => {
    // The reason the 2 km FLOOR exists. Waking from a 20-minute sleep and locking a
    // new position legitimately jumps kilometres, and flagging every one of those
    // would flag every device that ever backgrounded the app.
    const result = applyIntegrity(
      fix({ point: north(8_000), capturedAtMs: T0 + 20 * 60_000 }),
      fix({ capturedAtMs: T0 }),
      T0 + 20 * 60_000,
    );
    // 0.5 * 20 min * 900 = 9000 m allowed, so 8 km passes.
    expect(result.flags).not.toContain('location_jump');
  });

  it('the note names the distance AND the time gap, as docs/12 §13.2 specifies', () => {
    const result = applyIntegrity(
      fix({ point: north(4200), capturedAtMs: T0 + 40_000 }),
      fix({ capturedAtMs: T0 }),
      T0 + 40_000,
    );
    expect(result.note).toContain('4.2 km');
    expect(result.note).toContain('40 s');
    expect(result.jump?.distanceM).toBe(4200);
    expect(result.jump?.elapsedSec).toBe(40);
  });

  it('the jump metadata contains NO coordinates', () => {
    // docs/12 §13.3 logs a metadata KEY, and a summary on a statusHistory entry.
    // A coordinate in there would be a precise location in a log line.
    const result = applyIntegrity(
      fix({ point: north(4200), capturedAtMs: T0 + 40_000 }),
      fix({ capturedAtMs: T0 }),
      T0 + 40_000,
    );
    const serialised = JSON.stringify(result.jump);
    expect(serialised).not.toContain('17.4');
    expect(serialised).not.toContain('67');
  });
});

/* ========================================================================== */

describe('accuracy/position disagreement', () => {
  it('a 5 m fix whose position moved 300 m is flagged', () => {
    // docs/12 §13.2: "A fix claiming 5 m accuracy whose position moved 300 m since
    // the previous fix from the same device."
    const result = applyIntegrity(
      fix({ accuracyM: 5, point: north(400), capturedAtMs: T0 + 60_000 }),
      fix({ accuracyM: 50, capturedAtMs: T0 }),
      T0 + 60_000,
    );
    expect(result.flags).toContain('accuracy_position_disagreement');
    expect(result.accuracyGrade).toBe('low');
  });

  it('a device that has ALWAYS claimed 50 m is NOT flagged for moving 300 m', () => {
    // The test is against the PREVIOUS accuracy, not an absolute threshold. A device
    // that consistently reports 50 m is not lying by moving 300 m, and flagging it
    // would flag every low-quality device in the product — which is precisely the
    // false positive docs/12 §13.1 says to optimise against.
    const result = applyIntegrity(
      fix({ accuracyM: 50, point: north(400), capturedAtMs: T0 + 60_000 }),
      fix({ accuracyM: 50, capturedAtMs: T0 }),
      T0 + 60_000,
    );
    expect(result.flags).not.toContain('accuracy_position_disagreement');
  });
});

/* ========================================================================== */

describe('staleness, at the exact 15-minute boundary', () => {
  it('14:59 is fresh', () => {
    const result = applyIntegrity(fix({ capturedAtMs: T0 - (15 * 60_000 - 1000) }), null, T0);
    expect(result.flags).not.toContain('stale');
  });

  it('15:01 is stale', () => {
    const result = applyIntegrity(fix({ capturedAtMs: T0 - (15 * 60_000 + 1000) }), null, T0);
    expect(result.flags).toContain('stale');
  });

  it('the note names how many minutes old it is — docs/12 §13.2', () => {
    const result = applyIntegrity(fix({ capturedAtMs: T0 - 40 * 60_000 }), null, T0);
    expect(result.note).toContain('40 min old');
    expect(STALE_AFTER_MS).toBe(15 * 60_000);
  });

  it('a stale fix keeps its grade — staleness is not an accuracy claim', () => {
    // A cached fix from 40 minutes ago was a GOOD fix when it was taken. Marking it
    // `unknown` would lose that information; the `stale` flag carries the real
    // problem.
    const result = applyIntegrity(fix({ accuracyM: 20, capturedAtMs: T0 - 40 * 60_000 }), null, T0);
    expect(result.accuracyGrade).toBe('high');
    expect(result.flags).toContain('stale');
  });
});

/* ========================================================================== */

describe('clock integrity is a FLAG, not a rejection', () => {
  it('a clock 10 minutes in the future is flagged', () => {
    // A device with a badly wrong clock is common, and its fix is still a fix.
    const result = applyIntegrity(fix({ capturedAtMs: T0 + 10 * 60_000 }), null, T0);
    expect(result.flags).toContain('stale_clock');
    expect(result.accuracyGrade).toBe('high');
  });

  it('a clock 30 seconds in the future is within tolerance', () => {
    const result = applyIntegrity(fix({ capturedAtMs: T0 + 30_000 }), null, T0);
    expect(result.flags).not.toContain('stale_clock');
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(60_000);
  });

  it('a clock that went BACKWARDS is flagged (monotonicity)', () => {
    const result = applyIntegrity(
      fix({ capturedAtMs: T0 - 5 * 60_000 }),
      fix({ capturedAtMs: T0 }),
      T0,
    );
    expect(result.flags).toContain('stale_clock');
  });

  it('a small backwards step is within tolerance', () => {
    const result = applyIntegrity(
      fix({ capturedAtMs: T0 - 10_000 }),
      fix({ capturedAtMs: T0 }),
      T0,
    );
    expect(result.flags).not.toContain('stale_clock');
  });
});

/* ========================================================================== */

describe('impossible speed needs THREE fixes, not two', () => {
  // docs/12 §13.2: "Sustained speed > 60 m/s (216 km/h) across three consecutive
  // fixes".

  it('fewer than three fixes cannot be "sustained"', () => {
    expect(impossibleSpeedFrom([])).toBeNull();
    expect(impossibleSpeedFrom([{ point: KHI, capturedAtMs: T0 }])).toBeNull();
    expect(
      impossibleSpeedFrom([
        { point: KHI, capturedAtMs: T0 },
        { point: north(1000), capturedAtMs: T0 + 1000 },
      ]),
    ).toBeNull();
  });

  it('a 216 km/h vehicle between TWO fixes is not flagged by applyIntegrity', () => {
    // 1000 m in 1 s is 1000 m/s, which is absurd — but a single step is what the
    // far-jump rule covers, and a real car CAN cover 1 km in 30 s. Raising
    // `impossible_speed` on one interval would flag every fast drive on a highway.
    const result = applyIntegrity(
      fix({ point: north(1000), capturedAtMs: T0 + 30_000 }),
      fix({ capturedAtMs: T0 }),
      T0 + 30_000,
    );
    expect(result.flags).not.toContain('impossible_speed');
  });

  it('THREE consecutive impossible intervals DO produce a jump', () => {
    // 1 km per 10 s = 100 m/s on every interval.
    const jump = impossibleSpeedFrom([
      { point: KHI, capturedAtMs: T0 },
      { point: north(1000), capturedAtMs: T0 + 10_000 },
      { point: north(2000), capturedAtMs: T0 + 20_000 },
      { point: north(3000), capturedAtMs: T0 + 30_000 },
    ]);
    expect(jump).not.toBeNull();
    expect(jump?.distanceM).toBe(3000);
    expect(IMPOSSIBLE_SPEED_MPS).toBe(60);
  });

  it('one slow interval among fast ones is NOT enough', () => {
    // "Sustained" means EVERY interval, not the average. A car that accelerates,
    // cruises and then stops is not a spoofed stream.
    expect(
      impossibleSpeedFrom([
        { point: KHI, capturedAtMs: T0 },
        { point: north(1000), capturedAtMs: T0 + 10_000 },
        { point: north(1010), capturedAtMs: T0 + 20_000 },
        { point: north(2000), capturedAtMs: T0 + 30_000 },
      ]),
    ).toBeNull();
  });

  it('a real drive at 100 km/h is never flagged', () => {
    // 27.8 m/s sustained — fast, and completely ordinary.
    expect(
      impossibleSpeedFrom([
        { point: KHI, capturedAtMs: T0 },
        { point: north(1670), capturedAtMs: T0 + 60_000 },
        { point: north(3340), capturedAtMs: T0 + 120_000 },
        { point: north(5010), capturedAtMs: T0 + 180_000 },
      ]),
    ).toBeNull();
  });

  it('a non-positive interval means "cannot tell", not a flag', () => {
    // A clock problem, not impossible movement. The honest answer is to decline.
    expect(
      impossibleSpeedFrom([
        { point: KHI, capturedAtMs: T0 },
        { point: north(1000), capturedAtMs: T0 + 10_000 },
        { point: north(2000), capturedAtMs: T0 },
      ]),
    ).toBeNull();
  });
});

/* ========================================================================== */

describe('no note ever contains a coordinate', () => {
  it('across every flagging scenario', () => {
    // docs/12 §13.3 logs a summary, and a note ends up in a statusHistory entry
    // visible to a dispatcher and in any log aggregation.
    const scenarios = [
      applyIntegrity(fix({ accuracyM: 1 }), null, T0),
      applyIntegrity(fix({ capturedAtMs: T0 - 40 * 60_000 }), null, T0),
      applyIntegrity(fix({ capturedAtMs: T0 + 10 * 60_000 }), null, T0),
      applyIntegrity(
        fix({ point: north(4200), capturedAtMs: T0 + 40_000 }),
        fix({ capturedAtMs: T0 }),
        T0 + 40_000,
      ),
    ];
    for (const result of scenarios) {
      if (result.note === null) continue;
      expect(result.note, result.note).not.toMatch(/\d+\.\d{3,}/);
    }
  });
});

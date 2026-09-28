/**
 * ============================================================================
 * The AI triage microcopy — `features/reporting/ai-triage-copy.ts`
 * ============================================================================
 *
 * docs/04 §15 states three tone rules as MUSTs, and they are the only rules in
 * this project that are checkable as a property of a STRING TABLE rather than of
 * a human reading a screen. That makes them worth asserting mechanically, and it
 * is the reason the copy lives in its own file.
 *
 * The rules, verbatim from docs/04 §15:
 *
 *  - A4: **no exclamation marks**
 *  - no "successfully"
 *  - the AI is advisory, never the actor
 *  - a location is never described more precisely than it is (A5)
 *
 * Each has a specific failure it prevents, and each has been observed in a
 * product somewhere: an exclamation mark in an emergency product reads as
 * reassurance the system cannot offer; "successfully" claims an outcome rather
 * than reporting one; a sentence that makes the AI the subject turns a suggestion
 * into an action; and a confident location phrase sends a responder to a place
 * nobody verified.
 */

import { describe, expect, it } from 'vitest';

import { AI_TRIAGE_COPY } from '@/features/reporting/ai-triage-copy';
import { SAFETY_FLAGS } from '@/types/enums';

/** Every string in the table, including the ones the functions return. */
function everyString(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'function') {
      // Sampled, not exhaustive: the functions take numbers and enum lists, and
      // the point is the vocabulary they use, not every permutation.
      for (const argument of [0, 5, 15, 60, 240, 3] as unknown[]) {
        try {
          out.push(String((value as (a: unknown) => unknown)(argument)));
        } catch {
          // A function that rejects this sample is not a copy function.
        }
      }
    } else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item);
    }
  };
  walk(AI_TRIAGE_COPY);
  return out;
}

const ALL_COPY = everyString();

describe('A4: no exclamation marks anywhere in the AI copy', () => {
  it('holds across every string in the table', () => {
    for (const sentence of ALL_COPY) {
      expect(sentence, `"${sentence}" contains an exclamation mark`).not.toContain('!');
    }
  });
});

describe('no "successfully", and no claim of an outcome', () => {
  it.each(['successfully', 'success', 'done!', 'complete!'])('does not say %s', (word) => {
    for (const sentence of ALL_COPY) {
      expect(sentence.toLowerCase(), `"${sentence}" claims an outcome`).not.toContain(word);
    }
  });

  it('the failure copy does not blame the reporter', () => {
    // A person who cannot get AI to work is told the AI is unavailable, never that
    // their report was insufficient. docs/04 §15.
    expect(AI_TRIAGE_COPY.unavailableBody).not.toMatch(/you (must|need to|should have)/i);
  });
});

describe('the AI is advisory, never the actor', () => {
  it('the panel disclaimer says a person decides', () => {
    expect(AI_TRIAGE_COPY.disclaimer).toMatch(/not a decision/i);
    expect(AI_TRIAGE_COPY.disclaimer).toMatch(/person reviews/i);
  });

  it('no sentence makes the AI the subject of an action', () => {
    // The failure mode is "The AI will contact responders" or "AI has dispatched".
    // A subject test rather than a banned-word list, because the dangerous
    // sentence is written differently every time.
    for (const sentence of ALL_COPY) {
      const subject = sentence.match(/^\s*the ai\s+(\w+)/i);
      if (subject !== null) {
        const verb = (subject[1] as string).toLowerCase();
        expect(
          ['assessment', 'suggested', 'suggests', 'confidence', 'could', 'did', 'was', 'is'],
          `"${sentence}" — the AI must not be the subject of "${verb}"`,
        ).toContain(verb);
      }
    }
  });

  it('nothing promises a dispatch', () => {
    for (const sentence of ALL_COPY) {
      expect(sentence.toLowerCase(), `"${sentence}" promises a dispatch`).not.toMatch(
        /\b(will|has) (dispatch|send|contact|alert|call)\b/,
      );
    }
  });

  it('the resources help text says nothing has been requested', () => {
    // brief §3: the AI must not "dispatch responders" or "contact emergency
    // services". Saying so on the panel is the user-facing half of that rule.
    expect(AI_TRIAGE_COPY.resourcesHelp).toMatch(/nothing has been requested or sent/i);
  });
});

describe('a location is never described more precisely than it is', () => {
  it('no copy string claims an exact, verified, or confirmed location', () => {
    for (const sentence of ALL_COPY) {
      expect(sentence.toLowerCase(), `"${sentence}" asserts a location`).not.toMatch(
        /\b(exact location|verified location|confirmed location|location confirmed)\b/,
      );
    }
  });

  it('the SLA hint promises a priority, not a response time', () => {
    // A minute count in a citizen-facing promise is one the system cannot keep in
    // a city with traffic, and it is not this screen's promise to make. The
    // dispatcher's SLA lives in `URGENCY_META.ariaTemplate`, which is where it
    // belongs.
    for (const minutes of [5, 15, 60, 240]) {
      expect(AI_TRIAGE_COPY.slaHint(minutes)).not.toMatch(/\d+ ?min/);
      expect(AI_TRIAGE_COPY.slaHint(minutes)).not.toMatch(/within/i);
    }
  });

  it('the SLA hint still distinguishes the bands', () => {
    expect(AI_TRIAGE_COPY.slaHint(5)).toMatch(/immediate/i);
    expect(AI_TRIAGE_COPY.slaHint(15)).not.toMatch(/immediate/i);
    expect(AI_TRIAGE_COPY.slaHint(240)).toMatch(/routine/i);
  });
});

describe('brief §14: confidence is never a bare percentage', () => {
  it('always labels the number as an AI estimate', () => {
    for (const percent of [0, 30, 55, 91, 100]) {
      const sentence = AI_TRIAGE_COPY.confidenceLabel(percent);
      expect(sentence).toContain(`${percent}%`);
      expect(sentence).toMatch(/AI assessment/i);
      expect(sentence).toMatch(/not a certainty|estimate/i);
    }
  });

  it('a null confidence says the AI gave no score, rather than showing 0%', () => {
    // "0%" would read as "the AI is certain nothing is wrong", which is the
    // opposite of the truth.
    expect(AI_TRIAGE_COPY.confidenceUnavailable).not.toMatch(/\d/);
    expect(AI_TRIAGE_COPY.confidenceUnavailable).toMatch(/person/i);
  });
});

describe('brief §7 and docs/09 R4: the people field is honest', () => {
  it('says only the reporter can supply it', () => {
    expect(AI_TRIAGE_COPY.peopleHelp).toMatch(/only you/i);
  });

  it('says a blank is honest', () => {
    // The copy is what stops a citizen guessing to fill a field the system left
    // empty, which is how a fabricated casualty count starts.
    expect(AI_TRIAGE_COPY.peopleHelp).toMatch(/blank is honest/i);
  });
});

describe('brief §19: the manual path is stated, not implied', () => {
  it('the failure copy says the report can still be submitted', () => {
    expect(AI_TRIAGE_COPY.unavailableBody).toMatch(/still be submitted/i);
  });

  it('offers a way to continue without the AI', () => {
    expect(AI_TRIAGE_COPY.continueManually).toMatch(/without ai/i);
  });

  it('the unconfigured state says submitting does not change', () => {
    expect(AI_TRIAGE_COPY.notConfiguredBody).toMatch(/nothing about submitting changes/i);
  });
});

describe('brief §26: a mock is LOUD', () => {
  it('the simulated badge says no AI was called', () => {
    expect(AI_TRIAGE_COPY.simulatedBadge).toMatch(/no ai was called/i);
  });

  it('the fallback badge says it is a keyword match, not an AI answer', () => {
    // A citizen reading "AI assessment" on a keyword-matched record has been told
    // something false, and the record genuinely is different.
    expect(AI_TRIAGE_COPY.fallbackBadge).toMatch(/keyword match/i);
    expect(AI_TRIAGE_COPY.fallbackBadge).toMatch(/person will review/i);
  });
});

describe('the safety flag labels come from ONE source', () => {
  it('every flag has wording', () => {
    for (const flag of SAFETY_FLAGS) {
      const label = AI_TRIAGE_COPY.flagLabels[flag];
      expect(label, `no label for ${flag}`).toBeTruthy();
      // A raw enum value would read as `medical_critical` next to a sentence
      // about the reader's own emergency.
      expect(label, `"${label}" is the raw enum value`).not.toBe(flag);
      expect(label).toMatch(/^[A-Z]/);
    }
  });

  it('every label is unique, so two flags cannot render the same badge', () => {
    const labels = SAFETY_FLAGS.map((flag) => AI_TRIAGE_COPY.flagLabels[flag]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('brief §17: the loading steps are real phases, not filler', () => {
  it('has five named steps', () => {
    expect(AI_TRIAGE_COPY.steps).toHaveLength(5);
  });

  it('names no percentages and no durations', () => {
    // brief §17: "Do not fake progress percentages."
    for (const step of AI_TRIAGE_COPY.steps) {
      expect(step).not.toMatch(/\d+%/);
      expect(step).not.toMatch(/\d+ ?s(ec|econd)?/i);
    }
  });
});

describe('the copy table is complete enough to render the panel', () => {
  it('has a title, a disclaimer, and both actions', () => {
    expect(AI_TRIAGE_COPY.title).toBeTruthy();
    expect(AI_TRIAGE_COPY.disclaimer).toBeTruthy();
    expect(AI_TRIAGE_COPY.confirm).toBeTruthy();
    expect(AI_TRIAGE_COPY.dismiss).toBeTruthy();
    expect(AI_TRIAGE_COPY.reanalyse).toBeTruthy();
  });

  it('the table is non-trivial, so a silent emptying fails a test', () => {
    // A guard against someone replacing the object with a partial one. It is a
    // crude check and it is here because the failure it catches — a panel
    // rendering blank strings after a refactor — is invisible in review.
    expect(ALL_COPY.length).toBeGreaterThan(30);
    for (const sentence of ALL_COPY) {
      expect(sentence.trim().length, 'a copy string is empty').toBeGreaterThan(0);
    }
  });
});

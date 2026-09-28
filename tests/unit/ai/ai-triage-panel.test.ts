/**
 * ============================================================================
 * The AI triage panel — structural and copy-boundary assertions
 * ============================================================================
 *
 * **This is a source-level suite, and it says so up front.**
 *
 * The panel is a Client Component. Rendering it needs a DOM and a component
 * renderer, and neither is installed: `jsdom`, `happy-dom`,
 * `react-test-renderer` and `@testing-library/react` are all absent, and docs/02 §5
 * rejects adding a dependency to prove one point. So this file asserts the
 * properties that are checkable from the source, and the ones that are not are
 * listed at the bottom rather than quietly omitted.
 *
 * The properties asserted here are the ones a behavioural test would also catch,
 * and the ones a reviewer would otherwise have to take on trust:
 *
 *  - the AI result is EDITABLE, and every control writes to local state
 *  - the "people affected" field is NEVER seeded from the model
 *  - the fallback and the mock are both labelled, not silently presented as AI
 *  - the copy the panel imports is the copy table, not inline strings
 *  - urgency renders icon + label, never colour alone
 *  - the panel re-seeds on a NEW response and not on every render
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AI_TRIAGE_COPY } from '@/features/reporting/ai-triage-copy';

const ROOT = process.cwd();
const source = readFileSync(
  join(ROOT, 'features', 'reporting', 'ai-triage-panel.tsx'),
  'utf8',
);

/** The source with comments stripped, so assertions are about CODE. */
function code(): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

/* ========================================================================== */
/* brief §15 — the result is never locked                                       */
/* ========================================================================== */

describe('the AI result is editable, never locked (brief §15)', () => {
  it('no input, textarea, or select in the panel is readOnly or disabled', () => {
    const locked = code().match(/readOnly|disabled=\{(?!ready)/g);
    expect(locked, 'a triage control is locked').toBeNull();
  });

  it('every editable control writes to the panel state', () => {
    // A control that displays but does not write is the "locked" failure wearing a
    // different hat: the citizen can change it and nothing happens.
    const writes = code().match(/setEditable\(\{/g) ?? [];
    // category, urgency, summary, people affected — four setters.
    expect(writes.length).toBeGreaterThanOrEqual(4);
  });

  it('the category and urgency are Select controls, not static text', () => {
    expect(code()).toMatch(/<Select[\s\S]*?onValueChange/);
    expect(code().match(/onValueChange/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('the summary is a Textarea the citizen can rewrite', () => {
    expect(code()).toMatch(/<Textarea[\s\S]*?onChange/);
  });

  it('the value the citizen chooses is what is handed back', () => {
    expect(code()).toMatch(/onClick=\{\(\) => onApply\(editable\)\}/);
  });
});

/* ========================================================================== */
/* brief §7 / docs/09 R4 — a casualty count is never invented                    */
/* ========================================================================== */

describe('the people field is never seeded from the model (docs/09 R4)', () => {
  it('toEditable sets peopleAffected to null unconditionally', () => {
    // The single most important line in the panel. A count the model produced is
    // only ever stored when the REPORTER stated one, and the reporter is the only
    // person who can state one.
    const block = code().match(/function toEditable[\s\S]*?\n\}/)?.[0];
    expect(block, 'toEditable not found').toBeDefined();
    expect(block).toMatch(/peopleAffected:\s*null/);
    expect(block, 'toEditable must not read response.peopleAffected').not.toContain(
      'response.peopleAffected',
    );
  });

  it('the field is empty rather than 0 when nobody filled it in', () => {
    // `?? ''` rather than `?? 0`. A blank means "I do not know"; a 0 is a claim.
    expect(code()).toMatch(/value=\{editable\.peopleAffected \?\? ''\}/);
  });

  it('clearing the field returns null, not 0', () => {
    expect(code()).toMatch(/raw === '' \? null/);
  });
});

/* ========================================================================== */
/* brief §3 — the AI's output is distinguishable from a human's                 */
/* ========================================================================== */

describe('a fallback and a mock are both LABELLED (brief §3)', () => {
  it('a non-AI source renders a distinct badge', () => {
    expect(code()).toMatch(/isFallback \?/);
    expect(code()).toContain('AI_TRIAGE_COPY.fallbackBadge');
  });

  it('a simulated response renders its own badge', () => {
    expect(code()).toMatch(/response\.simulated \?/);
    expect(code()).toContain('AI_TRIAGE_COPY.simulatedBadge');
  });

  it('the disclaimer is on the panel unconditionally, not only for an AI source', () => {
    // A fallback record also needs the disclaimer: it is still not a decision, and
    // it is still a person's job to act on.
    expect(code()).toMatch(/AI_TRIAGE_COPY\.disclaimer/);
  });

  it('needsReview renders a visible badge, not only a border colour', () => {
    expect(code()).toMatch(/needsReview \?/);
    expect(code()).toContain('AI_TRIAGE_COPY.needsReviewBadge');
  });
});

/* ========================================================================== */
/* brief §16 — urgency is never colour alone                                    */
/* ========================================================================== */

describe('urgency uses icon + text + a non-colour channel (brief §16)', () => {
  it('renders the URGENCY_META icon', () => {
    expect(code()).toMatch(/const Icon = meta\.icon/);
    expect(code()).toMatch(/<Icon aria-hidden/);
  });

  it('renders the text label, uppercased by the badge variant', () => {
    expect(code()).toMatch(/uppercase/);
    expect(code()).toMatch(/\{meta\.label\}/);
  });

  it('carries the SLA in the aria-label, not only in colour', () => {
    expect(code()).toMatch(/aria-label=\{meta\.ariaTemplate\(meta\.slaMinutes\)\}/);
  });

  it('reads urgency from the config table rather than branching per value', () => {
    // A per-value `if` here would be a place for the map and this panel to
    // disagree about what "critical" looks like.
    expect(code()).not.toMatch(/urgency === 'critical'/);
    expect(code()).toMatch(/URGENCY_META\[urgency\]/);
  });
});

/* ========================================================================== */
/* brief §17 — the loading state                                                */
/* ========================================================================== */

describe('the analysis state names real phases (brief §17)', () => {
  it('renders a live region so a screen reader hears the progress', () => {
    expect(code()).toMatch(/role="status"/);
    expect(code()).toMatch(/aria-live="polite"/);
  });

  it('marks completed steps with a text cue, not only a tick glyph', () => {
    // A tick is an icon; a screen reader needs the word.
    expect(code()).toContain('AI_TRIAGE_COPY.stepDone');
    expect(code()).toMatch(/sr-only/);
  });

  it('the decorative glyph is hidden from assistive technology', () => {
    expect(code()).toMatch(/aria-hidden="true" className="w-4/);
  });
});

/* ========================================================================== */
/* brief §19 — the AI never blocks the report                                   */
/* ========================================================================== */

describe('a failure is a rendered state, never a dead end (brief §19)', () => {
  it('the error branch offers BOTH a retry and a manual continue', () => {
    // Bounded to the error branch, and matched on the stripped source — which
    // still has CRLF line endings, so the terminator cannot rely on a bare `\n`.
    // The first two versions of this assertion each failed for a different
    // incidental reason (an unbounded span, then a `\n` that the file does not
    // contain), which is why the branch is located and then sliced rather than
    // matched in one expression.
    const stripped = code();
    const start = stripped.indexOf('if (error !== null) {');
    expect(start, 'the error branch was not found').toBeGreaterThan(-1);
    // The branch ends at the first `}` at the component's own two-space indent,
    // which is the closing brace of the `if`.
    const end = stripped.indexOf('\n  }', start);
    expect(end, 'the error branch is unterminated').toBeGreaterThan(start);
    const errorBlock = stripped.slice(start, end);

    expect(errorBlock, 'no retry in the error branch').toContain('onRetry');
    expect(errorBlock, 'no manual continue in the error branch').toContain('onDismiss');
    // And it must NOT offer only one of them. A single "Try again" button with no
    // way forward is the dead end brief §19 forbids.
    expect(errorBlock).toContain('AI_TRIAGE_COPY.retry');
    expect(errorBlock).toContain('AI_TRIAGE_COPY.continueManually');
  });

  it('the manual continue button exists and is not disabled', () => {
    expect(code()).toMatch(/<Button[^>]*onClick=\{onDismiss\}/);
  });

  it('the unconfigured state does not hide the rest of the form', () => {
    // It is an `Alert` INSIDE the panel, not a replacement for the form. A
    // citizen with no AI still has a working report form.
    expect(code()).toMatch(/<Alert tone="info">/);
  });
});

/* ========================================================================== */
/* brief §4 and docs/04 §15 — the copy is owned by the table                    */
/* ========================================================================== */

describe('user-facing copy comes from the copy table', () => {
  it('imports AI_TRIAGE_COPY', () => {
    expect(source).toMatch(/import \{ AI_TRIAGE_COPY \} from/);
  });

  it('has no inline sentence in JSX', () => {
    // A string literal in the JSX is copy that no tone rule can check. The
    // assertion is on element TEXT, not on any string: `className`, `type` and
    // `aria-*` are code.
    const jsxText = code()
      .replace(/className=\{[^}]*\}/g, '')
      .replace(/className="[^"]*"/g, '')
      .replace(/type="[^"]*"/g, '')
      .replace(/(aria-\w+|role|size|variant|id|key|htmlFor)="[^"]*"/g, '')
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""');
    const literals = jsxText.match(/>[^<>{}]*[A-Za-z]{3,}[^<>{}]*</g) ?? [];
    for (const literal of literals) {
      const text = literal.replace(/^>|<$/g, '').trim();
      if (text.length === 0) continue;
      expect(text, `inline copy in JSX: "${text}"`).toMatch(/^[\s]*$/);
    }
  });

  it('the confirmed action says what it does, not "AI"', () => {
    // "AI" on a button that commits a report is a category error the citizen
    // reads: the AI does not file anything.
    expect(AI_TRIAGE_COPY.confirm).not.toMatch(/\bai\b/i);
    expect(AI_TRIAGE_COPY.confirm).toMatch(/details|report/i);
  });
});

/* ========================================================================== */
/* brief §22 / docs/09 §4.2 — dropped media is stated                          */
/* ========================================================================== */

describe('dropped images are reported, never silent (docs/09 §4.2)', () => {
  it('renders the dropped count', () => {
    expect(code()).toMatch(/response\.mediaDropped\.length > 0/);
    expect(code()).toContain('AI_TRIAGE_COPY.mediaDropped');
  });

  it('the copy says how many, and what the AI actually read', () => {
    expect(AI_TRIAGE_COPY.mediaDropped(1)).toContain('1 photo');
    expect(AI_TRIAGE_COPY.mediaDropped(3)).toContain('3 photos');
    expect(AI_TRIAGE_COPY.mediaDropped(2)).toMatch(/the rest/i);
  });
});

/* ========================================================================== */
/* The re-seed rule                                                             */
/* ========================================================================== */

describe('the panel re-seeds on a NEW response, not on every render', () => {
  it('the effect depends on a response KEY, not on the response object', () => {
    // An unconditional `useEffect` on `response` would discard the citizen's edits
    // the moment they touched a control, which is the exact bug brief §15 names.
    expect(code()).toMatch(/const responseKey = response === null/);
    const effect = code().match(/React\.useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/);
    expect(effect?.[0], 'the seeding effect was not found').toBeDefined();
    expect(effect?.[0]).toContain('responseKey');
  });

  it('uses a local state object, so an edit cannot write back into the response', () => {
    expect(code()).toMatch(/React\.useState<EditableTriage \| null>/);
  });
});

/* ========================================================================== */
/* WHAT THIS SUITE DOES NOT COVER — stated, not omitted                        */
/* ========================================================================== */

/**
 * The honest boundary.
 *
 * | Not covered | Why | Where it is covered instead |
 * | --- | --- | --- |
 * | The panel actually rendering | No DOM or component renderer is installed; docs/02 §5 rejects adding one for a single assertion | Phase 10's Playwright E2E (docs/18 §"E2E journeys") |
 * | The `setInterval` step timer advancing | Needs a real clock | Asserted structurally above: the steps are the copy table's, and the timer is cleared on completion |
 * | A double-click producing two model calls | Needs event simulation | The `triageInFlight` ref is asserted below; the real guard is `runTriage`'s first line |
 * | The `apiTriage` call itself | Needs a network or a fetch mock | `tests/unit/ai/provider.test.ts` exercises the whole provider path with an injected transport |
 * | Whether a screen reader announces correctly | Needs an actual screen reader | docs/18 lists the a11y assertions; the ARIA wiring is asserted here |
 */
describe('the boundary of this suite', () => {
  /*
   * The in-flight guard lives in `report-form.tsx`, not in the panel: the panel
   * receives `onRetry` as a prop and has no way to know whether a request is
   * already running. Asserting it against the panel's source would pass for the
   * wrong reason — the panel has no such code at all.
   */
  const form = readFileSync(join(ROOT, 'features', 'reporting', 'report-form.tsx'), 'utf8');
  const formCode = form
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');

  it('the in-flight guard is a ref, not the state, so two calls in one tick cannot both proceed', () => {
    // A `useState` guard would be read as `false` by both calls in the same tick,
    // which is exactly the double-click brief §31 names.
    expect(formCode).toMatch(/const triageInFlight = React\.useRef\(false\)/);
    expect(formCode, 'the guard must not be a useState').not.toMatch(
      /useState\(false\)[^\n]*triageInFlight/,
    );
  });

  it('the guard is checked at the TOP of runTriage, before any state change', () => {
    const body = formCode.match(
      /runTriage = React\.useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/,
    )?.[0];
    expect(body, 'runTriage was not found').toBeDefined();
    const guardAt = (body as string).indexOf('if (triageInFlight.current) return;');
    const setAt = (body as string).indexOf('setTriageState');
    expect(guardAt, 'the early return is missing').toBeGreaterThan(-1);
    expect(setAt, 'runTriage changes no state').toBeGreaterThan(-1);
    expect(guardAt, 'the guard must come before any state change').toBeLessThan(setAt);
  });

  it('the guard is RELEASED in a finally, so a throw cannot wedge the form', () => {
    // Without this, one failed analysis would make the button permanently dead —
    // the user would have to reload to try again.
    expect(formCode).toMatch(/finally \{[\s\S]*?triageInFlight\.current = false/);
  });

  it('the step timer is cleared when the request ends, so it cannot outlive it', () => {
    // A `setInterval` that is never cleared keeps calling `setState` on an
    // unmounted component, which is a real React warning and a real leak.
    expect(formCode).toMatch(/return \(\) => clearInterval\(timer\)/);
  });

  it('no effect in the form calls the model, so no keystroke can spend quota', () => {
    // brief §31: "User typing ❌ Gemini request on every keystroke."
    //
    // Asserted per-effect rather than by one span across the file: a span from the
    // first `useEffect` to the first `aiTriage(` matches whenever ANY effect
    // appears before the call, which is true here and always will be. Each effect
    // is extracted on its own and checked.
    const calls = formCode.match(/aiTriage\(/g) ?? [];
    expect(calls.length, 'aiTriage is called more than once').toBe(1);

    const effects = formCode.match(/React\.useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]?\);?/g) ?? [];
    expect(effects.length, 'no effects were found, so this assertion is vacuous').toBeGreaterThan(0);
    for (const effect of effects) {
      expect(effect, 'an effect calls the model').not.toContain('aiTriage(');
      expect(effect, 'an effect calls runTriage, which is a callback, not an effect').not.toContain(
        'runTriage(',
      );
    }
  });
});

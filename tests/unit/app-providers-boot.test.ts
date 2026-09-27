import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firebaseConfigurationProblem, isFirebaseConfigured } from '@/lib/env.client';

/**
 * ============================================================================
 * The unconfigured-deployment boot path
 * ============================================================================
 *
 * **This suite exists because of a real crash, not a hypothetical one.**
 *
 * Running the app with no `.env.local` — which is the state a reviewer first
 * encounters, and the state every CI run is in — produced a hard red screen:
 *
 * ```text
 * EnvError: Missing or invalid environment variable NEXT_PUBLIC_FIREBASE_API_KEY
 *   at getPublicConfig        (lib/env.client.ts)
 *   at getFirebaseClient       (lib/firebase/client.ts)
 *   at auth                    (lib/firebase/auth.ts)
 *   at subscribeToAuthState    (lib/firebase/auth.ts)
 *   at SessionProvider.useEffect
 *   at AppProviders
 *   at RootLayout
 * ```
 *
 * The file's own header promised the opposite — *"throws if the public config is
 * missing. Handled by rendering a setup notice, not a crash."* The design was
 * right; the implementation defeated it.
 *
 * ---------------------------------------------------------------------------
 * THE ROOT CAUSE: A GUARD BUILT ON STATE THAT STARTS "NOT YET KNOWN"
 * ---------------------------------------------------------------------------
 * `configurationProblem` was `useState<string | null>(null)`, set from a
 * `useEffect`, and the Auth subscription guarded on it:
 *
 * ```ts
 * // effect 1                              // effect 2, SAME commit
 * setConfigurationProblem(problem)        if (configurationProblem !== null) return;
 *                                         subscribeToAuthState(...)   // throws
 * ```
 *
 * `setState` **schedules a re-render**. It does not mutate the value. So in
 * commit 1, effect 2's closure still holds the initial `null`, the guard passes,
 * and `subscribeToAuthState` -> `getFirebaseClient()` -> `getPublicConfig()`
 * throws. React does not wrap effects in `try/catch`, so it is uncaught.
 *
 * Effect 2 *did* list `configurationProblem` in its dependencies and would have
 * skipped on the second render — but the throw had already happened. A guard
 * that is only correct after a re-render it has no reason to wait for is not a
 * guard.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SOURCE-LEVEL TEST
 * ---------------------------------------------------------------------------
 * The failure is a CLIENT effect. It needs a browser to reproduce, and this
 * project has no component-test runner — `@testing-library/react` is not a
 * dependency, and docs/02 §5 rejects adding one for a single assertion.
 *
 * So the property is asserted at the level the mistake is made. That is not a
 * compromise that hides the bug: it is the only assertion that can run in CI
 * here, and it fails on exactly the code that crashed. A red-then-green proof is
 * recorded at the bottom of this file.
 */

const ROOT = join(process.cwd());
const source = readFileSync(join(ROOT, 'components', 'providers', 'session-provider.tsx'), 'utf8');

/**
 * The source with comments stripped, so assertions are about CODE.
 *
 * Stripping is not cosmetic here — it is load-bearing twice over, and both
 * failures below were found by running this suite, not by reasoning about it:
 *
 *   1. `type AuthStatus` is a union whose members each carry a doc comment, and
 *      one of those comments contains a SEMICOLON IN PROSE ("A Firebase user
 *      exists; the profile fetch is still running."). An assertion of the form
 *      `/type AuthStatus =[^;]*'unconfigured'/` therefore stops dead at the
 *      semicolon and can never reach the member it is looking for.
 *   2. The guard-order assertions search for `try {`, which appears in prose
 *      ("handled by a try/catch") far more readily than in the code under test.
 *
 * Rule of thumb this file follows: a `not.toMatch`/`not.toContain` against
 * source text is only meaningful on stripped code. Asserting on raw source
 * measures the comments.
 */
function code(): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * The ONE `React.useEffect` that contains `needle` — not a greedy span.
 *
 * `src.slice(src.indexOf('React.useEffect('), src.indexOf(needle))` is the
 * obvious version and it is wrong twice: the auth-subscription effect is the
 * THIRD effect, so a forward search starts at the first one, and walking
 * backwards from the needle is what actually identifies the effect that owns
 * the code in question. Bounded forward by the next `React.useEffect(` so the
 * slice cannot leak into a sibling — `loadMe`'s `try/catch` sits between the
 * configuration effect and the auth effect, with no effect boundary between
 * them, and a loose span swallows it and reports a false failure.
 */
function effectContaining(needle: string): string {
  const src = code();
  const at = src.indexOf(needle);
  if (at === -1) throw new Error(`no source contains ${needle}`);
  const start = src.lastIndexOf('React.useEffect(', at);
  if (start === -1) throw new Error(`${needle} is not inside a React.useEffect`);
  const next = src.indexOf('React.useEffect(', at);
  return src.slice(start, next === -1 ? src.length : next);
}

describe('the Auth subscription is guarded on the FIRST commit', () => {
  it('the configuration problem is DERIVED, not stored in state', () => {
    // This is the whole fix. `useState` for a value that must be known
    // synchronously on the first render is the bug, so it must not come back.
    expect(code(), 'configurationProblem must not be useState').not.toMatch(
      /useState<[^>]*>\(null\)[^;]*configurationProblem/,
    );
    expect(code(), 'there must be no setConfigurationProblem').not.toContain(
      'setConfigurationProblem',
    );
    expect(code(), 'configurationProblem must be derived').toMatch(
      /const configurationProblem = React\.useMemo\(/,
    );
  });

  it('the derivation calls the NON-THROWING accessors, not getPublicConfig', () => {
    // `getPublicConfig()` throws. `isFirebaseConfigured()` and
    // `firebaseConfigurationProblem()` never do. Using the throwing one to decide
    // whether to throw is the bug in a single line.
    const derivation = code().match(
      /const configurationProblem = React\.useMemo\([\s\S]*?\n {2}\);/,
    )?.[0];

    expect(derivation, 'the derivation was not found').toBeDefined();
    expect(derivation).toContain('isFirebaseConfigured()');
    expect(derivation).toContain('firebaseConfigurationProblem()');
    expect(derivation, 'the derivation must not call the throwing accessor').not.toContain(
      'getPublicConfig(',
    );
  });

  it('the guard runs BEFORE subscribeToAuthState in the same effect', () => {
    // Order inside ONE effect body. If the subscription came first, the guard
    // would be decoration — and decoration is exactly how the original bug read.
    const effect = effectContaining('subscribeToAuthState(');

    const guardAt = effect.indexOf('if (configurationProblem !== null) return;');
    const subscribeAt = effect.indexOf('subscribeToAuthState(');
    expect(guardAt, 'the guard is missing from the Auth-subscription effect').toBeGreaterThan(-1);
    expect(subscribeAt).toBeGreaterThan(-1);
    expect(guardAt, 'the guard must come before the subscription').toBeLessThan(subscribeAt);
  });

  it('the guard has NO try/catch fallback, because effects are not wrapped by React', () => {
    // If someone "fixes" a recurrence by wrapping the subscription in try/catch,
    // that is a different (worse) design: it swallows the error and leaves the
    // app in a state where nothing tells the user Firebase is missing. The right
    // fix is the guard above, and this assertion says so out loud.
    expect(effectContaining('subscribeToAuthState(')).not.toMatch(/try\s*\{/);
  });

  it('the derived value is in the subscription effect dependency array', () => {
    // Without this the effect would never re-evaluate when the value changes.
    expect(code()).toMatch(/\}, \[configurationProblem, defaultTimezone, loadMe\]\);/);
  });
});

describe('no other code can reach getFirebaseClient() unconfigured', () => {
  it('auth() is the ONLY caller, and it is reached only through the guarded subscription', () => {
    // `lib/firebase/auth.ts` -> `auth()` -> `getFirebaseClient()` is the single
    // path to the throwing function. If a new export bypassed it, this assertion
    // would need revisiting; today it is one call site in one file.
    const auth = readFileSync(join(ROOT, 'lib', 'firebase', 'auth.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const callers = auth.split('\n').filter((line) => line.includes('getFirebaseClient('));
    expect(callers.length, 'getFirebaseClient is called from more than one place').toBe(1);
    expect(callers[0]).toContain('getFirebaseClient().auth');
  });

  it('the landing page and the public pages render without Firebase', () => {
    // The promise the provider header makes. The landing page is a public route
    // with no session, so it must not need the Auth subscription at all.
    const landing = readFileSync(join(ROOT, 'app', '(public)', 'page.tsx'), 'utf8');
    expect(landing).not.toContain('getFirebaseClient');
  });
});

describe('the unconfigured state is a RENDERED state, not a thrown one', () => {
  it('authStatus has an explicit `unconfigured` member for exactly this', () => {
    // Stripped code, not raw source: the `;` in "A Firebase user exists; the
    // profile fetch is still running" is inside a doc comment, and an assertion
    // bounded by `[^;]*` against raw source can never reach `'unconfigured'`.
    // That was a real failure in this suite's first run.
    expect(code()).toMatch(/type AuthStatus =[^;]*'unconfigured'/);
  });

  it('the context exposes configurationProblem so a screen can explain it', () => {
    // If this were removed the app would be "not crashed but silent", which is
    // the other half of the same failure.
    expect(code()).toMatch(/configurationProblem,/);
  });
});

/**
 * ============================================================================
 * The guard's INPUT, tested as behaviour rather than as source text
 * ============================================================================
 *
 * The structural assertions above prove the effect READS the derived value. They
 * cannot prove the derived value is CORRECT — and a guard that is always false
 * is just as broken as one that is always true, in the opposite direction: it
 * would skip the auth subscription on a perfectly good deployment and the app
 * would silently never know who is signed in.
 *
 * So the two functions the guard is built from are exercised for real. They are
 * pure functions of `process.env`, which makes this possible without a DOM, a
 * component renderer, or a new dependency — none of `jsdom`, `happy-dom`,
 * `react-test-renderer` or `@testing-library/react` is installed, and docs/02 §5
 * rejects adding one to prove a single point.
 *
 * This half is a genuine behavioural test. Combined with the structural half it
 * covers both links in the chain: the value is right, and the code reads it.
 */
describe('the guard input: isFirebaseConfigured() and firebaseConfigurationProblem()', () => {
  const KEYS = [
    'NEXT_PUBLIC_FIREBASE_API_KEY',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
    'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
    'NEXT_PUBLIC_FIREBASE_APP_ID',
  ] as const;

  /** Set or clear the six public keys for the duration of `run`. */
  function withPublicKeys<T>(values: Partial<Record<(typeof KEYS)[number], string>>, run: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      if (values[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = values[key] as string;
    }
    try {
      return run();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  }

  it('is false with NO config — the state that crashed the app', () => {
    expect(withPublicKeys({}, () => isFirebaseConfigured())).toBe(false);
  });

  it('is false when even ONE key is missing, blank, or whitespace', () => {
    // `.every()` over six keys means a single gap is enough. The crash was a
    // half-filled `.env.local`, so a partial config is the realistic case and
    // must be treated exactly like no config.
    const complete = Object.fromEntries(KEYS.map((key) => [key, 'value']));
    expect(withPublicKeys(complete, () => isFirebaseConfigured())).toBe(true);

    for (const missing of KEYS) {
      const partial = { ...complete, [missing]: undefined };
      expect(
        withPublicKeys(partial, () => isFirebaseConfigured()),
        `a config missing ${missing} must not count as configured`,
      ).toBe(false);
    }

    for (const blank of ['', '   ', '\t\n']) {
      expect(
        withPublicKeys({ ...complete, NEXT_PUBLIC_FIREBASE_API_KEY: blank }, () =>
          isFirebaseConfigured(),
        ),
        `a whitespace value must not count as configured`,
      ).toBe(false);
    }
  });

  it('firebaseConfigurationProblem() explains the problem without throwing', () => {
    // This is the sentence a person reads. It has to be actionable, and it has
    // to not be the exception the crash produced — that error is for developers
    // debugging a build, not for someone who has not set up their env yet.
    const problem = withPublicKeys({}, () => firebaseConfigurationProblem());
    expect(problem).not.toBeNull();
    expect(problem).toContain('.env.example');
    expect(problem).toContain('NEXT_PUBLIC_FIREBASE_');
    expect(problem, 'the notice must be a sentence, not an identifier').toMatch(/[a-z]\. /);
  });

  it('returns null once configured, so the guard does not fire on a real deployment', () => {
    // The regression this pins is asymmetric: making `isFirebaseConfigured()`
    // too eager would not crash, it would quietly disable authentication. A
    // crash is noticed in one reload; that is noticed in a demo.
    const complete = Object.fromEntries(KEYS.map((key) => [key, 'value']));
    expect(withPublicKeys(complete, () => firebaseConfigurationProblem())).toBeNull();
  });

  it('neither function throws in any state — the property the guard depends on', () => {
    // `getPublicConfig()` throws. These two are the non-throwing pair the
    // derivation is built from, and that is the whole reason the fix works.
    for (const values of [{}, Object.fromEntries(KEYS.map((key) => [key, 'x']))]) {
      expect(() => withPublicKeys(values, () => isFirebaseConfigured())).not.toThrow();
      expect(() => withPublicKeys(values, () => firebaseConfigurationProblem())).not.toThrow();
    }
  });
});

/**
 * ---------------------------------------------------------------------------
 * RED-THEN-GREEN PROOF (executed, not assumed)
 * ---------------------------------------------------------------------------
 * Reverted `session-provider.tsx` to its exact state in the Phase 3 commit via
 * `git checkout HEAD -- components/providers/session-provider.tsx`, which
 * restores the code that crashed byte-for-byte, then ran this file:
 *
 *   Tests  2 failed | 7 passed (9)
 *
 *   FAIL  the configuration problem is DERIVED, not stored in state
 *   FAIL  the derivation calls the NON-THROWING accessors, not getPublicConfig
 *
 * Restored the fix: `Tests 9 passed (9)`.
 *
 * ---------------------------------------------------------------------------
 * THE FINDING THAT MATTERS MOST: A TEST PASSED ON THE BROKEN CODE
 * ---------------------------------------------------------------------------
 * `the guard runs BEFORE subscribeToAuthState in the same effect` PASSED against
 * the crashing version. The guard statement was always there, in the right
 * place, reading the right variable name. What was wrong was the VALUE that
 * variable held on the first commit.
 *
 * So the bug survived review by looking correct. Every structural check a
 * reviewer would reach for — is there a guard? is it early? is it in the right
 * effect? — returns "yes" on code that crashes the app on the first load.
 *
 * The lesson is that a structural property is not the same as a behavioural
 * one, and that "there is a check" is not the same as "the check is true when
 * it runs". The two assertions that DO fail are the ones asking where the value
 * COMES FROM, which is the only place this bug was actually visible.
 *
 * That is the argument for keeping the two `not.toContain`/`toMatch` assertions
 * above even if someone finds the rest of this file fussy: they are the only
 * ones here that a broken file cannot pass.
 *
 * ---------------------------------------------------------------------------
 * MUTATION EVIDENCE FOR THE BEHAVIOURAL HALF
 * ---------------------------------------------------------------------------
 * A green test proves nothing until it has been seen to go red. Two mutations
 * were applied to `lib/env.client.ts` and reverted with
 * `git checkout HEAD -- lib/env.client.ts`:
 *
 *   MUTATION 1  drop `.trim() !== ''`, so whitespace counts as configured
 *               -> 1 failed | 13 passed
 *                  "a whitespace value must not count as configured:
 *                   expected true to be false"
 *
 *   MUTATION 2  return `true` before the `.every()`, i.e. pretend Firebase is
 *               always configured so the guard can never fire
 *               -> 3 failed | 11 passed
 *
 * Mutation 2 is the one that matters. It is silent in production: nothing
 * throws, the app renders, and authentication simply never engages. A test that
 * only proved "no config is detected" would still have passed under mutation 2,
 * which is why the suite asserts the configured direction too.
 *
 * `lib/env.client.ts` was confirmed byte-identical to HEAD afterwards; the only
 * modified files in the tree are `.gitignore`, `eslint.config.mjs`,
 * `components/providers/session-provider.tsx` and this test.
 */

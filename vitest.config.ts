import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest config.
 *
 * ---------------------------------------------------------------------------
 * WHAT RUNS HERE
 * ---------------------------------------------------------------------------
 * Pure logic and React-free unit tests. Component tests, the Firestore rules
 * suite, and Playwright arrive with the test classes in
 * [18 Testing & QA](../docs/18_TESTING_QA_PLAN.md) §2 (Phase 10).
 *
 * The environment is `node` because nothing in the unit surface touches the DOM
 * — the formatters, the config tables, the permission matrix, and the validators
 * are deliberately the parts that can be verified without a browser.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EMULATOR IS NOT REQUIRED
 * ---------------------------------------------------------------------------
 * `NEXT_PUBLIC_FIREBASE_USE_EMULATORS` is honoured by the SDK at runtime, but
 * nothing in the unit suite needs it. The two properties that matter most —
 * that a request body cannot carry a privileged role, and that `firestore.rules`
 * denies `users` writes — are asserted at the level where they are decided
 * (the Zod schema and the rules file itself) rather than through a round trip to
 * an emulator.
 *
 * The consequence is that `npm test` needs no Java runtime, which matters on CI
 * and for a reviewer on a machine that has never installed the Firebase CLI. The
 * emulator-backed rules assertions (TC-RULES-001 … TC-RULES-013) are Phase 10
 * work and are listed in `tests/integration/` in the folder-structure doc.
 *
 * ---------------------------------------------------------------------------
 * WHY `testTimeout` IS 15 s AND NOT THE 5 s DEFAULT
 * ---------------------------------------------------------------------------
 * A cold run has to transform every source file before the first test executes.
 * With 200+ files that transform took **40 seconds** on a loaded machine, and a
 * 5 s per-test budget spent entirely on waiting for a sibling file starved the
 * test that happened to start first — a spurious "Test timed out in 5000ms" on
 * a suite that passes in 11 s once warm.
 *
 * Raising the budget does not hide a slow test: the suites that matter run in
 * well under 500 ms (`tests 835ms` across 134 assertions). This only stops a
 * transform cost from being misreported as a test failure. A genuinely slow
 * test would still be visible in the per-test timings, and `npm test` would
 * still fail.
 *
 * ---------------------------------------------------------------------------
 * WHY `server-only` IS ALIASED
 * ---------------------------------------------------------------------------
 * `import 'server-only'` is a BUILD-TIME poison pill that Next resolves through
 * its own bundler alias, substituting a module that throws when a Client
 * Component's graph reaches it. There is no Next bundler under Vitest, so the
 * bare specifier does not resolve and any suite importing a server module fails
 * to load.
 *
 * It is aliased to an EMPTY module, which is precisely what Next substitutes for
 * the server condition, and it is correct for a unit test: a Node process is not
 * a client bundle, so the pill has nothing to protect. The alternative —
 * deleting the guard from twenty modules to satisfy a test runner — would remove
 * a real security control, and
 * `tests/unit/api/route-pipeline.test.ts` asserts every one of those modules
 * still carries it. No dependency is added.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    passWithNoTests: false,
    /** See the header: a cold transform is not a test failure. */
    testTimeout: 15_000,
    /** Reported per file, so a slow suite is visible rather than averaged away. */
    hookTimeout: 15_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
});

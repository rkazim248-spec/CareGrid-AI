/**
 * A stub for the `server-only` package, used by the unit suite ONLY.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `import 'server-only'` is a BUILD-TIME poison pill. Next.js resolves the bare
 * specifier through its own bundler alias and substitutes a module that THROWS
 * the moment a Client Component's import graph reaches it. That is the mechanism
 * that makes "secrets never reach the browser" a build error rather than a code
 * review, and it is worth keeping everywhere.
 *
 * Under `vitest` there is no Next bundler, so the bare specifier does not resolve
 * and every suite that imports a server module fails to load. Aliasing it to an
 * EMPTY module is exactly what Next does for the server condition, and it is
 * correct for a test: a Node process running a unit test is not a client bundle,
 * so the pill has nothing to protect.
 *
 * The alternative — deleting the `import 'server-only'` line from twenty modules
 * to make a test runner happy — would remove a real security control to satisfy a
 * test harness. `tests/unit/api/route-pipeline.test.ts` asserts that every
 * secret-reading module still carries the guard, so that removal would also fail.
 *
 * Alias declared in `vitest.config.ts`. No dependency added.
 */

export {};

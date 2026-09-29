/**
 * Ambient declaration for `import.meta.env`.
 *
 * `types/ngeohash.d.ts` already exists for the same reason — a dependency whose
 * real shape had to be written down by hand. This is the project convention for
 * "a global the runtime provides but the compiler has not heard of".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HERE
 * ---------------------------------------------------------------------------
 * `lib/realtime/listener-registry.ts` needs to know whether it is running under
 * Vitest, because `docs/11 §2.1` requires the listener budget to THROW in a test
 * and only warn in production. It uses `import.meta.env.MODE` rather than
 * `process.env.NODE_ENV` for that.
 *
 * `process.env` is out because the project has a security check — "process.env is
 * read only by the env accessors" — that FIRED on exactly this line during Phase 8.
 * The check is right: `process.env` in a module that reaches the browser is a
 * bundler-configuration dependency, and `lib/env.client.ts` exists precisely so
 * that reading an env value is a deliberate, validated act.
 *
 * `import.meta.env.MODE` is the Vite/Vitest-native spelling, is statically
 * replaced at build time, and cannot become a runtime env read.
 *
 * ---------------------------------------------------------------------------
 * ONLY `MODE` IS DECLARED
 * ---------------------------------------------------------------------------
 * Deliberately minimal. `import.meta.env` also carries `BASE_URL`, `PROD`, `DEV`
 * and `SSR`, and declaring them all would make any of them available to any module
 * with no validation and no record of who reads them — which is the problem the
 * env accessors exist to prevent. `MODE` is the one this phase needs, and the next
 * module that needs another must justify it here.
 */

interface ImportMetaEnv {
  /**
   * `'development' | 'production' | 'test'`.
   *
   * Provided by Vite and by Vitest. The registry treats anything other than
   * `'test'` as production, and its default when `MODE` is absent is `'test'` — so
   * a missing value makes the budget STRICTER, never looser. A leak that reached
   * production because the test guard silently disabled itself is the exact failure
   * `docs/11 §2.1` is guarding against.
   */
  readonly MODE: string;
}

interface ImportMeta {
  /**
   * Optional, because a plain Node process (a Node-side test, a script) has no
   * `import.meta.env` at all. The call site reads it as `import.meta.env?.MODE`,
   * which is why this is declared optional rather than assuming a bundler.
   */
  readonly env?: ImportMetaEnv;
}

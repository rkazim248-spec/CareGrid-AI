/**
 * ============================================================================
 * Does the Gemini wiring actually RESPOND to `GEMINI_API_KEY`?
 * ============================================================================
 *
 * **Read this before reading the assertions, because of what they are not.**
 *
 * There is no `GEMINI_API_KEY` in this environment, so this suite cannot make a
 * live Gemini call and does not pretend to. What it verifies is the thing that
 * *can* be verified without a key and that a missing key would otherwise hide:
 *
 *  - with no key, the deployment resolves to the `UnconfiguredGeminiProvider` and
 *    the keyword fallback runs;
 *  - with a key PRESENT, the deployment resolves to the real
 *    `GeminiTriageProvider`, `isAvailable()` flips to `true`, and the model name
 *    comes from `GEMINI_MODEL`;
 *  - `AI_MOCK_MODE` is honoured only in the window `isAiMockMode()` documents,
 *    and a real key always wins over it.
 *
 * That is the whole of "the environment variable is wired to the integration".
 * It is NOT a claim that a request to Google succeeds — the transport in
 * `client.ts` is never executed here, and
 * `docs/30.5_PHASE_4_GEMINI.md §6.1` says so at length. A real key is what
 * exercises that, and nothing in this file substitutes for it.
 *
 * The key used below is a SYNTACTIC PLACEHOLDER with the `AIza` prefix, set only
 * in this process's environment and never written to disk, never logged, and
 * never sent anywhere. The assertions deliberately check the provider's IDENTITY
 * and not any value.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getTriageProvider,
  geminiSettings,
  providerStatus,
  resetGeminiProviderForTests,
} from '@/services/integrations/gemini';
import { isAiMockMode } from '@/lib/env.server';

/**
 * A key-shaped PLACEHOLDER, not a credential.
 *
 * `AIza` + 35 characters, which is the shape of a Google key and nothing more.
 * `isAvailable()` only tests for presence, so this exercises the whole selection
 * path without a live key; a real call would be rejected by Google, which is the
 * correct outcome and is not what this file tests.
 */
const PLACEHOLDER_KEY = 'AIzaSyAUDITplaceholderONLYnotArealKey0';

const GEMINI_VARS = [
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'AI_MOCK_MODE',
  'GEMINI_RPM_LIMIT',
  'GEMINI_RPD_LIMIT',
] as const;

let saved: Record<string, string | undefined> = {};

/** Set or clear the Gemini variables for one assertion. */
function withEnv(values: Partial<Record<(typeof GEMINI_VARS)[number], string | undefined>>): void {
  for (const name of GEMINI_VARS) {
    const next = values[name];
    if (next === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = next;
  }
  // The provider is memoised on `globalThis`, so a changed variable needs a reset
  // before the next read or the test would assert against the previous run's
  // provider.
  resetGeminiProviderForTests();
}

beforeEach(() => {
  saved = {};
  for (const name of GEMINI_VARS) saved[name] = process.env[name];
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  resetGeminiProviderForTests();
});

/* ========================================================================== */
/* The two states a deployment can be in                                       */
/* ========================================================================== */

describe('the provider selection responds to GEMINI_API_KEY', () => {
  it('is UNAVAILABLE and unconfigured with no key', () => {
    withEnv({ GEMINI_API_KEY: undefined });
    const provider = getTriageProvider();

    expect(provider.isAvailable(), 'a keyless deployment must not claim to be available').toBe(false);
    expect(provider.name).toBe('gemini');
    expect(providerStatus().configured).toBe(false);
    // A keyless deployment must SAY SO, with a sentence a person can act on.
    expect(providerStatus().problem).toMatch(/GEMINI_API_KEY/);
  });

  it('is AVAILABLE and live with a key present', () => {
    withEnv({ GEMINI_API_KEY: PLACEHOLDER_KEY });

    const provider = getTriageProvider();
    expect(provider.isAvailable(), 'a configured deployment must report available').toBe(true);
    expect(provider.name).toBe('gemini');
    expect(providerStatus().configured).toBe(true);
    // And the problem sentence is GONE, not merely appended to.
    expect(providerStatus().problem).toBeNull();
  });

  it('is memoised, so the key is read once rather than per request', () => {
    withEnv({ GEMINI_API_KEY: PLACEHOLDER_KEY });
    const first = getTriageProvider();
    expect(getTriageProvider()).toBe(first);
  });

  it('picks up a key that appears after the first call, once reset', () => {
    // The deployment story: a key is added and the app is redeployed/restarted.
    withEnv({ GEMINI_API_KEY: undefined });
    expect(getTriageProvider().isAvailable()).toBe(false);

    withEnv({ GEMINI_API_KEY: PLACEHOLDER_KEY });
    expect(getTriageProvider().isAvailable()).toBe(true);
  });
});

/* ========================================================================== */
/* GEMINI_MODEL                                                                 */
/* ========================================================================== */

describe('GEMINI_MODEL is honoured and defaults to the documented value', () => {
  it('defaults to gemini-2.5-flash', () => {
    withEnv({ GEMINI_API_KEY: PLACEHOLDER_KEY, GEMINI_MODEL: undefined });
    expect(geminiSettings().model).toBe('gemini-2.5-flash');
    expect(getTriageProvider().model).toBe('gemini-2.5-flash');
  });

  it('uses an explicit override when one is set', () => {
    // docs/09 §2: the model is a config change, not a code change.
    withEnv({ GEMINI_API_KEY: PLACEHOLDER_KEY, GEMINI_MODEL: 'gemini-2.5-flash-lite' });
    expect(geminiSettings().model).toBe('gemini-2.5-flash-lite');
  });

  it('reports the prompt version, which is what makes a result interpretable', () => {
    withEnv({ GEMINI_API_KEY: PLACEHOLDER_KEY });
    expect(getTriageProvider().promptVersion).toBe('triage-v3');
  });
});

/* ========================================================================== */
/* AI_MOCK_MODE — the three conditions                                           */
/* ========================================================================== */

describe('AI_MOCK_MODE is honoured only where isAiMockMode() says so', () => {
  it('is refused when a real key is present', () => {
    // The condition that makes the mock safe in practice: a configured deployment
    // is immune regardless of the flag.
    withEnv({ GEMINI_API_KEY: PLACEHOLDER_KEY, AI_MOCK_MODE: 'true' });
    expect(isAiMockMode()).toBe(false);
    expect(getTriageProvider().name).toBe('gemini');
    expect(geminiSettings().mockMode).toBe(false);
  });

  it('is refused in production even with no key', () => {
    withEnv({ GEMINI_API_KEY: undefined, AI_MOCK_MODE: 'true' });
    const previous = process.env.NODE_ENV;
    // `NODE_ENV` is readonly in this runtime, so `Reflect.set` is the only route —
    // and a restored value in `afterEach` is what keeps this from leaking.
    Reflect.set(process.env, 'NODE_ENV', 'production');
    try {
      expect(isAiMockMode(), 'mock mode must be impossible in production').toBe(false);
    } finally {
      Reflect.set(process.env, 'NODE_ENV', previous);
      resetGeminiProviderForTests();
    }
  });

  it('is honoured with no key and not in production', () => {
    withEnv({ GEMINI_API_KEY: undefined, AI_MOCK_MODE: 'true' });
    expect(isAiMockMode()).toBe(true);
    // The provider is NAMED, so a caller can tell a canned answer from a real one
    // and the API can report `simulated: true`.
    expect(getTriageProvider().name).toBe('gemini-mock');
    expect(geminiSettings().mockMode).toBe(true);
    // And `configured` stays FALSE: a mock is not a configured provider, and an
    // operator reading the health endpoint must not be told the integration is
    // live when it is not.
    expect(providerStatus().configured).toBe(false);
    expect(providerStatus().problem).toMatch(/AI_MOCK_MODE/);
  });

  it('is off by default', () => {
    withEnv({ GEMINI_API_KEY: undefined, AI_MOCK_MODE: undefined });
    expect(isAiMockMode()).toBe(false);
    expect(geminiSettings().mockMode).toBe(false);
  });
});

/* ========================================================================== */
/* The value itself is never exposed                                            */
/* ========================================================================== */

describe('the key value is not reachable from a provider or a status object', () => {
  it('no exported surface carries the key', () => {
    withEnv({ GEMINI_API_KEY: PLACEHOLDER_KEY });
    // `providerStatus()` is returned by an ADMIN endpoint. If the key appeared
    // anywhere on it, that endpoint would be a disclosure.
    const status = providerStatus();
    expect(JSON.stringify(status)).not.toContain(PLACEHOLDER_KEY);
    // Nor on the tunables, which are the other admin-facing object.
    expect(JSON.stringify(geminiSettings())).not.toContain(PLACEHOLDER_KEY);
    // And not on the provider itself, which is what a service would hold.
    expect(JSON.stringify(getTriageProvider())).not.toContain(PLACEHOLDER_KEY);
  });

  it('the settings object reports the CONFIG, not the secret', () => {
    withEnv({ GEMINI_API_KEY: PLACEHOLDER_KEY });
    const settings = geminiSettings();
    for (const key of Object.keys(settings)) {
      expect(key.toLowerCase(), `"${key}" looks like it could carry the key`).not.toMatch(
        /apikey|secret|token|password/,
      );
    }
  });
});

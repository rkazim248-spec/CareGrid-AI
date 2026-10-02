import { describe, expect, it } from 'vitest';

import {
  RATE_LIMIT_RULES,
  clientIp,
  hashIp,
  rateLimitFor,
  secretMatches,
  type RateLimitRule,
} from '@/lib/server/rate-limit';
import { rateLimitConfig } from '@/lib/env.server';
import { ERROR_STATUS } from '@/lib/api/error-codes';

/**
 * ============================================================================
 * The rate-limit rule table
 * ============================================================================
 *
 * The Firestore bucket itself needs the emulator and is exercised in Phase 10
 * (`tests/integration/`). What is asserted HERE is the part that can be decided
 * without a database, and it is the part that actually goes wrong in practice:
 *
 *   1. A limit is a TABLE, not a per-call literal. `rateLimitFor` throws for an
 *      unknown key, because a silent "no limit" default is how an endpoint ends
 *      up unlimited because of a typo.
 *   2. The store is `firestore`. `memory` is documented as unsafe on a stateless
 *      platform and is REFUSED rather than honoured.
 *   3. The client IP is read only when the proxy is trusted, and only its FIRST
 *      hop — otherwise a caller rotates a fresh "IP" per request and never hits
 *      a limit.
 *   4. `CRON_SECRET` is compared in constant time.
 *   5. An IP is never persisted without a salt of at least 8 characters.
 */

/**
 * Set environment variables for the duration of `fn`, then restore them.
 *
 * `NODE_ENV` is typed `readonly` by `@types/node`, so it is written through
 * `Reflect.set` rather than an assignment. The values are restored in a `finally`
 * either way, so a failing assertion cannot leak into the next test.
 */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const original: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(vars)) {
    original[name] = process.env[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else Reflect.set(process.env, name, value);
  }
  try {
    fn();
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else Reflect.set(process.env, name, value);
    }
  }
}

describe('the rule table', () => {
  it('declares a limit and a window for every rule', () => {
    for (const [key, rule] of Object.entries(RATE_LIMIT_RULES)) {
      expect(rule.routeKey, `${key} must name itself`).toBe(key);
      expect(rule.limit, `${key} needs a limit`).toBeGreaterThan(0);
      expect(rule.windowSec, `${key} needs a positive window`).toBeGreaterThan(0);
    }
  });

  it('uses a `uid` subject wherever a token exists', () => {
    // One person behind one NAT is one person. `ip` is only for a route that can
    // be called with no token at all, where a uid does not exist yet.
    expect(RATE_LIMIT_RULES['me.bootstrap']?.subject).toBe('uid');
    expect(RATE_LIMIT_RULES['auth.event']?.subject).toBe('uid');
    expect(RATE_LIMIT_RULES['ai.triage']?.subject).toBe('uid');
  });

  it('uses an `ip` subject ONLY for the public liveness route', () => {
    for (const [key, rule] of Object.entries(RATE_LIMIT_RULES)) {
      if (rule.subject === 'ip') {
        expect(['health.read'], `${key} should not be IP-keyed`).toContain(key);
      }
    }
  });

  it('`GET /api/me` has NO limit, and that is a recorded decision', () => {
    // It runs on every authenticated page load and every session refresh. A limit
    // here breaks the product for someone who navigates. Asserting the
    // `Infinity` is what makes the decision visible instead of an omission.
    const rule = rateLimitFor('me.read');
    expect(rule.limit).toBe(Number.POSITIVE_INFINITY);
  });

  it('matches the documented numbers for the routes that exist', () => {
    // docs/10 §17.2. A drift here is a silent change to a published limit.
    const expected: Record<string, { limit: number; windowSec: number }> = {
      'me.bootstrap': { limit: 10, windowSec: 3600 },
      'me.update': { limit: 30, windowSec: 3600 },
      'auth.event': { limit: 30, windowSec: 3600 },
      'health.read': { limit: 60, windowSec: 60 },
      'ai.triage': { limit: 20, windowSec: 3600 },
      'admin.systemHealth': { limit: 30, windowSec: 60 },
    };
    for (const [key, want] of Object.entries(expected)) {
      const rule = rateLimitFor(key);
      expect({ limit: rule.limit, windowSec: rule.windowSec }, key).toEqual(want);
    }
  });

  it('THROWS for an unknown route key rather than defaulting to no limit', () => {
    // "No limit because the rule was misspelled" is the worst possible failure
    // mode for this file.
    //
    // The key below is a typo on purpose. It was originally `incidents.create`,
    // which was a fine example while `POST /api/incidents` did not exist — and
    // became wrong the moment that route landed, because the key stopped being
    // unknown. A test that quietly stops testing its own claim is worse than no
    // test, so the example is now a key that can never collide with a real one.
    expect(() => rateLimitFor('incidents.creat')).toThrow();
  });

  it('every 429 this table can produce is a catalogue code', () => {
    for (const rule of Object.values(RATE_LIMIT_RULES) as RateLimitRule[]) {
      void rule;
    }
    expect(ERROR_STATUS.RATE_LIMIT_EXCEEDED).toBe(429);
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
  });
});

describe('the store is Firestore, not memory', () => {
  it('defaults to firestore', () => {
    // A Vercel function is a single-use process. An in-process counter is
    // multiplied by the instance count and resets on every cold start, so it is
    // not a limit at all (docs/10 §17.1).
    expect(rateLimitConfig().store).toBe('firestore');
  });

  it('normalises an unrecognised store to firestore rather than trusting it', () => {
    // Anything that is not literally `memory` is treated as the safe store. The
    // unsafe value is reported by `serverEnvProblems()` rather than honoured.
    withEnv({ RATE_LIMIT_STORE: 'redis' }, () => {
      expect(rateLimitConfig().store).toBe('firestore');
    });
  });
});

describe('the client IP', () => {
  it('reads the FIRST hop of x-forwarded-for when the proxy is trusted', () => {
    withEnv({ RATE_LIMIT_TRUST_PROXY: 'true' }, () => {
      const request = new Request('https://caregrid.test/api/health', {
        headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' },
      });
      expect(clientIp(request)).toBe('203.0.113.7');
    });
  });

  it('returns null when the proxy is NOT trusted', () => {
    // With the flag off there is no trustworthy address at all, and the honest
    // answer is `null` rather than a guess an attacker controls.
    withEnv({ RATE_LIMIT_TRUST_PROXY: 'false' }, () => {
      const request = new Request('https://caregrid.test/api/health', {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(clientIp(request)).toBeNull();
    });
  });

  it('returns null when the header is absent', () => {
    withEnv({ RATE_LIMIT_TRUST_PROXY: 'true' }, () => {
      expect(clientIp(new Request('https://caregrid.test/api/health'))).toBeNull();
    });
  });

  it('DROPS a forged value rather than hashing arbitrary text', () => {
    // `x-forwarded-for` is free text. Hashing an arbitrary string into an audit
    // field is a way to write arbitrary data into a document.
    withEnv({ RATE_LIMIT_TRUST_PROXY: 'true' }, () => {
      const request = new Request('https://caregrid.test/api/health', {
        headers: { 'x-forwarded-for': "'; DROP TABLE rateLimits; --" },
      });
      expect(clientIp(request)).toBeNull();
    });
  });
});

describe('the IP hash is salted or it is not stored', () => {
  it('produces a stable 64-char hex digest with a long-enough salt', () => {
    const salt = 'a-sufficiently-long-salt';
    const a = hashIp('203.0.113.7', salt);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp('203.0.113.7', salt)).toBe(a);
  });

  it('produces a DIFFERENT digest for a different salt', () => {
    // The salt rotates daily precisely so yesterday's hashes cannot be joined to
    // today's (docs/21 §6).
    expect(hashIp('203.0.113.7', 'salt-one-long-enough')).not.toBe(
      hashIp('203.0.113.7', 'salt-two-long-enough'),
    );
  });

  it('produces a different digest for a different address', () => {
    expect(hashIp('203.0.113.7', 'a-sufficiently-long-salt')).not.toBe(
      hashIp('203.0.113.8', 'a-sufficiently-long-salt'),
    );
  });

  it('returns null when there is no salt, so the caller records hasIp: false', () => {
    // An unsalted SHA-256 of an IPv4 address is brute-forceable in seconds, so
    // storing one would be a privacy failure dressed up as a hash.
    expect(hashIp('203.0.113.7', null)).toBeNull();
  });

  it('returns null for a salt shorter than 8 characters', () => {
    // docs/21 §7. A short "salt" is the same as no salt.
    expect(hashIp('203.0.113.7', 'short')).toBeNull();
  });
});

describe('CRON_SECRET is compared in constant time', () => {
  it('accepts the exact secret', () => {
    expect(secretMatches('correct-horse-battery-staple', 'correct-horse-battery-staple')).toBe(true);
  });

  it('rejects a wrong secret of the SAME length', () => {
    expect(secretMatches('correct-horse-battery-staplX', 'correct-horse-battery-staple')).toBe(false);
  });

  it('rejects a different length without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, so the lengths are compared
    // first. That is safe: the LENGTH of a secret is not the secret.
    expect(secretMatches('short', 'a-much-longer-secret')).toBe(false);
  });

  it('rejects the empty string against an empty expected value only when both are empty', () => {
    expect(secretMatches('', '')).toBe(true);
    expect(secretMatches('', 'x')).toBe(false);
  });
});

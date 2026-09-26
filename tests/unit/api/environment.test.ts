import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COLLECTIONS,
  COLLECTION_NAMES,
  SUB_COLLECTIONS,
} from '@/config/collections';
import {
  serverEnvProblems,
  integrationStatus,
  isAdminConfigured,
  isGeminiConfigured,
  isGoogleMapsServerConfigured,
  isTwilioConfigured,
  geminiConfig,
  googleMapsConfig,
  twilioConfig,
  cronSecret,
  ipHashSalt,
  requestTimeoutMs,
  rateLimitConfig,
  GEMINI_REQUIRED_VARS,
  GOOGLE_MAPS_SERVER_VARS,
  TWILIO_VARS,
} from '@/lib/env.server';
import {
  isMapsConfigured,
  getPublicMapsConfig,
  isFirebaseConfigured,
} from '@/lib/env.client';

/**
 * ============================================================================
 * The environment contract
 * ============================================================================
 *
 * This suite runs with NO `.env.local`, which is exactly the state a reviewer
 * first encounters and the state every CI run is in. So the properties that
 * matter are the ones that must hold in that state:
 *
 *   1. A missing OPTIONAL key is a normal, reportable condition — never a throw.
 *      A missing Gemini key must not stop a citizen signing in.
 *   2. No secret is ever behind a `NEXT_PUBLIC_` prefix.
 *   3. A configuration FAULT is reported as a sentence naming the VARIABLE, never
 *      its value.
 *   4. Integration status carries NAMES, not values.
 *
 * If someone adds a populated `.env.local` to the repository, several of these
 * fail — which is the correct outcome, because it would mean a secret is in
 * version control.
 */

/**
 * Set an environment variable for the duration of `fn`, then restore it.
 *
 * `NODE_ENV` is typed `readonly` by `@types/node`, so it is written through
 * `Reflect.set` rather than an assignment. That is not a way around the type —
 * it is the documented way to write a genuinely read-only global, and the value
 * is restored in a `finally` either way.
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

/* ========================================================================== */
/* Tier 2: optional configuration never throws                                */
/* ========================================================================== */

describe('optional integration configuration never throws', () => {
  it('reads every Gemini tunable with its documented default', () => {
    // docs/21 §2. A build with none of them set must behave exactly as docs/09 §7
    // specifies for a missing key: triage is skipped and the fallback runs.
    const config = geminiConfig();
    expect(config.model).toBe('gemini-2.5-flash');
    expect(config.timeoutMs).toBe(20_000);
    expect(config.maxRetries).toBe(3);
    expect(config.rpmLimit).toBe(8);
    expect(config.rpdLimit).toBe(200);
    expect(config.confidenceReviewThreshold).toBe(0.6);
  });

  it('reads the Maps tunables with their defaults', () => {
    const config = googleMapsConfig();
    expect(config.region).toBe('IN');
    expect(config.defaultCenter).toBe('17.4478,78.4874');
    expect(config.localRpmLimit).toBe(30);
  });

  it('reads the Twilio flags with their defaults, both OFF', () => {
    const config = twilioConfig();
    expect(config.smsEnabled).toBe(false);
    expect(config.whatsappEnabled).toBe(false);
    expect(config.retryLimit).toBe(2);
  });

  it('reports a malformed NUMBER as the default rather than failing a request', () => {
    // A stray comma in a dashboard must degrade to the documented default, not
    // take down a request on a path that must not be able to fail.
    withEnv({ GEMINI_TIMEOUT_MS: '20000;' }, () => {
      expect(geminiConfig().timeoutMs).toBe(20_000);
    });
  });

  it('reads the operational defaults', () => {
    expect(requestTimeoutMs()).toBe(15_000);
    expect(rateLimitConfig()).toEqual({ store: 'firestore', windowSec: 3600, trustProxy: true });
  });

  it('reports an ABSENT optional secret as null, not as an empty string', () => {
    // `null` and `''` mean different things to a caller: `''` could be a value.
    expect(cronSecret()).toBeNull();
    expect(ipHashSalt()).toBeNull();
  });
});

/* ========================================================================== */
/* Tier 1: required configuration                                              */
/* ========================================================================== */

describe('the Admin SDK is all-or-nothing (docs/21 §7)', () => {
  it('is unconfigured in this repository, and says so', () => {
    expect(isAdminConfigured()).toBe(false);
  });

  it('reports a sentence naming the three variables, and no value', () => {
    const status = integrationStatus().firebaseAdmin;
    expect(status.configured).toBe(false);
    expect(status.required).toEqual([
      'FIREBASE_PROJECT_ID',
      'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_PRIVATE_KEY',
    ]);
    expect(status.problem).toContain('FIREBASE_PRIVATE_KEY');
  });
});

/* ========================================================================== */
/* No secret behind NEXT_PUBLIC_                                               */
/* ========================================================================== */

describe('no server secret is exposed to the browser', () => {
  /**
   * The single most important invariant in this file, and the one a future
   * contributor is most likely to break by adding a `NEXT_PUBLIC_` prefix to
   * something that "needs to be readable in the browser".
   *
   * Anything prefixed `NEXT_PUBLIC_` is INLINED into the client bundle by Next
   * at build time. It is not obfuscated, not encrypted, and not hidden — it is in
   * the JavaScript every visitor downloads.
   */
  const FORBIDDEN_PUBLIC_PREFIXES = [
    'GEMINI_API_KEY',
    'GOOGLE_MAPS_SERVER_KEY',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_ACCOUNT_SID',
    'CRON_SECRET',
    'IP_HASH_SALT',
    'SEED_DEMO_PASSWORD',
  ];

  it('no server secret appears in this process with a NEXT_PUBLIC_ prefix', () => {
    for (const name of Object.keys(process.env)) {
      for (const forbidden of FORBIDDEN_PUBLIC_PREFIXES) {
        expect(
          name.startsWith('NEXT_PUBLIC_') && name.includes(forbidden),
          `${name} would publish ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it('the maps SPLIT is correct: browser key public, server key not', () => {
    // The browser key loads the Maps JavaScript API and is public by
    // construction; the server key is billed per call and must never ship. They
    // are DIFFERENT credentials with DIFFERENT restrictions (docs/21 §5).
    expect(GOOGLE_MAPS_SERVER_VARS).toEqual(['GOOGLE_MAPS_SERVER_KEY']);
    expect(GOOGLE_MAPS_SERVER_VARS.every((n) => !n.startsWith('NEXT_PUBLIC_'))).toBe(true);
  });

  it('the required variable lists are all server-only', () => {
    for (const list of [GEMINI_REQUIRED_VARS, GOOGLE_MAPS_SERVER_VARS, TWILIO_VARS]) {
      for (const name of list) {
        expect(name.startsWith('NEXT_PUBLIC_'), `${name} must be server-only`).toBe(false);
      }
    }
  });
});

/* ========================================================================== */
/* Configuration faults                                                        */
/* ========================================================================== */

describe('serverEnvProblems reports a FAULT, and never a value', () => {
  it('is empty in a clean non-production environment', () => {
    // `RATE_LIMIT_STORE` defaults to `firestore` and `ALLOW_SEED` to false, so
    // nothing is wrong here. A non-empty result in a clean tree is a false alarm
    // that would train an operator to ignore the field.
    expect(serverEnvProblems()).toEqual([]);
  });

  it('names the variable for an in-memory rate-limit store', () => {
    const original = process.env.RATE_LIMIT_STORE;
    try {
      process.env.RATE_LIMIT_STORE = 'memory';
      const problems = serverEnvProblems();
      expect(problems.join(' ')).toContain('RATE_LIMIT_STORE');
      // The reason matters as much as the name: an operator who only knows the
      // variable name will set it back to `memory`.
      expect(problems.join(' ')).toContain('single-use process');
    } finally {
      if (original === undefined) delete process.env.RATE_LIMIT_STORE;
      else process.env.RATE_LIMIT_STORE = original;
    }
  });

  it('refuses ALLOW_SEED in a production build', () => {
    // Seeding writes demo incidents into the live project (docs/21 §4, FR-147).
    withEnv({ NODE_ENV: 'production', ALLOW_SEED: 'true' }, () => {
      expect(serverEnvProblems().join(' ')).toContain('ALLOW_SEED');
    });
  });

  it('treats a private key behind NEXT_PUBLIC_ as a FAULT, not a warning', () => {
    // docs/21 §7. This is the guard that would catch the mistake before a
    // reviewer does, because a `NEXT_PUBLIC_` value is in the bundle.
    withEnv({ NEXT_PUBLIC_FIREBASE_API_KEY: '-----BEGIN PRIVATE KEY-----\nabc\n' }, () => {
      const problems = serverEnvProblems();
      expect(problems.join(' ')).toContain('NEXT_PUBLIC_FIREBASE_API_KEY');
      expect(problems.join(' ')).toContain('published to the browser');
    });
  });

  it('requires https for the app URL in production', () => {
    // An http app URL in production makes the CSRF origin check bypassable by a
    // network attacker (docs/10 §12.1).
    withEnv({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'http://caregrid.example.com' }, () => {
      expect(serverEnvProblems().join(' ')).toContain('https');
    });
  });
});

/* ========================================================================== */
/* Integration status carries NAMES                                            */
/* ========================================================================== */

describe('integration status reports NAMES and booleans, never values', () => {
  it('reports all four providers, none of them configured in this build', () => {
    const status = integrationStatus();
    expect(status.gemini.configured).toBe(false);
    expect(status.googleMapsServer.configured).toBe(false);
    expect(status.twilio.configured).toBe(false);
    expect(status.firebaseAdmin.configured).toBe(false);
  });

  it('names the exact variables each provider needs', () => {
    expect(integrationStatus().gemini.required).toEqual(['GEMINI_API_KEY']);
    expect(integrationStatus().googleMapsServer.required).toEqual(['GOOGLE_MAPS_SERVER_KEY']);
    expect(integrationStatus().twilio.required).toEqual([
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_WHATSAPP_NUMBER',
    ]);
  });

  it('every `problem` is a sentence naming what to set, and none leaks a value', () => {
    for (const provider of Object.values(integrationStatus())) {
      if (provider.problem === null) continue;
      expect(provider.problem.length).toBeGreaterThan(20);
      expect(provider.problem).toContain('.env.local');
      // A problem string is shown on an admin page. It must never contain
      // anything that looks like a credential.
      expect(provider.problem).not.toMatch(/-----BEGIN|AIza|sk-[A-Za-z0-9]/);
    }
  });

  it('the boolean helpers agree with the status objects', () => {
    expect(isGeminiConfigured()).toBe(integrationStatus().gemini.configured);
    expect(isGoogleMapsServerConfigured()).toBe(integrationStatus().googleMapsServer.configured);
    expect(isTwilioConfigured()).toBe(integrationStatus().twilio.configured);
  });
});

/* ========================================================================== */
/* The client half                                                             */
/* ========================================================================== */

describe('the public half is unconfigured too, and does not throw', () => {
  it('Firebase is unconfigured in this repository', () => {
    expect(isFirebaseConfigured()).toBe(false);
  });

  it('the browser maps key is null, not a placeholder', () => {
    // NO PLACEHOLDER KEY. A fake key produces a Google error that looks exactly
    // like a network fault, and a reviewer loses an afternoon to it.
    expect(getPublicMapsConfig().browserKey).toBeNull();
    expect(isMapsConfigured()).toBe(false);
  });

  it('gives the map a usable default style and zoom without a key', () => {
    // The map is Phase 6. A missing browser key must not break a component that
    // reads these values today.
    const config = getPublicMapsConfig();
    expect(config.style).toBe('dark');
    expect(config.zoomDefault).toBe(13);
    expect(config.zoomMax).toBeGreaterThanOrEqual(config.zoomDefault);
  });

  it('explains the map fallback in a sentence a user can act on', () => {
    // docs/12 §9: the LIST is the mandatory fallback when the map cannot load.
    expect(String(getPublicMapsConfig().mapsProblem)).toContain('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY');
  });
});

/* ========================================================================== */
/* Collection names                                                            */
/* ========================================================================== */

describe('the collection table (docs/07 §1)', () => {
  /**
   * The authoritative cross-reference is the RULES FILE, not a hard-coded
   * number. `firestore.rules` is the deployed artifact, it is deny-by-default
   * with a catch-all, and a `match /x/` block with no constant in this table
   * means a magic string is living somewhere it should not.
   */
  function rulesCollections(): string[] {
    const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');
    const found: string[] = [];
    // Only TOP-LEVEL blocks: a `match` nested inside another match is a
    // subcollection, and the indentation is what distinguishes them.
    for (const line of rules.split('\n')) {
      const match = line.match(/^ {4}match \/([A-Za-z]+)\/\{/);
      if (match?.[1]) found.push(match[1]);
    }
    return found;
  }

  it('every collection the RULES cover has a constant here', () => {
    for (const name of rulesCollections()) {
      const covered = COLLECTION_NAMES.includes(name) || name === 'config';
      expect(covered, `firestore.rules covers /${name}/ but COLLECTIONS has no constant for it`).toBe(
        true,
      );
    }
  });

  it('every constant here is a collection the RULES cover, or is explicitly noted as pending', () => {
    // `notificationReads` is the one documented collection with no rule yet. It
    // is CLOSED, not open, because of the catch-all, and the constant says so.
    const PENDING = new Set(['notificationReads']);
    for (const name of COLLECTION_NAMES) {
      if (PENDING.has(name)) continue;
      expect(rulesCollections(), `COLLECTIONS has ${name} but firestore.rules does not`).toContain(name);
    }
  });

  it('has no duplicate names', () => {
    // A duplicate would mean two constants for one collection, and a route could
    // write to one and a query read the other.
    expect(new Set(COLLECTION_NAMES).size).toBe(COLLECTION_NAMES.length);
  });

  it('uses the documented names, in lowerCamelCase as Firestore paths are', () => {
    for (const name of COLLECTION_NAMES) {
      expect(name).toMatch(/^[a-z][A-Za-z]*$/);
    }
  });

  it('`config/app` is a single DOCUMENT, so it is not in the collection list', () => {
    // docs/07 §11.8. A collection-shaped constant for it would invite
    // `.collection('config/app')`, which is not a thing.
    expect(COLLECTIONS.configApp).toBe('config/app');
    expect(COLLECTION_NAMES).not.toContain('config/app');
  });

  it('the two incident subcollections are named separately, never as top-level', () => {
    // `incidents/{id}/reports` and `incidents/{id}/statusHistory`. A top-level
    // `reports` constant would invite a query that silently targets a different
    // collection than the subcollection the caller meant.
    expect(SUB_COLLECTIONS.incidentReports).toBe('reports');
    expect(SUB_COLLECTIONS.statusHistory).toBe('statusHistory');
    expect(COLLECTION_NAMES).not.toContain('reports');
    expect(COLLECTION_NAMES).not.toContain('statusHistory');
  });

  it('includes every collection the auth guard and the audit writer use', () => {
    // `lib/server/auth-guard.ts` and `lib/server/audit.ts` write to these, and a
    // missing entry would mean a string literal creeping back in.
    for (const name of [
      COLLECTIONS.users,
      COLLECTIONS.profiles,
      COLLECTIONS.auditLogs,
      COLLECTIONS.rateLimits,
    ]) {
      expect(COLLECTION_NAMES).toContain(name);
    }
  });
});

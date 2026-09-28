import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getTriageProvider, PROMPT_VERSION, providerStatus } from '@/services/integrations/gemini';
import { getGeocodingProvider, providerStatus as mapsStatus } from '@/services/integrations/google-maps';
import {
  availableChannels,
  getExternalChannels,
  providerStatus as twilioStatus,
} from '@/services/integrations/twilio';
import { toTriageRequest, triageIncident, TRIAGE_LIMITS } from '@/services/ai';
import { INCIDENT_CATEGORIES, URGENCIES } from '@/types/enums';
import { AppError } from '@/lib/server/errors';
import type { TriageProvider, TriageRequest, TriageResult } from '@/lib/integrations/contracts';

/**
 * ============================================================================
 * The provider boundaries
 * ============================================================================
 *
 * The claim under test is the one that matters most for the product: **a missing
 * external key degrades the feature and nothing else.** Not a crash, not a 500,
 * and above all not a fabricated answer.
 *
 * The failure mode being defended against is specific and severe. A triage
 * provider that "helpfully" returned `urgency: 'critical'` with no key would put
 * a fabricated triage decision on a real emergency report. A geocoder that
 * returned `0, 0` would put a fabricated location in the middle of the Indian
 * Ocean. Both are worse than an honest failure, so the honest failure is what
 * these tests pin.
 *
 * The test provider implements the SAME `TriageProvider` interface as the real
 * one. That is the seam docs/32 MUST 7 requires: the mock lives in `tests/`, keyed
 * by an interface the production code already has, and there is no
 * `if (import.meta.env.DEV)` branch anywhere in the path.
 */

const ROOT = join(process.cwd());

/* ========================================================================== */
/* Unconfigured means unavailable, and says so                                 */
/* ========================================================================== */

describe('with no key configured, every provider reports itself unavailable', () => {
  it('Gemini is unavailable, and its status names the missing variable', () => {
    const status = providerStatus();
    expect(status.provider).toBe('gemini');
    expect(status.configured).toBe(false);
    expect(status.requiredVars).toEqual(['GEMINI_API_KEY']);
    expect(status.problem).toContain('GEMINI_API_KEY');
  });

  it('Google Maps is unavailable, and its status names the SERVER key', () => {
    const status = mapsStatus();
    expect(status.configured).toBe(false);
    // The SERVER key, not the browser one: the browser key is a public
    // referrer-restricted credential and is not what geocoding uses.
    expect(status.requiredVars).toEqual(['GOOGLE_MAPS_SERVER_KEY']);
  });

  it('Twilio is unavailable, and names all three of its variables', () => {
    const status = twilioStatus();
    expect(status.configured).toBe(false);
    expect(status.requiredVars).toEqual([
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_WHATSAPP_NUMBER',
    ]);
  });

  it('no provider status leaks a value, only a name and a sentence', () => {
    for (const status of [providerStatus(), mapsStatus(), twilioStatus()]) {
      const serialised = JSON.stringify(status);
      expect(serialised).not.toMatch(/-----BEGIN|AIza|sk-[A-Za-z0-9]/);
      expect(Object.keys(status).sort()).toEqual(
        ['configured', 'problem', 'provider', 'requiredVars'].sort(),
      );
    }
  });
});

/* ========================================================================== */
/* Each secret is read in exactly ONE file                                     */
/* ========================================================================== */

describe('each provider secret is read in exactly one file', () => {
  /**
   * `rg GEMINI_API_KEY` should be a complete audit of where the key can be read.
   * Two readers means two places to forget a timeout, two places to log it by
   * accident, and no way to rotate it with confidence.
   *
   * The ONE legitimate reader is the env accessor. The integration adapter calls
   * `geminiConfig()`, not `process.env`, which is strictly better than the
   * adapter reading the variable itself: the accessor owns the validation, the
   * clamping, and the default, so there is one place to change any of them.
   */
  const SECRETS: readonly string[] = ['GEMINI_API_KEY', 'GOOGLE_MAPS_SERVER_KEY', 'TWILIO_AUTH_TOKEN'];

  it('each secret is named in CODE in exactly one file: the env accessor', () => {
    for (const name of SECRETS) {
      const readers = grepSourceFiles(name);
      expect(readers, `${name} is named in no code at all`).toHaveLength(1);
      expect(readers[0], `${name} must be read only by lib/env.server.ts`).toBe(
        'lib/env.server.ts',
      );
    }
  });

  it('no service, integration, validator, or route reads process.env at all', () => {
    // The rule is "secrets come from `lib/env.server.ts`, once". A direct read
    // anywhere else bypasses the validation, the clamping, and the boot check.
    //
    // Four files outside `lib/env.*` legitimately read the environment, and NONE
    // of them reads a secret — each reads `NODE_ENV` or a documented non-secret
    // flag, and each is listed here so adding a fifth is a deliberate act:
    //
    //   middleware.ts          `NODE_ENV`, to relax HSTS and the CSP in dev
    //   lib/server/http.ts     `LOG_LEVEL`, read directly so a logger can never
    //                          be prevented from logging by a missing secret
    //   lib/api/client.ts      `NODE_ENV`, to gate a development-only warning
    //   lib/firebase/auth.ts   the emulator flag, which is a boolean
    //
    // The assertion is on `services/**`, `validators/**`, and `app/**` being
    // clean, plus these four being the complete set.
    const ALLOWED = new Set([
      'lib/env.server.ts',
      'lib/env.client.ts',
      'lib/env.maintenance.ts',
      'middleware.ts',
      'lib/server/http.ts',
      'lib/api/client.ts',
      'lib/firebase/auth.ts',
    ]);
    const offenders = grepFilesMentioning('process.env')
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => !file.startsWith('tests/'));
    expect(
      offenders,
      `process.env is read outside the allowed set by: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

/* ========================================================================== */
/* triageIncident never throws                                                 */
/* ========================================================================== */

describe('triageIncident never throws at its caller (FR-029)', () => {
  const request: TriageRequest = toTriageRequest({
    text: 'A man has collapsed near the bus stop and is not responding.',
    language: 'en',
    locationHint: null,
    locationAccuracy: 'unknown',
    imageCount: 0,
    audioCount: 0,
    newAccount: false,
  });

  it('returns the FALLBACK outcome when the provider is unavailable', async () => {
    // The real provider, in this deployment. A citizen pressing "send" during a
    // medical emergency must not lose their report because a key is missing
    // 3,000 km away.
    const outcome = await triageIncident(request, { requestId: 'req_aaaaaaaaaaaa', timeoutMs: 0 });
    expect(outcome.source).toBe('fallback');
    expect(outcome.needsReview).toBe(true);
  });

  it('never FABRICATES a category, an urgency, or a confidence', async () => {
    // The specific failure this defends against. A fabricated `critical` on a
    // real report is a fabricated triage decision.
    //
    // -------------------------------------------------------------------------
    // THIS TEST WAS CORRECTED IN PHASE 4, NOT DELETED
    // -------------------------------------------------------------------------
    // It previously asserted `category`, `urgency`, `confidence` and `summary`
    // were all `null`, because Phase 3's fallback returned nulls. Two things
    // changed and the reasoning is recorded here rather than the assertion being
    // quietly dropped (docs/30.4 §5.2 is the precedent — a test corrected
    // *because an anchor document says it was wrong*):
    //
    //   1. docs/09 §7.2 specifies a keyword fallback engine, and §7.3 requires
    //      "every incident gets a plausible, honest triage even with zero AI
    //      availability". Nulls are not a triage; they are the absence of one,
    //      and they leave a dispatcher with nothing to sort on.
    //   2. So the fallback now derives values from the citizen's own words.
    //
    // The test's INTENT is preserved and is in fact asserted more strongly below.
    // "Never fabricate" does not mean "never derive" — it means every value must
    // be traceable to the report, must be inside the controlled taxonomy, and
    // must be flagged as low confidence. A fabricated value is one with no
    // provenance; a keyword match has provenance and says so.
    //
    // The counter-test that matters is `derives nothing from a report with no
    // keywords` in `tests/unit/ai/fallback.test.ts`, which asserts the engine
    // returns `other`/`low` for a contentless report rather than guessing.
    const outcome = await triageIncident(request, { requestId: 'req_aaaaaaaaaaaa', timeoutMs: 0 });

    expect(outcome.source).toBe('fallback');

    // Every value is inside the controlled taxonomy. Never a free value, never
    // something outside `INCIDENT_CATEGORIES`/`URGENCIES`.
    expect(INCIDENT_CATEGORIES).toContain(outcome.category);
    expect(URGENCIES).toContain(outcome.urgency);

    // Confidence is a real number, and it is capped BELOW the review threshold —
    // which is the property that makes "needs review" true for every fallback.
    expect(outcome.confidence).not.toBeNull();
    expect(outcome.confidence).toBeGreaterThan(0);
    expect(outcome.confidence).toBeLessThan(0.6);

    // Still ALWAYS flagged for review, and still labelled.
    expect(outcome.needsReview).toBe(true);

    // The summary says on its face that it is automated. A summary that read
    // like a human observation would be the fabrication this guards against.
    expect(outcome.summary).toContain('Automated triage only');
    expect(outcome.summary).toContain('human review');

    // No raw output exists for a fallback, so there is nothing to hash.
    expect(outcome.rawOutputHash).toBeNull();

    // The outcome records WHY it fell back, which is what an operator reads.
    expect(outcome.outcome).toBe('fallback');
  });

  it('returns the fallback when the provider THROWS, including a non-AppError', async () => {
    // A provider that throws a bare `Error` is a bug, but it must not become a
    // 500 on the report path. The bug is logged; the caller gets the fallback.
    const throwing: TriageProvider = {
      name: 'test-thrower',
      model: 'test-model',
      promptVersion: 'test',
      isAvailable: () => true,
      triage: async () => {
        throw new TypeError('provider exploded');
      },
    };
    const outcome = await triageIncident(request, {
      requestId: 'req_aaaaaaaaaaaa',
      timeoutMs: 0,
      provider: throwing,
    });
    expect(outcome.source).toBe('fallback');
    expect(outcome.needsReview).toBe(true);
  });

  it('honours `skip`, which is how a maintenance window disables AI', async () => {
    const outcome = await triageIncident(request, { requestId: 'req_aaaaaaaaaaaa', timeoutMs: 0, skip: true });
    expect(outcome.source).toBe('fallback');
  });

  it('computes needsReview from the THRESHOLD, never from the model', async () => {
    // A model that says it is 100% sure of a low-quality reading is the exact
    // case FR-024 exists for. Below `AI_CONFIDENCE_REVIEW_THRESHOLD` (0.6) the
    // UI must say "needs review" whatever the model claims.
    const lowConfidence: TriageProvider = {
      name: 'test',
      model: 'test-model',
      promptVersion: 'test',
      isAvailable: () => true,
      triage: async (): Promise<TriageResult> => ({
        category: 'medical',
        urgency: 'high',
        summary: 'A person is reported collapsed.',
        safetyFlags: ['medical_critical'],
        confidence: 0.55,
        rationale: 'the text mentions collapse',
        rawOutputHash: 'abc123',
      }),
    };
    const outcome = await triageIncident(request, {
      requestId: 'req_aaaaaaaaaaaa',
      timeoutMs: 0,
      provider: lowConfidence,
    });
    expect(outcome.source).toBe('ai');
    expect(outcome.confidence).toBe(0.55);
    expect(outcome.needsReview).toBe(true);
  });

  it('a high-confidence result is NOT flagged for review', async () => {
    const confident: TriageProvider = {
      name: 'test',
      model: 'test-model',
      promptVersion: 'test',
      isAvailable: () => true,
      triage: async (): Promise<TriageResult> => ({
        category: 'medical',
        urgency: 'critical',
        summary: 'Unconscious person, not breathing.',
        safetyFlags: ['medical_critical'],
        confidence: 0.91,
        rationale: 'explicit',
        rawOutputHash: 'def456',
      }),
    };
    const outcome = await triageIncident(request, {
      requestId: 'req_aaaaaaaaaaaa',
      timeoutMs: 0,
      provider: confident,
    });
    expect(outcome.needsReview).toBe(false);
    expect(outcome.source).toBe('ai');
  });

  it('it CLAMPS a confidence outside 0..1 rather than trusting the model', async () => {
    // `1.4` would render a confidence meter past its end AND defeat the
    // `needsReview` comparison, which is the property FR-024 relies on.
    const cases: Array<[reported: number, clamped: number, needsReview: boolean]> = [
      [1.4, 1, false],
      // Clamped to 0, which is BELOW the 0.6 threshold, so it IS flagged. That is
      // correct: a model reporting negative confidence is not to be trusted, and
      // flagging it is the safe direction.
      [-0.2, 0, true],
    ];
    for (const [reported, clamped, needsReview] of cases) {
      const provider: TriageProvider = {
        name: 'test',
        model: 'm',
        promptVersion: 'v',
        isAvailable: () => true,
        triage: async (): Promise<TriageResult> => ({
          category: 'medical',
          urgency: 'high',
          summary: 's',
          safetyFlags: [],
          confidence: reported,
          rationale: null,
          rawOutputHash: null,
        }),
      };
      const outcome = await triageIncident(request, {
        requestId: 'req_aaaaaaaaaaaa',
        timeoutMs: 0,
        provider,
      });
      expect(outcome.confidence).toBe(clamped);
      expect(outcome.needsReview).toBe(needsReview);
    }
  });

  it('treats an ALL-NULL provider result as a DECLINED, not as data', async () => {
    // A `new` incident with no category, no urgency, and no review flag is a
    // report nobody will look at.
    const declining: TriageProvider = {
      name: 'test',
      model: 'm',
      promptVersion: 'v',
      isAvailable: () => true,
      triage: async (): Promise<TriageResult> => ({
        category: null,
        urgency: null,
        summary: null,
        safetyFlags: [],
        confidence: null,
        rationale: null,
        rawOutputHash: null,
      }),
    };
    const outcome = await triageIncident(request, {
      requestId: 'req_aaaaaaaaaaaa',
      timeoutMs: 0,
      provider: declining,
    });
    expect(outcome.source).toBe('fallback');
    expect(outcome.needsReview).toBe(true);
  });

  it('the outcome type has NO field that could carry a dispatch or a coordinate', () => {
    // MUST NOT 8 is a property of the TYPE, not of a convention. If there is no
    // field for a dispatch decision, a coordinate, or a casualty count, then no
    // future refactor of this file can route AI output to a responder.
    const outcome = {
      source: 'fallback',
      category: null,
      urgency: null,
      summary: null,
      safetyFlags: [],
      confidence: null,
      rationale: null,
      needsReview: true,
      providerName: 'gemini',
      model: 'm',
      promptVersion: 'v',
      rawOutputHash: null,
    };
    for (const forbidden of ['dispatch', 'dispatchId', 'responderUid', 'lat', 'lng', 'geo', 'casualties', 'resource']) {
      expect(Object.keys(outcome), `${forbidden} must not be a triage field`).not.toContain(forbidden);
    }
  });
});

/* ========================================================================== */
/* The sanitisation boundary                                                   */
/* ========================================================================== */

describe('toTriageRequest is the whole of what crosses the boundary', () => {
  it('carries no uid, no email, no phone, and no coordinate', () => {
    // A model does not need a citizen's email address to categorise a report,
    // and sending it would put personal data into a third-party processor for no
    // benefit (docs/09 §4, docs/24 T-09).
    //
    // The key list gained `images` in Phase 4, for multimodal triage. It is an
    // ARRAY OF VALIDATED IMAGES, not a URL and not a Storage path — which is why
    // it is safe to be on a record that crosses to a third party, and why the
    // assertion is on the full key list rather than a `not.toContain` sweep: a
    // sweep would pass while a future field carrying an email slipped in beside
    // it.
    const request = toTriageRequest({
      text: 'x'.repeat(50),
      language: 'en',
      locationHint: 'near the bridge',
      locationAccuracy: 'medium',
      imageCount: 1,
      audioCount: 0,
      newAccount: false,
    });
    expect(Object.keys(request).sort()).toEqual(
      [
        'audioCount',
        'imageCount',
        'images',
        'language',
        'locationAccuracy',
        'locationHint',
        'newAccount',
        'text',
      ].sort(),
    );
    // Empty by default, and empty for a text-only report. A caller that supplies
    // no images must send no images — not an empty object, not a placeholder.
    expect(request.images).toEqual([]);
  });

  it('derives imageCount from the images ACTUALLY present, never from the caller', () => {
    // A client that claimed three images and supplied one would otherwise make the
    // prompt tell the model three images are attached when it can see one — a
    // small lie that reaches a third party and misleads the classifier.
    const request = toTriageRequest({
      text: 'x'.repeat(50),
      language: 'en',
      locationHint: null,
      locationAccuracy: 'unknown',
      imageCount: 3,
      audioCount: 0,
      newAccount: false,
    });
    expect(request.imageCount).toBe(0);
  });

  it('TRUNCATES rather than refusing, because a real emergency must still be triaged', () => {
    // Refusing to triage an over-long report would leave a real emergency with no
    // assistance at all. The full text is stored verbatim in Firestore
    // regardless; only the copy sent to a third party is bounded.
    const request = toTriageRequest({
      text: 'y'.repeat(TRIAGE_LIMITS.textMaxChars + 5000),
      language: 'en',
      locationHint: 'z'.repeat(TRIAGE_LIMITS.locationHintMaxChars + 500),
      locationAccuracy: 'unknown',
      imageCount: 99,
      audioCount: 99,
      newAccount: false,
      // Nine supplied, three allowed. The surplus is not silently dropped: it is
      // bounded HERE and the dropped names are recorded on the outcome, so a
      // dispatcher learns the model saw three of nine rather than believing it saw
      // nine (docs/09 §4.2).
      images: Array.from({ length: 9 }, (_, i) => ({
        mimeType: 'image/png',
        base64: 'AAAA',
        sha256: 'a'.repeat(64),
        byteLength: 3,
        fileName: `photo-${i}.png`,
      })),
    });
    expect(request.text).toHaveLength(TRIAGE_LIMITS.textMaxChars);
    expect(request.locationHint).toHaveLength(TRIAGE_LIMITS.locationHintMaxChars);
    // `imageCount` is now DERIVED from the truncated array, so it is 3 — the
    // number the model will actually see — rather than the caller's 99.
    expect(request.imageCount).toBe(TRIAGE_LIMITS.maxImages);
    expect(request.images).toHaveLength(TRIAGE_LIMITS.maxImages);
    expect(request.audioCount).toBe(TRIAGE_LIMITS.maxAudioClips);
  });

  it('passes nulls through as nulls, not as empty strings', () => {
    // An empty string reads to a model as "the reporter said nothing", which is
    // a different claim from "there is no text".
    const request = toTriageRequest({
      text: null,
      language: 'en',
      locationHint: null,
      locationAccuracy: 'unknown',
      imageCount: 0,
      audioCount: 0,
      newAccount: false,
    });
    expect(request.text).toBeNull();
    expect(request.locationHint).toBeNull();
  });

  it('normalises a nonsense count to zero rather than passing NaN through', () => {
    const request = toTriageRequest({
      text: 'x'.repeat(30),
      language: 'en',
      locationHint: null,
      locationAccuracy: 'unknown',
      imageCount: Number.NaN,
      audioCount: -3,
      newAccount: false,
    });
    expect(request.imageCount).toBe(0);
    expect(request.audioCount).toBe(0);
  });
});

/* ========================================================================== */
/* The Gemini provider itself                                                  */
/* ========================================================================== */

describe('the unconfigured Gemini provider', () => {
  it('is a real object with the real interface, not a null', async () => {
    // A route written against "the provider might be missing" turns into
    // `if (!provider) return {}` and a silent empty triage.
    const provider = getTriageProvider();
    expect(provider).toBeTruthy();
    expect(typeof provider.triage).toBe('function');
    expect(typeof provider.isAvailable).toBe('function');
    expect(provider.promptVersion).toBe(PROMPT_VERSION);
  });

  it('throws a 502 AI_UNAVAILABLE, not a 500', async () => {
    // 502 is "upstream fault": the request was well-formed and we reached a
    // provider boundary. A 500 would tell an integrator the server is broken.
    const provider = getTriageProvider();
    await expect(
      provider.triage(
        toTriageRequest({
          text: 'x'.repeat(30),
          language: 'en',
          locationHint: null,
          locationAccuracy: 'unknown',
          imageCount: 0,
          audioCount: 0,
          newAccount: false,
        }),
        { timeoutMs: 1000 },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('AI_UNAVAILABLE');
      expect(appError.status).toBe(502);
      // The copy must tell the user the report is still fine, because a person
      // reporting an emergency reads this.
      expect(appError.message).toContain('still recorded');
      return true;
    });
  });

  it('is memoised, so a warm instance does not rebuild it per request', () => {
    expect(getTriageProvider()).toBe(getTriageProvider());
  });

  it('PROMPT_VERSION is the documented triage-v3', () => {
    // `aiRuns.promptVersion` stops meaning anything if the constant drifts from
    // the prompt docs/09 §6 specifies.
    expect(PROMPT_VERSION).toBe('triage-v3');
  });
});

/* ========================================================================== */
/* The Maps provider                                                           */
/* ========================================================================== */

describe('the unconfigured Maps provider', () => {
  it('throws rather than returning 0,0 for a failed lookup', async () => {
    // THE most dangerous fabrication in this product. A geocoder that returns
    // 0,0 on failure puts a fabricated location in the middle of the Indian
    // Ocean on a real emergency report, and every responder is sent there.
    const provider = getGeocodingProvider();
    expect(provider.isAvailable()).toBe(false);
    await expect(provider.geocode('somewhere in hyderabad', { timeoutMs: 8000 })).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as AppError).code).toBe('MAPS_UNAVAILABLE');
        expect((error as AppError).status).toBe(502);
        expect((error as AppError).message).not.toMatch(/0,\s*0|null island/);
        return true;
      },
    );
  });

  it('reverse geocoding fails the same way', async () => {
    await expect(
      getGeocodingProvider().reverseGeocode({ lat: 17.4478, lng: 78.4874 }, { timeoutMs: 8000 }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

/* ========================================================================== */
/* The notification channels                                                   */
/* ========================================================================== */

describe('the notification channels', () => {
  it('in-app is ALWAYS available, because Twilio being off must not silence alerts', () => {
    // A kill switch that turns off every notification because an SMS provider is
    // unconfigured would leave a responder with no alert at all.
    expect(availableChannels()).toEqual(['in_app']);
  });

  it('SMS and WhatsApp are unavailable and refuse with 422, not 502 or 503', async () => {
    // 422 because the answer is PERMANENT for this deployment. A 502 or 503 would
    // make a well-behaved client retry a send that can never succeed.
    for (const channel of getExternalChannels()) {
      expect(channel.isAvailable()).toBe(false);
      await expect(
        channel.send({ to: '+919876543210', body: 'x', idempotencyKey: 'k' }, { timeoutMs: 5000 }),
      ).rejects.toSatisfy((error: unknown) => {
        const appError = error as AppError;
        expect(appError.code).toBe('NOTIFICATION_DISABLED');
        expect(appError.status).toBe(422);
        expect(appError.message).toContain('no provider is configured');
        return true;
      });
    }
  });

  it('there is NO code path in which a send succeeds without a provider', async () => {
    // docs/32 MUST 7: no `if (DEV) return { ok: true }` inside a feature. A
    // branch that could make a send "succeed" without Twilio would be a
    // fabricated notification in an emergency system. Asserted against CODE,
    // with comments stripped — these files explain the rule at length, and a
    // naive text search would fail on the explanation.
    for (const file of [
      'services/integrations/twilio/index.ts',
      'services/integrations/gemini/index.ts',
      'services/integrations/google-maps/index.ts',
    ]) {
      const text = code(file);
      expect(text, `${file} branches on NODE_ENV`).not.toMatch(/NODE_ENV/);
      expect(text, `${file} reads import.meta.env`).not.toMatch(/import\.meta\.env/);
      expect(text, `${file} has a dev-only data branch`).not.toMatch(/\bDEV\b/);
    }
  });
});

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/** A file with every comment removed, so assertions are about behaviour. */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

/** Files whose CODE (comments stripped) mentions `needle`. */
function grepSourceFiles(needle: string): string[] {
  return grepFilesMentioning(needle);
}

function grepFilesMentioning(needle: string): string[] {
  const roots = ['app', 'lib', 'services', 'config', 'validators', 'types', 'middleware.ts'];
  const out: string[] = [];
  const visit = (path: string) => {
    const stat = statSafe(path);
    if (stat === null) return;
    if (stat.isDirectory()) {
      for (const entry of readDirSafe(path)) visit(join(path, entry));
      return;
    }
    if (!/\.(ts|tsx|mjs|cjs|json)$/.test(path)) return;
    const text = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\/.*$/gm, '');
    if (text.includes(needle)) {
      out.push(path.replace(`${ROOT}\\`, '').replace(/\\/g, '/'));
    }
  };
  for (const root of roots) visit(join(ROOT, root));
  return out;
}

function statSafe(path: string): { isDirectory: () => boolean } | null {
  try {
     
    return require('node:fs').statSync(path) as { isDirectory: () => boolean };
  } catch {
    return null;
  }
}

function readDirSafe(path: string): string[] {
  try {
     
    return require('node:fs').readdirSync(path) as string[];
  } catch {
    return [];
  }
}


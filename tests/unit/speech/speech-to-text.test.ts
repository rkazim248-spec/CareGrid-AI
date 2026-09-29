import { describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_COPY,
  geminiTranscriptService,
  transcriptFor,
  unavailableTranscriptService,
  type TriageOutcomeLike,
} from '@/services/speech/speech-to-text';

/**
 * A triage outcome with the audio fields set as a test asks for them.
 *
 * Built through a factory rather than written out four times, so a change to
 * `TriageOutcomeLike` breaks this file in one place instead of four.
 */
function outcome(over: Partial<TriageOutcomeLike> = {}): TriageOutcomeLike {
  return {
    audioTranscript: null,
    audioTranscriptUncertain: false,
    audioCount: 1,
    source: 'gemini',
    providerName: 'gemini',
    ...over,
  };
}

/* ========================================================================== */

describe('THE FOUR STATES ARE DISTINGUISHABLE', () => {
  // The whole reason this file exists. Conflating `none` and `unavailable` sends a
  // citizen to "speak up" when the real cause is a missing API key, or to a
  // support page when their recording was simply unintelligible.

  it('ready: transcribed, not flagged', () => {
    const t = geminiTranscriptService.fromTriageOutcome(
      outcome({ audioTranscript: 'There has been an accident near the market.' }),
      true,
    );
    expect(t.status).toBe('ready');
    expect(t.text).toBe('There has been an accident near the market.');
    expect(t.uncertain).toBe(false);
    expect(t.notice).toBeNull();
  });

  it('uncertain: transcribed AND flagged, and the flag is the model own', () => {
    const t = geminiTranscriptService.fromTriageOutcome(
      outcome({
        audioTranscript: 'the water is [inaudible] coming up to the [inaudible]',
        audioTranscriptUncertain: true,
      }),
      true,
    );
    expect(t.status).toBe('uncertain');
    expect(t.uncertain).toBe(true);
    // The text is still returned. A citizen with a partially-heard emergency
    // description is far better served by a marked-up transcript than by nothing.
    expect(t.text).not.toBeNull();
  });

  it('uncertainty comes from the FLAG, never from the text', () => {
    // docs/09's example 2 shows the model writing "[inaudible]" AND setting the
    // flag. A transcript that merely happens to contain the word, with the flag
    // false, is not thereby uncertain — the model is the authority, not the string.
    const t = geminiTranscriptService.fromTriageOutcome(
      outcome({ audioTranscript: 'he said the word inaudible to me' }),
      true,
    );
    expect(t.status).toBe('ready');
  });

  it('none: audio WAS attached and the model got nothing', () => {
    const t = geminiTranscriptService.fromTriageOutcome(outcome(), true);
    expect(t.status).toBe('none');
    expect(t.text).toBeNull();
    expect(t.notice).toBe(TRANSCRIPT_COPY.none);
    // Not the "unavailable" copy. This is the citizen's recording, and the words
    // tell them to record again rather than to give up on the feature.
    expect(t.notice).not.toBe(TRANSCRIPT_COPY.unavailable);
  });

  it('unavailable: nothing was even attempted', () => {
    const t = unavailableTranscriptService.fromTriageOutcome(outcome(), true);
    expect(t.status).toBe('unavailable');
    expect(t.text).toBeNull();
    expect(t.notice).toBe(TRANSCRIPT_COPY.unavailable);
  });
});

/* ========================================================================== */

describe('"uncertain" IS NEVER CLAIMED WHEN NOTHING WAS ATTEMPTED', () => {
  it('reports false, because nobody heard anything', () => {
    // brief §18: "Do not pretend transcription occurred." Telling a citizen their
    // words are possibly wrong when no provider exists would be a fabrication of
    // the most misleading kind — it implies someone listened.
    const t = unavailableTranscriptService.fromTriageOutcome(outcome(), true);
    expect(t.uncertain).toBe(false);
  });
});

/* ========================================================================== */

describe('a text-only report is never told transcription failed', () => {
  it('no audio attached and no transcript is a quiet success', () => {
    // A citizen who typed their report has no reason to see a transcript notice.
    // Rendering "voice transcription is unavailable" to someone who never recorded
    // anything is noise at best and alarming at worst.
    const t = geminiTranscriptService.fromTriageOutcome(outcome(), false);
    expect(t.status).toBe('ready');
    expect(t.text).toBeNull();
    expect(t.notice).toBeNull();
  });
});

/* ========================================================================== */

describe('an empty or whitespace transcript is treated as no transcript', () => {
  it.each([[''], ['   '], ['\n\t ']])('%j is `none`, not `ready` with blank text', (value) => {
    // A model that returns `""` transcribed nothing. Reporting `ready` would put
    // an empty text box in front of a citizen and invite them to submit it.
    const t = geminiTranscriptService.fromTriageOutcome(
      outcome({ audioTranscript: value }),
      true,
    );
    expect(t.status).toBe('none');
    expect(t.text).toBeNull();
  });
});

/* ========================================================================== */

describe('typing is ALWAYS available, in every state', () => {
  // brief §33: "The user must always have a fallback: Continue with text where
  // appropriate." For `none` and `unavailable` it is not a fallback — it is the
  // only way forward — which is why it is a literal `true` and not a boolean.

  const cases: readonly (readonly [string, ReturnType<typeof unavailableTranscriptService.fromTriageOutcome>])[] = [
    ['ready', geminiTranscriptService.fromTriageOutcome(outcome({ audioTranscript: 'fire' }), true)],
    ['uncertain', geminiTranscriptService.fromTriageOutcome(outcome({ audioTranscript: 'fi--', audioTranscriptUncertain: true }), true)],
    ['none', geminiTranscriptService.fromTriageOutcome(outcome(), true)],
    ['unavailable', unavailableTranscriptService.fromTriageOutcome(outcome(), true)],
  ];

  it.each(cases)('%s offers text', (_label, t) => {
    expect(t.canTypeInstead).toBe(true);
  });
});

/* ========================================================================== */

describe('the selection seam', () => {
  it('picks the gemini-backed service when audio is enabled', () => {
    // `GEMINI_AUDIO_ENABLED` defaults to true, and the default is the documented
    // behaviour, so a deployment that sets nothing gets the real path.
    const t = transcriptFor(outcome({ audioTranscript: 'help' }), true);
    expect(t.providerName).toBe('gemini-transcript');
  });

  it('answers the same way through the seam as through the implementation', () => {
    // The seam must not be a place where behaviour quietly differs.
    const direct = geminiTranscriptService.fromTriageOutcome(outcome(), true);
    const viaSeam = transcriptFor(outcome(), true);
    expect(viaSeam).toEqual(direct);
  });
});

/* ========================================================================== */

describe('NO COPY PROMISES A RESPONDER IS COMING', () => {
  // brief §34. Emergency safety: never imply dispatch that has not happened.
  const allCopy: readonly string[] = [
    ...Object.values(TRANSCRIPT_COPY),
    ...Object.values(TRANSCRIPT_COPY),
  ];

  it.each([
    ['emergency services have been notified', /emergency services (have|has) been notified/i],
    ['help is on the way', /help is on the way/i],
    ['a responder has been dispatched', /responder(s)? (has|have) been dispatched/i],
    ['we have alerted the authorities', /(we (have|has) )?alerted the authorities/i],
    ['someone will be there', /someone will be there/i],
  ])('no string claims %s', (_label, pattern) => {
    for (const copy of allCopy) {
      expect(copy, `copy matched ${pattern}: ${copy}`).not.toMatch(pattern);
    }
  });
});

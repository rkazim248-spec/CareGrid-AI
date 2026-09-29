/**
 * ============================================================================
 * CareGrid AI — the speech-to-text seam
 * ============================================================================
 *
 * brief §18 asks for a `SpeechToTextService` abstraction. This is it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SECOND GEMINI CALL (AND WHY THAT IS THE POINT)
 * ---------------------------------------------------------------------------
 * The obvious reading of brief §18 is a two-pass pipeline:
 *
 * ```
 * Voice -> SpeechToTextService -> Transcript -> Gemini Triage
 * ```
 *
 * **This project does not work that way, and the reason is docs/09, which is a
 * T0 anchor.** docs/09 §5 lists `audio_transcript` and `audio_transcript_uncertain`
 * as fields of the SAME 17-field output schema, and §6 gives the prompt an
 * `## AUDIO` section: *"If audio is provided, transcribe it faithfully in its
 * original language. Do not translate."* docs/27 N7 confirms the flow:
 * `MediaRecorder -> audio evidence -> Gemini transcription`.
 *
 * So transcription is a **by-product of the triage call**, not a stage before it.
 * Phase 4 already built this: `services/ai/prompts.ts` has the `## AUDIO` section,
 * `services/ai/rules.ts` reads `output.audio_transcript`, and
 * `services/ai/schema.ts` validates it.
 *
 * brief §3 anticipates exactly this and provides the escape hatch:
 *
 * > "The voice should be converted into text before being used as the primary AI
 * > input **unless the project's Gemini architecture explicitly supports direct
 * > audio analysis**."
 *
 * It does. docs/09 is that architecture. So:
 *
 * | Design | Rejected because |
 * | --- | --- |
 * | A dedicated STT call before triage | A second Gemini implementation (brief §21), a second prompt to keep in sync, a second failure mode, and a second quota cost — to compute a field the triage call already returns. |
 * | A third-party STT (Whisper, Deepgram, AssemblyAI) | brief §18: "do NOT invent an expensive service." No such provider is configured, and adding one is a budget decision that is not this phase's to make. |
 * | An on-device `SpeechRecognition` API | Chrome-only, sends audio to Google servers from the browser, non-deterministic, and would be a SECOND source of truth that can disagree with the transcript Gemini reports. |
 *
 * ---------------------------------------------------------------------------
 * SO WHAT IS THIS FILE?
 * ---------------------------------------------------------------------------
 * The thing that actually needs abstracting is not the model call — it is the
 * **translation of a triage outcome into an honest user-facing transcript
 * state**, which has four genuinely distinct outcomes that are easy to conflate:
 *
 * | `status` | Means | What the citizen is told |
 * | --- | --- | --- |
 * | `ready` | The model heard words and is confident | The transcript, editable |
 * | `uncertain` | The model heard something, with gaps | The transcript, badged as uncertain |
 * | `none` | Audio WAS attached, and the model could not make it out | "I could not make out your recording" |
 * | `unavailable` | No AI provider is configured, so nothing transcribed anything | "Voice transcription is currently unavailable" |
 *
 * Conflating `none` and `unavailable` is the bug this file exists to prevent. The
 * first says *your recording was too quiet or garbled* — the citizen's problem,
 * fixable by speaking again. The second says *our provider is not configured* —
 * nobody's problem, fixable only by typing. Telling a citizen to "speak up" when
 * the real cause is a missing API key sends them round in circles during an
 * emergency, and sending them to a support page when their recording was simply
 * unintelligible is equally wrong.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PROVIDER AUTHOR MAY DO
 * ---------------------------------------------------------------------------
 * `SpeechToTextService` has exactly two methods and neither one generates
 * anything. This mirrors the `TriageProvider` discipline from Phase 4, where the
 * repair call was deliberately kept OUT of the interface so a provider author
 * could not run arbitrary generations. A future Phase 6 that adds a real STT
 * provider swaps `fromTriageOutcome` for `transcribe` and changes nothing else.
 */

import 'server-only';

import { geminiConfig } from '@/lib/env.server';

/* ========================================================================== */
/* The result                                                                   */
/* ========================================================================== */

/**
 * The four states. Deliberately a union of string literals rather than two
 * booleans, because `text === null && uncertain === true` is a state a boolean
 * pair can express and a reader cannot immediately interpret.
 */
export type TranscriptStatus =
  /** The model transcribed and did not flag uncertainty. */
  | 'ready'
  /** The model transcribed, and flagged gaps or ambiguity. */
  | 'uncertain'
  /** Audio was attached and the model could not make it out. */
  | 'none'
  /** No provider produced a transcript. Nothing was even attempted. */
  | 'unavailable';

export type Transcript = {
  readonly status: TranscriptStatus;
  /**
   * The transcript, or `null`.
   *
   * `null` is the honest value for three of the four states, and the UI renders
   * nothing rather than a placeholder. A component that displays
   * "[transcription pending]" as though it were a transcript is exactly the
   * "do not pretend transcription occurred" failure brief §18 warns about.
   */
  readonly text: string | null;
  /** The model's own `audio_transcript_uncertain` flag. Never inferred. */
  readonly uncertain: boolean;
  /** Which implementation answered. For the audit trail, not for the citizen. */
  readonly providerName: string;
  /**
   * The one sentence to show when `text` is `null`.
   *
   * `null` when there is nothing to say — which is the case for `ready` and
   * `uncertain`, where the transcript itself is the content. A `notice` that
   * duplicates the transcript is a notice nobody reads.
   */
  readonly notice: string | null;
  /**
   * Whether the user should be offered a text box.
   *
   * `true` for every state. brief §33: "The user must always have a fallback:
   * Continue with text where appropriate." For `none` and `unavailable` it is the
   * ONLY way forward, so it is not a fallback — it is the primary path.
   */
  readonly canTypeInstead: true;
};

/* ========================================================================== */
/* The copy — one place, so the two providers cannot disagree                  */
/* ========================================================================== */

/**
 * The citizen-facing sentences, verbatim from brief §18 and §33.
 *
 * Held as constants rather than written into the components because the two
 * states a citizen most needs to tell apart are exactly the two whose copy is
 * easy to get wrong, and a component that writes its own string is a component
 * that will eventually use the wrong one of the two.
 */
export const TRANSCRIPT_COPY = {
  /** brief §18, verbatim. */
  unavailable:
    'Voice transcription is currently unavailable. Please type your emergency description.',
  /**
   * Not from the brief — the brief does not cover this state, which is itself
   * worth noting. Audio attached, provider working, model could not read it.
   *
   * The wording is chosen to NOT blame the citizen: "could not make out" is about
   * the audio, whereas "your recording was too quiet" is an accusation during an
   * emergency. The second sentence keeps the exit obvious.
   */
  none: 'I could not make out your recording. Please type what happened, or record it again.',
  /** Shown beside a transcript the model flagged. Not a replacement for it. */
  uncertainBadge: 'Some words may be wrong',
  /** The heading above an editable transcript. */
  reviewTitle: 'Voice report transcribed',
} as const;

/* ========================================================================== */
/* The seam                                                                     */
/* ========================================================================== */

/**
 * The interface brief §18 asks for.
 *
 * Two methods, neither of which can generate. A provider is a *translator of
 * outcomes*, not a source of them — which is what keeps this file from becoming
 * a second AI integration by accident.
 */
export type SpeechToTextService = {
  /** A stable name for the audit log. `gemini-transcript` / `unavailable`. */
  readonly name: string;
  /** Can this implementation produce a transcript at all, right now? */
  isAvailable(): boolean;
  /**
   * Turn a triage outcome into a transcript state.
   *
   * `audioAttached` is passed separately because the outcome's own
   * `audioCount` is clamped to 1 and can be 0 in a path where audio WAS attached
   * but was dropped before the provider saw it — and "dropped" and "not
   * attached" are different facts that a citizen should hear differently.
   */
  fromTriageOutcome(outcome: TriageOutcomeLike, audioAttached: boolean): Transcript;
};

/**
 * The structural minimum this file needs from a triage outcome.
 *
 * Declared structurally rather than importing `TriageOutcome` so this service
 * has no import edge into `services/ai`, and therefore no way to accidentally
 * become a second entry point into the AI layer. Phase 4's outcome satisfies
 * this shape; a test asserts that it still does.
 */
export type TriageOutcomeLike = {
  readonly audioTranscript: string | null;
  readonly audioTranscriptUncertain: boolean;
  readonly audioCount: number;
  readonly source: string;
  readonly providerName: string;
};

/* ========================================================================== */
/* Implementation 1: the transcript Gemini already returned                    */
/* ========================================================================== */

/**
 * docs/09's architecture, read back out of the triage result.
 *
 * This provider is **honest in a way that a fake one could not be**: it does not
 * transcribe anything. It reports what a real model call returned. If the key is
 * absent, the offline fallback engine ran, and the offline engine sets
 * `audioTranscript: null` (services/ai/fallback.ts) — so this provider reports
 * `unavailable` and says so, rather than inventing a sentence.
 */
export const geminiTranscriptService: SpeechToTextService = {
  name: 'gemini-transcript',

  isAvailable(): boolean {
    // The flag that decides whether audio is sent at all, docs/09 §13. If it is
    // off, no audio reached the model, so asking this provider for a transcript
    // would be asking about something that was never sent.
    return geminiConfig().audioEnabled;
  },

  fromTriageOutcome(outcome, audioAttached): Transcript {
    if (!this.isAvailable()) {
      return {
        status: 'unavailable',
        text: null,
        uncertain: false,
        providerName: this.name,
        notice: TRANSCRIPT_COPY.unavailable,
        canTypeInstead: true,
      };
    }

    const text = outcome.audioTranscript;
    if (text !== null && text.trim().length > 0) {
      return {
        // The model's own flag, never inferred from the text. A transcript that
        // happens to contain the literal string "[inaudible]" is not thereby
        // flagged — docs/09's example 2 shows the model marking gaps AND setting
        // the flag, and only the flag is authoritative.
        status: outcome.audioTranscriptUncertain ? 'uncertain' : 'ready',
        text,
        uncertain: outcome.audioTranscriptUncertain,
        providerName: this.name,
        notice: null,
        canTypeInstead: true,
      };
    }

    if (audioAttached) {
      // Audio reached the provider and produced no words. The citizen's problem,
      // and the copy says so without blaming them.
      return {
        status: 'none',
        text: null,
        uncertain: false,
        providerName: this.name,
        notice: TRANSCRIPT_COPY.none,
        canTypeInstead: true,
      };
    }

    // No audio, and none transcribed. Nothing is wrong and nothing to say — a
    // citizen who typed a report is not told transcription failed.
    return {
      status: 'ready',
      text: null,
      uncertain: false,
      providerName: this.name,
      notice: null,
      canTypeInstead: true,
    };
  },
};

/* ========================================================================== */
/* Implementation 2: no provider                                              */
/* ========================================================================== */

/**
 * The state of a deployment with no Gemini key.
 *
 * Exists as a real object rather than a `if (!configured) return {...}` branch
 * inside the first implementation, for the same reason `services/integrations/gemini`
 * has three providers: a branch is not a seam. Nothing in the codebase can tell
 * which implementation it is talking to, so a Phase 6 provider is a swap, not a
 * refactor.
 */
export const unavailableTranscriptService: SpeechToTextService = {
  name: 'unavailable',

  isAvailable(): boolean {
    return false;
  },

  fromTriageOutcome(_outcome, _audioAttached): Transcript {
    return {
      status: 'unavailable',
      text: null,
      // `false`, not `true`. Nothing was attempted, so nothing is uncertain.
      // Reporting uncertainty here would tell a citizen their words are possibly
      // wrong when no one has heard them.
      uncertain: false,
      providerName: this.name,
      notice: TRANSCRIPT_COPY.unavailable,
      canTypeInstead: true,
    };
  },
};

/* ========================================================================== */
/* Selection                                                                    */
/* ========================================================================== */

/**
 * The implementation to use.
 *
 * The condition is `GEMINI_AUDIO_ENABLED` alone, deliberately NOT a check for a
 * configured key. Those two disagree in one state — a deployment with the flag
 * on and no key — and this service resolves it correctly: the offline fallback
 * ran, produced `audioTranscript: null`, and `fromTriageOutcome` answers
 * `unavailable` with the right sentence. Selecting `unavailableTranscriptService`
 * on a missing key would produce the same user-visible result by a different
 * route, which is a second way to be right and therefore a second way to be
 * wrong later.
 */
export function getSpeechToTextService(): SpeechToTextService {
  return geminiConfig().audioEnabled ? geminiTranscriptService : unavailableTranscriptService;
}

/* ========================================================================== */
/* The convenience entry point                                                  */
/* ========================================================================== */

/**
 * What the report form calls. One function, so a component never has to know that
 * there are two implementations.
 */
export function transcriptFor(
  outcome: TriageOutcomeLike,
  audioAttached: boolean,
): Transcript {
  return getSpeechToTextService().fromTriageOutcome(outcome, audioAttached);
}

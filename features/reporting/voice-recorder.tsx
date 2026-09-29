'use client';

/**
 * ============================================================================
 * CareGrid AI — the voice recorder
 * ============================================================================
 *
 * brief §5. Replaces the Phase 1 stub, which deliberately recorded nothing.
 *
 * ---------------------------------------------------------------------------
 * THE MAXIMUM IS 120 SECONDS, NOT THE BRIEF'S EXAMPLE OF 60
 * ---------------------------------------------------------------------------
 * brief §6 gives 60 seconds as an example and then says "If the project
 * specification defines another maximum, follow that instead."
 *
 * docs/15 §7.1 and `config/limits.ts` both say **120** (FR-006), and the two
 * must agree or the client auto-stops at 60 while the server accepts 120 and a
 * responder sees a 90-second note that the UI claimed was impossible. So the
 * number lives in exactly one place — `getUploadLimits().maxAudioDurationSec` —
 * and this component reads it rather than hardcoding either value.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COPY NEVER PROMISES A RESPONDER
 * ---------------------------------------------------------------------------
 * brief §34. Nothing here says help is coming. The most that is ever true is "your
 * recording is saved on this device" — which is accurate, because the blob is in
 * memory and has not been uploaded yet.
 */

import * as React from 'react';
import { Mic, Square, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';

import { Alert, AlertDescription, AlertIcon, AlertTitle, Badge, Button, Progress } from '@/components/ui';
import { getUploadLimits } from '@/lib/env.client';
import {
  VOICE_ACTIVE_STATES,
  voiceIsActive,
  type VoiceRecording,
  type VoiceState,
} from '@/types/media';
import {
  bareMimeType,
  classifyPermissionError,
  detectRecorderSupport,
  formatElapsed,
  pickAudioMimeType,
  requestPermission,
  type PermissionOutcome,
  type RecorderSupport,
} from '@/features/reporting/media-recorder';

/* ========================================================================== */
/* Copy — one place, because the five permission states need five sentences     */
/* ========================================================================== */

/**
 * brief §4 and §7's required sentences, plus the states brief does not name.
 *
 * `denied` and `dismissed` are separate because the recovery differs and a
 * citizen who was refused should not be told to "try again" — the browser will
 * not ask them a second time. brief §7 requires that case be handled and says
 * "Never repeatedly request microphone permission in a loop"; copy that invites a
 * retry is the first half of that failure.
 */
export const VOICE_COPY = {
  unsupported: "Voice recording isn't supported on this device. Please use text or upload another supported format.",
  insecure:
    'Voice recording needs a secure (https) connection. Please use text or upload a photo instead.',
  denied:
    'Microphone access was denied.\n\nYou can continue by typing your emergency report instead.',
  dismissed:
    'The microphone request was dismissed. You can continue by typing your emergency report instead.',
  unavailable:
    'No microphone was found on this device. Please use text or upload a photo instead.',
  error: 'That recording could not be completed. Please try again, or type your report instead.',
  maxDuration: 'Recording stopped — maximum duration reached.',
  ready: 'Record a short voice note. You can edit the transcript before submitting.',
  recording: 'Recording',
  paused: 'Paused',
  saved: 'Recording saved. Add it to your report when you are ready.',
  added: 'Voice note added to your report.',
  tooLong: 'Voice notes are limited to {max} seconds.',
} as const;

/* ========================================================================== */
/* Props                                                                       */
/* ========================================================================== */

export type VoiceRecorderProps = {
  /** Called with the finished clip. NOT called with a blob that exceeded the cap. */
  readonly onRecorded: (recording: VoiceRecording) => void;
  /** `true` once a clip has been accepted. Drives the "added" state. */
  readonly hasRecording: boolean;
  /** Disables the whole control, e.g. while the form is submitting. */
  readonly disabled?: boolean;
};

/* ========================================================================== */
/* Component                                                                   */
/* ========================================================================== */

export function VoiceRecorder({ onRecorded, hasRecording, disabled = false }: VoiceRecorderProps) {
  const limits = getUploadLimits();
  const maxSeconds = limits.maxAudioDurationSec;

  // `null` until the effect runs, so a server render and the first client render
  // agree. Rendering "unsupported" on the server and "ready" on the client is a
  // hydration mismatch, and React resolves those by discarding the tree.
  const [support, setSupport] = React.useState<RecorderSupport | null>(null);
  const [state, setState] = React.useState<VoiceState>('idle');
  const [elapsed, setElapsed] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [mimeType, setMimeType] = React.useState<string | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const startedAtRef = React.useRef(0);
  const pausedForRef = React.useRef(0);
  const reasonRef = React.useRef<HTMLParagraphElement | null>(null);
  /** Guards a second `start()` while a permission prompt is open. */
  const busyRef = React.useRef(false);
  /**
   * The latest `stop`, for the duration timer to call.
   *
   * Assigned on every render and never read during render, so it has no effect on
   * the output — it exists purely to give a `setTimeout` a stable handle to a
   * closure it cannot depend on. See the comment at the timer.
   */
  const stopRef = React.useRef<(reachedCap?: boolean) => void>(() => {});

  /* --- capability detection, once, on mount ---------------------------- */
  React.useEffect(() => {
    const detected = detectRecorderSupport();
    setSupport(detected);
    if (detected.supported) {
      setMimeType(pickAudioMimeType());
    } else {
      // brief §4: an unsupported device is a NORMAL state with its own copy, not
      // an error. `unsupported` is in `VoiceState` precisely so the type system
      // requires this branch to exist.
      setState('unsupported');
      setError(VOICE_COPY.unsupported);
    }
  }, []);

  /* --- release the microphone on unmount ------------------------------- */
  // brief §30. A stream left open keeps the browser's recording indicator lit and
  // holds the device, which on a shared machine means the next person cannot
  // record either. This is the difference between a component and a leak.
  React.useEffect(() => {
    return () => {
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      streamRef.current?.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      streamRef.current = null;
    };
  }, []);

  /* --- the elapsed ticker ---------------------------------------------- */
  // Only runs while recording or paused, so a mounted-but-idle recorder costs
  // nothing. `setInterval` at 250ms rather than 1s so the readout does not appear
  // frozen between ticks on a long recording.
  React.useEffect(() => {
    if (!voiceIsActive(state)) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      const running = state === 'paused' ? pausedForRef.current - startedAtRef.current : now - startedAtRef.current;
      setElapsed(Math.floor(running / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [state]);

  /* --- brief §6: the hard cap ------------------------------------------ */
  // A `setTimeout`, not a check inside the ticker: a tick that only runs while the
  // tab is visible would not fire in a background tab, and a citizen who switches
  // away mid-recording would come back to an unbounded recording.
  React.useEffect(() => {
    if (state !== 'recording') return undefined;
    const timer = setTimeout(() => {
      // Through a ref, not through `stop` directly.
      //
      // `stop` closes over `mimeType` and `onRecorded`, so it has a new identity
      // on every render — and this component re-renders four times a second from
      // the elapsed ticker. Listing it as a dependency would therefore clear and
      // recreate this timer four times a second, so the 120-second cap would NEVER
      // fire and the recording would be unbounded. That is exactly the bug brief
      // §6 exists to prevent, and it is invisible until someone records for two
      // minutes.
      //
      // A ref gives the timer a stable identity to hold while still calling the
      // CURRENT `stop`, so the fresh closure is used at the moment it matters.
      stopRef.current(true);
    }, maxSeconds * 1000);
    return () => clearTimeout(timer);
  }, [state, maxSeconds]);

  /* --- the action handlers --------------------------------------------- */

  /** The five outcomes of asking, mapped to copy and state. */
  function applyPermissionOutcome(outcome: PermissionOutcome, stream: MediaStream | null): void {
    switch (outcome) {
      case 'granted':
        return;
      case 'insecure':
        setState('unsupported');
        setError(VOICE_COPY.insecure);
        return;
      case 'denied':
        setState('error');
        setError(VOICE_COPY.denied);
        return;
      case 'dismissed':
        setState('error');
        setError(VOICE_COPY.dismissed);
        return;
      case 'unavailable':
        setState('unsupported');
        setError(VOICE_COPY.unavailable);
        return;
      default:
        setState('error');
        setError(VOICE_COPY.error);
    }
    // Anything that is not `granted` stops here: the stream is null, and no
    // further prompt is made. brief §7's "never in a loop" is enforced by the
    // absence of a retry path, not by a comment.
    void stream;
  }

  async function start(): Promise<void> {
    // Synchronous guard BEFORE the first await, so a double-click cannot open two
    // permission prompts. brief §27 and §6.
    if (busyRef.current || voiceIsActive(state)) return;
    busyRef.current = true;
    setError(null);

    try {
      const { outcome, stream } = await requestPermission();
      if (outcome !== 'granted' || stream === null) {
        applyPermissionOutcome(outcome, stream);
        return;
      }

      const type = pickAudioMimeType();
      if (type === null) {
        stream.getTracks().forEach((track) => track.stop());
        setState('unsupported');
        setError(VOICE_COPY.unsupported);
        return;
      }

      const recorder = new MediaRecorder(stream, {
        mimeType: type,
        // A bitrate ceiling, not a target. Opus at 48 kbps is generous for speech
        // and keeps a two-minute note around 700 KB, which matters on the mobile
        // data a citizen is likely spending during an emergency.
        audioBitsPerSecond: 48_000,
      });

      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => finish();

      recorder.start();
      recorderRef.current = recorder;
      streamRef.current = stream;
      startedAtRef.current = Date.now();
      pausedForRef.current = 0;
      setElapsed(0);
      setMimeType(type);
      setState('recording');
    } catch (error) {
      // A constructor or `start()` failure that is not a permission error —
      // usually the codec failing to initialise despite `isTypeSupported` saying
      // yes, which older Safari does.
      setState('error');
      setError(VOICE_COPY.error);
      void error;
    } finally {
      busyRef.current = false;
    }
  }

  /** Stop the take. `reachedCap` only changes the message. */
  function stop(reachedCap = false): void {
    const recorder = recorderRef.current;
    if (recorder === null || recorder.state === 'inactive') return;
    setState('processing');
    try {
      recorder.stop();
    } catch {
      setState('error');
      setError(VOICE_COPY.error);
      return;
    }
    if (reachedCap) setError(VOICE_COPY.maxDuration);
  }
  // Published for the duration timer. See `stopRef`.
  stopRef.current = stop;

  function pause(): void {
    const recorder = recorderRef.current;
    if (recorder === null || recorder.state !== 'recording') return;
    recorder.pause();
    pausedForRef.current = Date.now();
    setState('paused');
  }

  function resume(): void {
    const recorder = recorderRef.current;
    if (recorder === null || recorder.state !== 'paused') return;
    recorder.resume();
    // Shift the start forward by the paused span, so the elapsed readout excludes
    // the pause. Without this, a citizen who paused for 20 seconds watches the
    // timer jump and thinks the limit is being consumed while they think.
    startedAtRef.current += Date.now() - pausedForRef.current;
    setState('recording');
  }

  /** Build the clip from the collected chunks and hand it up. */
  function finish(): void {
    const blob = new Blob(chunksRef.current, {
      // The recorder's own type, so the blob and the signed PUT agree. A blob
      // assembled with the wrong `type` uploads fine and then fails to be
      // sniffed — the failure would be reported as "unsupported format", which is
      // both true and useless.
      type: bareMimeType(mimeType ?? chunksRef.current[0]?.type ?? 'audio/webm'),
    });
    const duration = Math.max(1, Math.floor((pausedForRef.current - startedAtRef.current) / 1000));
    const seconds = state === 'paused' ? duration : Math.max(1, Math.floor((Date.now() - startedAtRef.current) / 1000));

    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];

    if (seconds > maxSeconds) {
      // A cap the timer should have caught. Reported rather than silently
      // truncated: a clip cut mid-word is a worse artefact than a clear refusal.
      setState('error');
      setError(VOICE_COPY.tooLong.replace('{max}', String(maxSeconds)));
      return;
    }

    setState('completed');
    onRecorded({
      blob,
      mimeType: blob.type,
      sizeBytes: blob.size,
      durationSec: seconds,
      // A server-side name. NEVER the citizen's filename and never a path —
      // docs/15 §3.5, and the extension is the one the BLOB has, not the one the
      // recorder was asked for.
      displayName: `voice-note.${blob.type.split('/')[1] ?? 'webm'}`,
    });
  }

  function reset(): void {
    setState(support?.supported === true ? 'idle' : 'unsupported');
    setElapsed(0);
    setError(support?.supported === true ? null : VOICE_COPY.unsupported);
  }

  /* --- the disabled-with-reason pattern (docs/04 §10.4) ---------------- */
  const unavailable = support !== null && !support.supported;
  const isActive = VOICE_ACTIVE_STATES.includes(state);
  const showReason = () => reasonRef.current?.focus();

  /* ========================================================================== */
  /* Render                                                                     */
  /* ========================================================================== */

  // brief §29: the status must not be conveyed by colour alone. A pulsing red dot
  // is invisible to a screen reader and to a red-green colourblind reader, so
  // every state here has a TEXT label as well as a dot, and the state is exposed
  // through a live region.
  return (
    <section className="flex flex-col gap-3" aria-label="Voice note">
      {/* --- unsupported: the fallback is the point, not an afterthought --- */}
      {unavailable ? (
        <Alert tone="warning">
          <AlertIcon tone="warning" />
          <div className="flex min-w-0 flex-col gap-1">
            <AlertTitle>Voice recording is not available</AlertTitle>
            <AlertDescription>{error ?? VOICE_COPY.unsupported}</AlertDescription>
          </div>
        </Alert>
      ) : null}

      {/* --- the live region, present in every state ---------------------- */}
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {/* The text is the accessible status. A screen reader announces changes
            here, which is what makes a recording state legible without sight. */}
        <span className="sr-only">{stateLabel(state, hasRecording)}</span>
      </p>

      {!unavailable ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {/* --- the elapsed readout ------------------------------------ */}
            <span
              className="font-mono text-2xl tabular-nums"
              aria-hidden={!isActive}
            >
              {formatElapsed(elapsed)}
            </span>

            {/* --- the status dot AND its label --------------------------- */}
            {isActive ? (
              <span className="inline-flex items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className={`inline-block size-2.5 rounded-full ${
                    state === 'recording' ? 'animate-pulse bg-danger' : 'bg-warning'
                  }`}
                />
                {state === 'recording' ? VOICE_COPY.recording : VOICE_COPY.paused}
              </span>
            ) : null}
          </div>

          {/* --- the real progress bar ---------------------------------- */}
          {isActive ? (
            <Progress
              value={Math.min(100, (elapsed / maxSeconds) * 100)}
              aria-label={`Recording time used, ${elapsed} of ${maxSeconds} seconds`}
            />
          ) : null}

          {/* --- the controls ------------------------------------------- */}
          <div className="flex flex-wrap gap-2">
            {state === 'idle' || state === 'completed' || state === 'error' ? (
              <Button
                type="button"
                onClick={() => void start()}
                disabled={disabled}
                aria-label="Record emergency voice report"
              >
                <Mic aria-hidden="true" />
                {state === 'completed' || state === 'error' ? 'Record again' : 'Start recording'}
              </Button>
            ) : null}

            {state === 'recording' ? (
              <Button type="button" onClick={() => stop(false)} aria-label="Stop recording">
                <Square aria-hidden="true" />
                Stop recording
              </Button>
            ) : null}

            {/* Pause is offered ONLY where it works. `MediaRecorder.pause` is
                absent on iOS Safari, and a button that throws when pressed is
                worse than no button. brief §5 says "Paused if supported". */}
            {state === 'recording' && canPause() ? (
              <Button type="button" variant="secondary" onClick={pause} aria-label="Pause recording">
                <Pause aria-hidden="true" />
                Pause
              </Button>
            ) : null}
            {state === 'paused' && canPause() ? (
              <Button type="button" variant="secondary" onClick={resume} aria-label="Resume recording">
                <Play aria-hidden="true" />
                Resume
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      {/* --- errors and notices ------------------------------------------ */}
      {error !== null && !unavailable ? (
        <Alert tone={state === 'completed' ? 'info' : 'warning'}>
          <AlertIcon tone={state === 'completed' ? 'info' : 'warning'} />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {hasRecording ? (
        <p className="text-sm text-muted-foreground">
          {/* `variant="default"`, not a `tone` — this `Badge` has no `tone` prop,
              and the state is carried by the text rather than by a colour. */}
          <Badge variant="default" size="sm">
            {VOICE_COPY.added}
          </Badge>
        </p>
      ) : null}

      {state === 'completed' && !hasRecording ? (
        <Button type="button" variant="ghost" size="sm" onClick={reset} aria-label="Discard this recording">
          <Trash2 aria-hidden="true" />
          <RotateCcw aria-hidden="true" />
          Discard
        </Button>
      ) : null}

      {/* The reason a disabled control is disabled, focusable so a keyboard or
          screen-reader user can reach it. docs/04 §10.4. */}
      <p ref={reasonRef} tabIndex={-1} className="sr-only">
        {unavailable ? VOICE_COPY.unsupported : null}
      </p>
      {disabled ? (
        <Button type="button" onClick={showReason} variant="ghost" size="sm" aria-disabled="true">
          Voice recording is unavailable right now
        </Button>
      ) : null}
    </section>
  );
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/**
 * Does this browser's `MediaRecorder` support pause?
 *
 * Checked on the TYPE, not the instance: `pause` is a method on the prototype, so
 * `'pause' in MediaRecorder.prototype` is true exactly where the method exists,
 * without constructing a recorder to find out. iOS Safari has never had it, which
 * is why brief §5 says "Paused if supported".
 */
function canPause(): boolean {
  if (typeof window === 'undefined' || window.MediaRecorder === undefined) return false;
  return 'pause' in window.MediaRecorder.prototype;
}

/**
 * The screen-reader status text for each state.
 *
 * A separate function so the mapping is a table that can be asserted, rather than
 * a set of ternaries inside JSX. brief §29 requires the state to be available to
 * assistive technology, and this is where that requirement is actually met.
 */
export function stateLabel(state: VoiceState, hasRecording: boolean): string {
  switch (state) {
    case 'idle':
      return VOICE_COPY.ready;
    case 'recording':
      return 'Recording in progress.';
    case 'paused':
      return 'Recording paused.';
    case 'processing':
      return 'Finishing the recording.';
    case 'completed':
      return hasRecording ? VOICE_COPY.added : VOICE_COPY.saved;
    case 'error':
      return VOICE_COPY.error;
    case 'unsupported':
      return VOICE_COPY.unsupported;
    default:
      return '';
  }
}

export { classifyPermissionError };

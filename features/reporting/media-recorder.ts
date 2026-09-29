/**
 * ============================================================================
 * CareGrid AI — microphone capability detection and format negotiation
 * ============================================================================
 *
 * brief §4, §7 and §8. All of it pure and synchronous, so it can be tested
 * without a DOM, and so the component is left containing only state and effects.
 *
 * ---------------------------------------------------------------------------
 * WHY CAPABILITY DETECTION IS A SEPARATE MODULE
 * ---------------------------------------------------------------------------
 * brief §4: "Do not assume every browser supports every audio API."
 *
 * The temptation is to write the checks inline in the component, and then every
 * branch of the UI becomes a place where a missing API throws. Putting them here
 * means:
 *
 *   1. **One answer per question**, so the button, the alert and the permission
 *      flow cannot disagree about whether recording is possible.
 *   2. **The negotiation is testable.** `MediaRecorder.isTypeSupported` is a pure
 *      function of a string, so the preferred-type list can be asserted against a
 *      fake without a browser.
 *   3. **"Unsupported" is a first-class answer**, not an absence. The component
 *      must render a specific sentence for a browser with no `MediaRecorder`, and
 *      a module that returns `null` for "no" cannot distinguish "no
 *      `MediaRecorder`" from "no `getUserMedia`" from "permission denied" — three
 *      states that need three different messages.
 */

/* ========================================================================== */
/* Support                                                                     */
/* ========================================================================== */

/** Why recording is not possible, when it is not. */
export type RecorderUnavailable =
  /** No `navigator.mediaDevices` at all. Non-secure context, or an old browser. */
  | 'NO_MEDIA_DEVICES'
  /** No `MediaRecorder`. Safari < 14.1 and some in-app browsers. */
  | 'NO_MEDIA_RECORDER'
  /** Every format we accept was refused. Effectively "no usable codec". */
  | 'NO_SUPPORTED_FORMAT';

export type RecorderSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: RecorderUnavailable };

/**
 * Can this browser record audio at all?
 *
 * ---------------------------------------------------------------------------
 * `window.isSecureContext` IS CHECKED, AND IT IS THE MOST COMMON CAUSE
 * ---------------------------------------------------------------------------
 * `getUserMedia` is gated on a secure context. `localhost` counts as secure, which
 * is why this works in development and then fails on a LAN IP — the single most
 * common report from testing voice features on a phone.
 *
 * It is checked here rather than left to a `getUserMedia` rejection because the
 * two produce DIFFERENT messages, and the accurate one saves a support ticket: a
 * non-secure context is a deployment problem, whereas a permission denial is the
 * user's choice and may well be changeable.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT CHECKED, AND WHY
 * ---------------------------------------------------------------------------
 * **No microphone is not detected here.** Whether a device has an input is only
 * knowable by asking `getUserMedia`, which is an async permission prompt. A
 * synchronous capability check that tried would either be a lie or a side effect
 * in a getter. So `NO_MICROPHONE` is a state the permission flow reaches, not one
 * this function reports — and the component handles both, from the same render.
 */
export function detectRecorderSupport(): RecorderSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    // Server render. The component renders the "check when ready" state and
    // re-evaluates on mount, so a missing `window` is not an error.
    return { supported: false, reason: 'NO_MEDIA_DEVICES' };
  }

  // A secure context is a precondition of `getUserMedia`. `NO_MEDIA_DEVICES` is
  // the right reason to report because the recovery advice is identical — the page
  // must be served over HTTPS — and the component's copy says so.
  if (window.isSecureContext === false) {
    return { supported: false, reason: 'NO_MEDIA_DEVICES' };
  }

  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    return { supported: false, reason: 'NO_MEDIA_DEVICES' };
  }

  if (typeof window.MediaRecorder === 'undefined') {
    return { supported: false, reason: 'NO_MEDIA_RECORDER' };
  }

  if (pickAudioMimeType() === null) {
    return { supported: false, reason: 'NO_SUPPORTED_FORMAT' };
  }

  return { supported: true };
}

/* ========================================================================== */
/* Format negotiation — brief §8                                                */
/* ========================================================================== */

/**
 * The formats we will record, in order of preference.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIST AND NOT A CONSTANT
 * ---------------------------------------------------------------------------
 * brief §8: "Detect the browser's supported MediaRecorder MIME type rather than
 * assuming one format. Do not hardcode a format that is guaranteed to fail on
 * some browsers."
 *
 * The order is deliberate:
 *
 * | Position | Format | Why here |
 * | --- | --- | --- |
 * | 1 | `audio/webm;codecs=opus` | Chrome, Edge, Firefox, Opera. Opus at a good bitrate for speech, and the smallest file for a 2-minute note. |
 * | 2 | `audio/webm` | An older Chromium without Opus. |
 * | 3 | `audio/mp4;codecs=mp4a.40.2` | **Safari 14.1+.** It is last because it is the only format that reaches iOS, and on iOS it is the *only* one — so putting it last costs nothing and putting it first would degrade everyone else. |
 * | 4 | `audio/mp4` | Safari without the explicit codec string. |
 * | 5 | `audio/mpeg` | Effectively never produced by `MediaRecorder`; present so a browser that reports it is honoured rather than refused. |
 *
 * All five are in `ALLOWED_MEDIA`, so whatever is negotiated is a type the server
 * will accept. **A format here that were not in the allow-list would produce a
 * recording the server refuses after the citizen had already spoken into it** —
 * the worst possible moment to discover a mismatch, and the reason the two lists
 * are cross-checked by a test rather than trusted to stay aligned.
 */
export const PREFERRED_AUDIO_TYPES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/mpeg',
];

/**
 * The first format this browser will actually record, or `null`.
 *
 * **The bare type is returned, not the negotiated string with its codec
 * parameters.** `MediaRecorder` is given the full string including `;codecs=opus`,
 * but the recorded blob's `type` may be the bare `audio/webm`, and the server
 * sniffs the container anyway. What the caller needs from this function is the
 * value to put in `contentType` when it asks for a signed URL — and that must be
 * one of the six in `ALLOWED_MEDIA`, or the sign request is refused.
 *
 * So a `;codecs=` suffix is stripped here, and a `Blob.type` that still carries one
 * is stripped by `bareMimeType` before it is used.
 */
export function pickAudioMimeType(): string | null {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return null;
  for (const candidate of PREFERRED_AUDIO_TYPES) {
    try {
      if (window.MediaRecorder.isTypeSupported(candidate)) return bareMimeType(candidate);
    } catch {
      // A browser that throws from `isTypeSupported` rather than returning false
      // is handled by moving on. One format failing must not stop the search —
      // this function's whole job is to find a working one.
      continue;
    }
  }
  return null;
}

/**
 * `audio/webm;codecs=opus` -> `audio/webm`.
 *
 * Needed because `Blob.type` echoes whatever the recorder was configured with on
 * some browsers and the bare type on others, and the signed PUT's `Content-Type`
 * must be byte-identical to what was signed. Sending `;codecs=opus` when the
 * signature covered `audio/webm` is a `403` with a message about signatures.
 */
export function bareMimeType(value: string): string {
  const semi = value.indexOf(';');
  const bare = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
  return bare;
}

/* ========================================================================== */
/* Permission — brief §7                                                        */
/* ========================================================================== */

/** The five permission outcomes brief §7 requires be handled distinctly. */
export type PermissionOutcome =
  /** The user said yes. */
  | 'granted'
  /** The user said no, or the browser blocked it. */
  | 'denied'
  /** The prompt was dismissed without an answer — a timeout, or a closed tab. */
  | 'dismissed'
  /** The browser is fine but the page is not secure. */
  | 'insecure'
  /** There is no microphone, or the OS refused to open it. */
  | 'unavailable';

export type PermissionResult = {
  readonly outcome: PermissionOutcome;
  /** Non-null only for `granted`. Callers must stop the tracks themselves. */
  readonly stream: MediaStream | null;
};

/**
 * Ask for the microphone, ONCE, and classify the answer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CALLED EXACTLY ONCE PER USER ACTION
 * ---------------------------------------------------------------------------
 * brief §7: "Never repeatedly request microphone permission in a loop."
 *
 * Browsers enforce a version of this from their side — after a dismissal, Chrome
 * stops showing the prompt and returns `NotAllowedError` immediately forever — so
 * a loop produces a stream of identical failures and a UI that flickers between
 * "requesting" and "denied" forever. The caller is responsible for not retrying
 * after a non-`granted` outcome, and `VoiceRecorder` does that by making
 * `requestPermission` reachable only from a user action.
 *
 * ---------------------------------------------------------------------------
 * WHY `NotAllowedError` AND `NotFoundError` ARE SEPARATE OUTCOMES
 * ---------------------------------------------------------------------------
 * They are the same `DOMException` name on some browsers and different on others,
 * and they mean genuinely different things to the person:
 *
 * - **`NotAllowedError`** is a POLICY refusal. The user said no, or the browser
 *   remembered a previous refusal. The copy must not imply they can simply try
 *   again, because they cannot — the browser will not ask twice.
 * - **`NotFoundError`** is a HARDWARE fact. There is no microphone. Retrying will
 *   never work, and telling someone to check their permissions sends them to fix
 *   something that is not broken.
 *
 * ### The one case worth over-riding
 *
 * `NotAllowedError` **on an insecure context** is NOT a policy refusal. The
 * permission was never asked for; the browser refused to ask. It is reported as
 * `insecure` because the fix is completely different — serve the page over HTTPS —
 * and a citizen told "you denied microphone access" when the page was simply
 * `http://192.168.1.5` has been told something false about their own actions.
 */
export async function requestPermission(): Promise<PermissionResult> {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { outcome: 'unavailable', stream: null };
  }
  if (window.isSecureContext === false) {
    return { outcome: 'insecure', stream: null };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Echo cancellation and noise suppression are ON by default in every
        // browser and are wanted for a voice note taken in a noisy street. They
        // are stated explicitly because a browser default that changes would
        // silently degrade the recording quality of an emergency report.
        echoCancellation: true,
        noiseSuppression: true,
      },
      // `video: false` sits at the TOP level, not inside `audio`. It belongs to
      // `MediaStreamConstraints`, not `MediaTrackConstraints`, and nesting it is
      // both a type error and a silently-ignored field, which would leave the
      // browser's own default in force. The default is already `false`, so this
      // states intent rather than changing behaviour: a report needs the
      // citizen's description, not their face, and asking for video would make the
      // permission prompt scarier for no benefit.
      video: false,
    });
    return { outcome: 'granted', stream };
  } catch (error) {
    return { outcome: classifyPermissionError(error), stream: null };
  }
}

/**
 * Map a `DOMException` to one of the five outcomes.
 *
 * Exported for its own test: the mapping is a table of browser-specific facts, and
 * a table of browser-specific facts is exactly the thing that should be asserted
 * directly rather than inferred from an integration test.
 */
export function classifyPermissionError(error: unknown): PermissionOutcome {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      // Safari's older name for the same thing. Treating it as anything else
      // would tell a Safari user they have no microphone.
      return 'denied';

    case 'SecurityError':
      // A policy refusal with no microphone question at all — an iframe without
      // `allow="microphone"`, or a permissions-policy block.
      return 'denied';

    case 'NotFoundError':
    case 'DevicesNotFoundError':
      // No input device. `unavailable`, and the copy must not mention permissions.
      return 'unavailable';

    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      // The constraints could not be met. Treated as unavailable rather than
      // denied: nothing about the user's choice is implicated.
      return 'unavailable';

    case 'AbortError':
      // The device was busy or the call was aborted. Closest to "dismissed".
      return 'dismissed';

    case 'NotReadableError':
    case 'TrackStartError':
      // The OS has the microphone open elsewhere. Unavailable.
      return 'unavailable';

    default:
      // An unrecognised error is `unavailable`, NOT `denied`. Attributing a
      // failure to the user's refusal when we do not know that is the accusation
      // this classification exists to avoid.
      return 'unavailable';
  }
}

/* ========================================================================== */
/* Elapsed time — brief §6                                                       */
/* ========================================================================== */

/**
 * `mm:ss`, for the elapsed readout.
 *
 * Beyond 60 seconds this becomes `mm:ss` with a growing `mm` — deliberately NOT
 * truncated at `59`. A readout that shows `00:00` for a two-minute recording
 * because it wrapped is worse than no readout.
 */
export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

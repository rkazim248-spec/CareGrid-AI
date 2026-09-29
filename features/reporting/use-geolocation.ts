'use client';

/**
 * ============================================================================
 * CareGrid AI — browser geolocation
 * ============================================================================
 *
 * `docs/12 §3`. The `useGeolocation` hook whose signature `docs/05 §6.10` fixes.
 *
 * ---------------------------------------------------------------------------
 * EXPLICIT ACTIVATION ONLY (FR-030) — the rule this hook exists to enforce
 * ---------------------------------------------------------------------------
 * `docs/12 §3.5` is blunt about the auto-prompt: an auto-prompt on load is
 * forbidden. And the reasoning is not politeness, it is measurement.
 *
 * A permission prompt fired on page load is dismissed reflexively by most people,
 * and **a browser remembers a refusal** — Chrome will not ask again for that
 * origin. So an auto-prompt converts a recoverable "the user said no this once"
 * into a permanent "the user can never say yes", and the fallback path becomes the
 * only path for every future session. This is very likely why testing on a phone
 * over a LAN IP produces a permanent denial: the page is not a secure context, the
 * browser reports that as a refusal, and the citizen can never undo it.
 *
 * So `request()` is the ONLY way to get a fix, it is reachable only from a user
 * action, and this hook never calls it on mount.
 *
 * ---------------------------------------------------------------------------
 * ONE-SHOT, NEVER `watchPosition` (docs/12 §3.6)
 * ---------------------------------------------------------------------------
 * A citizen filing a report needs a single coordinate. `watchPosition` would keep
 * the GPS chip awake, keep the browser's location indicator lit, and produce a
 * stream of coordinates a report does not want. It also means a citizen's device is
 * being tracked for as long as the page is open, which is a privacy cost for zero
 * benefit.
 *
 * (`docs/12 §3.1` notes the same `enableHighAccuracy` value is reused for a
 * responder's 60-second heartbeat. That is a different, deliberate use and is
 * Phase 7's concern.)
 */

import * as React from 'react';

import { clampLatitude, clampLongitude, isValidLatLng, type LatLng } from '@/lib/geo/distance';
import { gradeAccuracy, type AccuracyGrade } from '@/lib/geo/accuracy';

/* ========================================================================== */
/* The fixed options — docs/12 §3.1                                            */
/* ========================================================================== */

/**
 * The two numeric bounds, declared before the options object that uses them.
 *
 * As plain numbers rather than read back off `PositionOptions`: that type declares
 * `timeout` as `number | undefined`, so `GET_CURRENT_POSITION_OPTIONS.timeout` is
 * `number | undefined` and every use site needs a fallback for a value that is
 * never actually absent.
 *
 * Declared first because a `const` used before its declaration is a runtime
 * `ReferenceError` rather than a type error — which would only surface when a
 * citizen first asked for their location.
 */
export const GEOLOCATION_TIMEOUT_MS = 15_000;
export const GEOLOCATION_MAX_AGE_MS = 30_000;

/**
 * `docs/12 §3.1`, verbatim:
 *
 * ```ts
 * export const GET_CURRENT_POSITION_OPTIONS: PositionOptions = {
 *   enableHighAccuracy: true,
 *   timeout: 15_000,     // 15 s. Beyond this the user has already decided they
 *                        // are not going to answer the prompt
 *   maximumAge: 30_000,  // 30 s. A fix from the last 30 s is good enough and
 *                        // avoids waking the GPS chip
 * };
 * ```
 *
 * **`maximumAge: 30_000` is a battery/accuracy trade and is deliberate.** A fix is
 * not perishable over 30 seconds in a way that matters for finding a car crash, and
 * a cached fix returns instantly rather than making a citizen stand still waiting
 * for a satellite lock.
 *
 * **`timeout: 15_000` bounds the PROMPT, not the fix.** The browser prompt blocks
 * interaction for as long as the user takes, and 15 s is the longest a spinner is
 * acceptable on a phone during an emergency. Past that the user has almost
 * certainly dismissed it, and the code says so rather than waiting.
 */
export const GET_CURRENT_POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: GEOLOCATION_TIMEOUT_MS,
  maximumAge: GEOLOCATION_MAX_AGE_MS,
};

/* ========================================================================== */
/* States                                                                      */
/* ========================================================================== */

/**
 * The states, from `docs/12 §3.2` plus the two the document implies.
 *
 * `unsupported` and `insecure` are SEPARATE from `denied` because they are not the
 * user's decision and their fixes are completely different — see
 * `classifyGeolocationError`. Collapsing them tells someone they denied something
 * they were never asked for.
 */
export type GeolocationState =
  /** Nothing requested yet. The initial state, always. */
  | 'idle'
  /** The browser prompt is open. */
  | 'requesting'
  /** A fix arrived. */
  | 'granted'
  /** The user or a policy refused. */
  | 'denied'
  /** The prompt was dismissed without an answer. */
  | 'dismissed'
  /** No `geolocation` in this browser. */
  | 'unsupported'
  /** The page is not a secure context, so the API is unavailable. */
  | 'insecure'
  /** The request ran past `timeout`. */
  | 'timeout'
  /** A device or OS failure. */
  | 'unavailable';

/** A fix, as this product uses it. `docs/12 §2.3`'s `geo`, minus server fields. */
export type GeoFix = {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number;
  readonly accuracyGrade: AccuracyGrade;
  /** The browser's own timestamp, ms. The client clock, so advisory only. */
  readonly capturedAtMs: number;
};

export type Geolocation = {
  readonly state: GeolocationState;
  readonly fix: GeoFix | null;
  /** Safe to show a citizen. Never contains a coordinate or an SDK string. */
  readonly error: string | null;
  /** One-shot. Ignores a call while a request is already in flight. */
  readonly request: () => void;
  /** Clear the error and return to `idle`. Does NOT re-prompt. */
  readonly reset: () => void;
  /** `true` when another attempt could plausibly succeed. */
  readonly canRetry: boolean;
};

/* ========================================================================== */
/* Error classification                                                        */
/* ========================================================================== */

/** `GeolocationPositionError` codes, as numbers, so no DOM lib is needed. */
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;
const PERMISSION_DENIED = 1;

/**
 * Map a `GeolocationPositionError` to a state. `docs/12 §3.2`.
 *
 * The classification that matters most is about **not blaming the user for
 * something they did not do**:
 *
 * | `code` | Reported as | Because |
 * | --- | --- | --- |
 * | `PERMISSION_DENIED` on an **insecure context** | `insecure` | The user was never asked. Chrome reports a plain-HTTP origin as `PERMISSION_DENIED` rather than a distinct code. Telling someone "you denied location access" when the page was `http://192.168.1.5:3000` — exactly what happens when testing on a phone over the LAN — is a false statement about their own actions, and sends them to a settings screen where nothing is wrong. |
 * | `POSITION_UNAVAILABLE` | `unavailable` | A hardware or OS failure. Retrying rarely helps, and the copy must not mention permissions. |
 *
 * An **unrecognised** code maps to `unavailable`, never `denied`, for the same
 * reason: attributing a failure to a refusal we did not observe is an accusation.
 *
 * `isSecure` is a parameter rather than read from `window` so the classification is
 * testable and so the caller — which has already checked — is the single source of
 * the answer. Defaulted for direct callers.
 */
export function classifyGeolocationError(
  error: unknown,
  isSecure: boolean = typeof window !== 'undefined' && window.isSecureContext !== false,
): GeolocationState {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;

  if (code === PERMISSION_DENIED) return isSecure ? 'denied' : 'insecure';
  if (code === POSITION_UNAVAILABLE) return 'unavailable';
  if (code === TIMEOUT) return 'timeout';
  return 'unavailable';
}

/* ========================================================================== */
/* Copy — one place, because eight states need eight sentences                 */
/* ========================================================================== */

/**
 * `docs/12 §3.4`'s pre-permission explainer, and the per-state copy.
 *
 * **`explainer` is shown BEFORE the prompt.** `docs/12 §3.4` requires it, and
 * `docs/12 §3.5`'s reasoning is why a vague one wastes the one chance the browser
 * will give: it states the benefit to the responder — the actual reason — and
 * nothing else. No urgency theatre, no "people will die", no dark patterns. brief
 * §5 forbids manipulative permission messaging explicitly.
 *
 * **Every non-granted state offers a way forward.** brief §33: the report must
 * still work without location. Each sentence names the alternatives, because
 * "Location access was denied." with no next step is a dead end during an emergency.
 */
export const GEOLOCATION_COPY = {
  explainer:
    'Your location helps responders understand where the emergency was reported.',
  idle: 'Location is optional. You can add it, choose a point on the map, or continue without it.',
  requesting: 'Getting your location…',
  denied:
    'Location access was denied. You can choose a point on the map, or continue without location.',
  dismissed:
    'The location request was dismissed. You can try again, choose a point, or continue without it.',
  unsupported:
    'This browser cannot share your location. You can choose a point on the map, or continue without location.',
  insecure:
    'Location needs a secure (https) connection. You can choose a point on the map, or continue without location.',
  timeout:
    'Taking too long to find your location. You can try again, choose a point, or continue without it.',
  unavailable:
    'Your location could not be determined. You can choose a point on the map, or continue without location.',
} as const;

/** The copy for a state. One function, so no component picks the wrong sentence. */
export function geolocationCopy(state: GeolocationState): string {
  switch (state) {
    case 'idle':
      return GEOLOCATION_COPY.idle;
    case 'requesting':
      return GEOLOCATION_COPY.requesting;
    case 'granted':
      // No copy. A fix needs no explanation, and a banner saying "location added"
      // on a form the citizen is still filling in is noise.
      return '';
    case 'denied':
      return GEOLOCATION_COPY.denied;
    case 'dismissed':
      return GEOLOCATION_COPY.dismissed;
    case 'unsupported':
      return GEOLOCATION_COPY.unsupported;
    case 'insecure':
      return GEOLOCATION_COPY.insecure;
    case 'timeout':
      return GEOLOCATION_COPY.timeout;
    case 'unavailable':
      return GEOLOCATION_COPY.unavailable;
    default:
      return GEOLOCATION_COPY.unavailable;
  }
}

/* ========================================================================== */
/* The conversion — docs/12 §3.1                                               */
/* ========================================================================== */

/**
 * A `GeolocationPosition` to a `GeoFix`. `docs/12 §3.1`'s `toGeoFix`.
 *
 * **Clamped, not validated.** A device reporting `latitude: 91` is broken hardware,
 * and a clamped 90 is more useful to a citizen than a refused emergency report. A
 * *hostile* client does not come through here — it posts to the API, where
 * `validators/geo.ts` refuses it. The two paths have different adversaries and
 * therefore different right answers, which is why there are two functions rather
 * than one compromise.
 *
 * **`capturedAtMs` is the browser's timestamp, so it is advisory only.** A device
 * clock can be wrong by years. Nothing security-relevant reads it, and the server
 * stamps its own `capturedAt` (docs/12 GEO-1).
 *
 * Returns `null` rather than throwing: a position with no usable `coords` is an
 * expected state on a locked-down device, and a hook that threw would unmount the
 * report form.
 */
export function toGeoFix(position: GeolocationPosition | null | undefined): GeoFix | null {
  const coords = position?.coords;
  if (coords === undefined || coords === null) return null;

  const lat = clampLatitude(Number(coords.latitude));
  const lng = clampLongitude(Number(coords.longitude));
  // Belt and braces: a broken device could report a non-number, and a `GeoFix`
  // carrying a `NaN` coordinate would poison every downstream comparison — including
  // the duplicate check, where `NaN` distances silently fail every gate.
  if (!isValidLatLng({ lat, lng })) return null;

  const accuracyM = Math.max(0, Math.round(Number(coords.accuracy ?? 0)));
  return {
    lat,
    lng,
    accuracyM,
    accuracyGrade: gradeAccuracy(accuracyM),
    capturedAtMs: typeof position?.timestamp === 'number' ? position.timestamp : Date.now(),
  };
}

/* ========================================================================== */
/* The hook                                                                    */
/* ========================================================================== */

/**
 * `useGeolocation()` — the signature `docs/05 §6.10` fixes.
 *
 * **`options.timeoutMs` can only SHORTEN the browser timeout.** Clamped to
 * `docs/12 §3.1`'s 15 s ceiling, because a caller raising it to 60 s would leave a
 * citizen watching a spinner during an emergency with no way to tell whether it is
 * working.
 */
export function useGeolocation(options?: { timeoutMs?: number; maxAgeMs?: number }): Geolocation {
  const [state, setState] = React.useState<GeolocationState>('idle');
  const [fix, setFix] = React.useState<GeoFix | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /**
   * Guards a second concurrent request.
   *
   * A ref rather than the `state` value, because `state` is not updated until React
   * re-renders — two clicks in the same tick would both read the stale `'idle'` and
   * open two prompts. The same class of bug as Phase 5's `busyRef` in the recorder,
   * and the same reason it is a ref.
   */
  const inFlightRef = React.useRef(false);

  /**
   * Abandon an in-flight request when the component unmounts.
   *
   * `getCurrentPosition` has no abort, so this does not cancel the browser call —
   * what it prevents is the CALLBACK firing into a dead component. Without it, a
   * citizen who navigates away while the permission prompt is open gets a
   * `setState` on an unmounted hook, and React 18's warning is the mild outcome; the
   * fix is also called on every later fix, which is a citizen's location being
   * written to state nobody is reading.
   *
   * **This effect must never call `request()`.** `docs/12 §3.5` forbids an
   * auto-prompt, and an effect that did so would be indistinguishable from the bug
   * the rule exists to prevent. Security check #22 asserts it.
   */
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const request = React.useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    // --- capability, BEFORE any prompt ---------------------------------
    if (typeof navigator === 'undefined' || typeof navigator.geolocation === 'undefined') {
      inFlightRef.current = false;
      setState('unsupported');
      setError(geolocationCopy('unsupported'));
      return;
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      // Checked before calling `getCurrentPosition`, because the browser reports an
      // insecure context as `PERMISSION_DENIED` and the two need different copy.
      inFlightRef.current = false;
      setState('insecure');
      setError(geolocationCopy('insecure'));
      return;
    }

    setState('requesting');
    setError(null);

    const timeoutMs = Math.min(options?.timeoutMs ?? GEOLOCATION_TIMEOUT_MS, GEOLOCATION_TIMEOUT_MS);
    const maxAgeMs = options?.maxAgeMs ?? GEOLOCATION_MAX_AGE_MS;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        inFlightRef.current = false;
        // The component may be gone. See `mountedRef`.
        if (!mountedRef.current) return;
        const converted = toGeoFix(position);
        if (converted === null) {
          setState('unavailable');
          setError(geolocationCopy('unavailable'));
          return;
        }
        setFix(converted);
        setState('granted');
      },
      (positionError) => {
        inFlightRef.current = false;
        if (!mountedRef.current) return;
        const classified = classifyGeolocationError(positionError);
        setState(classified);
        setError(geolocationCopy(classified));
      },
      { ...GET_CURRENT_POSITION_OPTIONS, timeout: timeoutMs, maximumAge: maxAgeMs },
    );
  }, [options?.timeoutMs, options?.maxAgeMs]);

  const reset = React.useCallback(() => {
    // **Does not re-prompt.** `docs/12 §3.5`: a browser remembers a refusal, so
    // "try again" after a denial cannot work. Offering it sends the user to a
    // settings screen with no explanation of why.
    setState('idle');
    setError(null);
  }, []);

  /**
   * Is another attempt worth offering?
   *
   * `false` for `denied`, `insecure` and `unsupported` — the three states where
   * retrying is either impossible (the browser will not ask again) or pointless
   * (nothing about the device or the origin will change). `true` for `timeout` and
   * `unavailable`, which are transient, and for `dismissed`.
   */
  const canRetry =
    state === 'idle' || state === 'timeout' || state === 'unavailable' || state === 'dismissed';

  return { state, fix, error, request, reset, canRetry };
}

/* ========================================================================== */
/* Manual placement — docs/12 §4                                               */
/* ========================================================================== */

/**
 * The accuracy to STORE for a manual pin. `docs/12 §2.1`.
 *
 * "the map-declared radius, stored as `accuracyM` = the map-zoom-derived radius, min
 * 30 m".
 *
 * **Zoom-derived, because a pin dropped at zoom 3 asserts something far weaker than
 * one dropped at zoom 15**, and `docs/12 §4.3`'s dashed-pin honesty rule requires
 * the ring to say so. The 30 m floor stops a maximum-zoom pin claiming sub-metre
 * precision, which no consumer GPS achieves.
 */
export const MANUAL_PIN_MIN_ACCURACY_M = 30;

/**
 * Metres per pixel per zoom level at the equator. Google Maps' own approximation,
 * from their spherical Mercator documentation.
 *
 * Used to convert "the citizen dropped a pin at zoom Z" into a radius, which is what
 * turns a gesture into an honest accuracy number.
 */
const METRES_PER_PIXEL_BY_ZOOM: readonly number[] = [
  156_543.03, 78_271.52, 39_135.76, 19_567.88, 9_783.94, 4_891.97, 2_445.98,
  1_222.99, 611.5, 305.75, 152.87, 76.43, 38.22, 19.11, 9.55, 4.78, 2.39,
];

/**
 * The declared accuracy for a pin dropped at `zoom`, floored at 30 m.
 *
 * At zoom 17+ the table runs out, so the last entry is used — a pin at maximum zoom
 * still asserts no better than ~2.4 m/px, and the 30 m floor is what actually
 * applies there.
 *
 * A non-finite zoom falls back to 15, the ordinary "I am looking at my street"
 * level. `Math.max(30, NaN)` is `NaN`, and a `NaN` accuracy grades as `unknown` and
 * renders as "accuracy unavailable" for a pin the citizen placed deliberately.
 */
export function manualPinAccuracy(zoom: number): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : 15;
  const index = Math.round(Math.max(0, Math.min(safeZoom, METRES_PER_PIXEL_BY_ZOOM.length - 1)));
  const perPixel = METRES_PER_PIXEL_BY_ZOOM[index] as number;
  // 40 px: roughly the radius of a dropped pin's hit target. A citizen pointing at
  // a building is pointing within a few tens of metres of where they meant to.
  return Math.max(MANUAL_PIN_MIN_ACCURACY_M, Math.round(perPixel * 40));
}

/**
 * A manual pin, as the form holds it. `docs/12 §4.2`.
 *
 * **`pending` until the server reverse-geocodes.** `docs/12 §5` is explicit that
 * geocoding is server-side only (FR-035) — it needs the server key, and the browser
 * key must not be granted the Geocoding API. So the client holds the point and the
 * UI shows "locating…" until the server supplies a `placeName`.
 */
export type ManualPin = {
  readonly point: LatLng;
  readonly zoom: number;
  readonly accuracyM: number;
  /** `true` while the server geocode is outstanding. */
  readonly pending: boolean;
  readonly placeName: string | null;
};

/** `docs/12 §4.3`'s marker treatment. A dashed pin is a promise of approximation. */
export const PIN_TREATMENT = {
  /** `gps` at high or medium accuracy. */
  solid: 'solid',
  /** `gps` at low accuracy, and every `manual_pin`. */
  dashed: 'dashed',
  /** `geo == null`. `docs/12 §2.2` requires a visible flag, not a blank. */
  hatched: 'hatched',
} as const;

export type PinTreatment = (typeof PIN_TREATMENT)[keyof typeof PIN_TREATMENT];

/**
 * Which marker treatment a fix gets. `docs/12 §2.2` and §4.3.
 *
 * A shared function because three surfaces render this — the report form, the
 * incident detail panel and the map popup — and `docs/12 §2.2` requires them to
 * agree. `low` accuracy and a manual pin look the SAME, which is the point: both
 * are a human assertion rather than a fix.
 */
export function pinTreatmentFor(
  source: 'gps' | 'manual_pin' | 'address_text' | 'none',
  grade: AccuracyGrade,
): PinTreatment {
  if (source === 'none') return PIN_TREATMENT.hatched;
  if (source === 'manual_pin' || source === 'address_text') return PIN_TREATMENT.dashed;
  return grade === 'low' || grade === 'unknown' ? PIN_TREATMENT.dashed : PIN_TREATMENT.solid;
}
